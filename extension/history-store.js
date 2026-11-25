(function(root){
  'use strict';
  const HIDDEN='已隐藏';
  const TERMINAL=new Set(['completed','ended','stopped','failed','interrupted']);
  // Fields needed to show a finished conversation read-only; tokens, checkpoints, archives and approvals stay out.
  const KEEP=['taskId','goal','instructions','status','reason','origin','initialOrigin','allowedOrigins','steps','prefs','metrics','events','results','contextSummary','contextUsage','lastOutcome','goalMode','sensitiveAccess','updatedAt'];
  const memory=()=>typeof module!=='undefined'?require('./site-memory.js'):root.PageAgentSiteMemory;
  function redact(view){
    const secrets=new Set();
    const results=(view.results||[]).map(entry=>{
      if(!entry?.sensitive)return entry;
      if(typeof entry.request?.value==='string'&&entry.request.value)secrets.add(entry.request.value);
      return {action:entry.action,label:entry.label,time:entry.time,origin:entry.origin,tabRef:entry.tabRef,sensitive:true,
        request:entry.request?{action:entry.request.action,reply:entry.request.reply,...(entry.request.value!==undefined?{value:HIDDEN}:{})}:undefined,
        result:HIDDEN,outcome:entry.outcome?{status:entry.outcome.status,dispatch:entry.outcome.dispatch,code:entry.outcome.code,message:HIDDEN}:undefined};
    });
    // Very short values would blank unrelated text; their structured fields are already hidden above.
    const list=[...secrets].filter(value=>value.length>=3).sort((a,b)=>b.length-a.length);
    const scrub=value=>{
      if(typeof value==='string'){let out=value;for(const secret of list)out=out.split(secret).join(HIDDEN);return out;}
      if(Array.isArray(value))return value.map(scrub);
      if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,scrub(v)]));
      return value;
    };
    return scrub({...view,results});
  }
  function snapshot(task,maxChars=400000){
    const picked=Object.fromEntries(KEEP.filter(name=>task[name]!==undefined).map(name=>[name,structuredClone(task[name])]));
    const view={...redact(picked),archived:true};
    // Oversized conversations keep their newest records; the goal and summary always survive.
    while(JSON.stringify(view).length>maxChars&&((view.results||[]).length||(view.events||[]).length>1)){
      if(view.results?.length)view.results=view.results.slice(Math.max(1,Math.floor(view.results.length/10)));
      else view.events=view.events.slice(Math.max(1,Math.floor(view.events.length/10)));
      view.truncated=true;
    }
    return view;
  }
  function summaryOf(view){
    return {taskId:view.taskId,goal:typeof view.goal==='string'?view.goal.slice(0,300):'',status:view.status,origin:view.initialOrigin||view.origin||'browser',origins:(view.allowedOrigins||[]).slice(0,16),updatedAt:Number.isFinite(view.updatedAt)?view.updatedAt:0};
  }
  function createHistoryStore({factory=root.indexedDB,name='page-agent-memory',limit=50,maxChars=400000}={}){
    let opening;
    function open(){
      if(!opening){const pending=memory().openDatabase(factory,name,()=>{opening=null;});opening=pending;pending.catch(()=>{if(opening===pending)opening=null;});}
      return opening;
    }
    async function run(mode,work){
      const db=await open();
      return new Promise((resolve,reject)=>{
        const tx=db.transaction(['history','historyViews'],mode);let value;
        tx.oncomplete=()=>resolve(value);tx.onabort=()=>reject(new Error('历史记录读写失败'));tx.onerror=()=>{};
        work(tx.objectStore('history'),tx.objectStore('historyViews'),result=>{value=result;});
      });
    }
    async function save(task){
      if(!task||typeof task.taskId!=='string')return null;
      const view=snapshot(task,maxChars),summary=summaryOf(view);
      return run('readwrite',(index,views,done)=>{
        index.put(summary);views.put(view);
        const keys=index.index('updatedAt').getAllKeys();
        keys.onsuccess=()=>{const extra=keys.result.filter(id=>id!==summary.taskId);for(const id of extra.slice(0,Math.max(0,keys.result.length-limit))){index.delete(id);views.delete(id);}done(summary);};
      });
    }
    async function list(){
      return run('readonly',(index,views,done)=>{const request=index.getAll();request.onsuccess=()=>done(request.result.sort((a,b)=>b.updatedAt-a.updatedAt));});
    }
    async function get(taskId){
      return run('readonly',(index,views,done)=>{const request=views.get(taskId);request.onsuccess=()=>done(request.result||null);});
    }
    async function remove(taskId){return run('readwrite',(index,views,done)=>{index.delete(taskId);views.delete(taskId);done(true);});}
    // After a browser restart session tasks are gone and cannot resume; their saved copies become read-only "interrupted".
    async function interrupt(liveTaskIds){
      return run('readwrite',(index,views,done)=>{
        const request=index.getAll();let count=0;
        request.onsuccess=()=>{
          for(const summary of request.result){
            if(TERMINAL.has(summary.status)||liveTaskIds.has(summary.taskId))continue;
            count++;index.put({...summary,status:'interrupted'});
            const read=views.get(summary.taskId);read.onsuccess=()=>{if(read.result)views.put({...read.result,status:'interrupted',reason:'browser_restarted'});};
          }
          done(count);
        };
      });
    }
    async function close(){if(opening){const db=await opening;db.close();opening=null;}}
    return {save,list,get,remove,interrupt,close};
  }
  const api={createHistoryStore,snapshot,redact,HIDDEN};root.PageAgentHistoryStore=api;
  if(typeof module!=='undefined')module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
