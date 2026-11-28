(function(root){
  'use strict';
  const conflict=()=>Object.assign(new Error('长期记忆已更新，请刷新后重试'),{code:'MEMORY_CONFLICT'});
  function originKey(value){
    const u=new URL(value);
    if(!['http:','https:'].includes(u.protocol)||u.origin!==value)throw new Error('长期记忆网站源无效');
    return u.origin;
  }
  function validNote(id,text){
    if(typeof id!=='string'||! /^[a-zA-Z0-9_-]{1,60}$/.test(id)||typeof text!=='string'||!text.trim()||text.length>2000)throw new Error('长期记忆名称或内容无效（名称限英文数字、下划线和短横线；内容最多 2000 字符）');
  }
  function validSkill(id,description,text,sites=[]){
    if(typeof id!=='string'||! /^[a-zA-Z0-9_-]{1,60}$/.test(id)||typeof description!=='string'||!description.trim()||description.length>200||typeof text!=='string'||!text.trim()||text.length>4000)throw new Error('技能名称、适用说明或步骤无效（名称限英文数字、下划线和短横线；说明最多 200 字符；步骤最多 4000 字符）');
    if(!Array.isArray(sites)||sites.length>8)throw new Error('技能适用网站无效（最多 8 个）');
    for(const site of sites)originKey(site);
  }
  // Skills form one cross-site library; `sites` only ranks them, `from` records where the review wrote them.
  const SKILL_LIMITS={count:32,size:96000};
  const skillRecord=(n,from)=>({id:n.id,description:n.description,text:n.text,sites:Array.isArray(n.sites)?n.sites:from?[from]:[],from:n.from??from??null,source:n.source,createdAt:n.createdAt,updatedAt:n.updatedAt});
  // v5: merge the per-origin skill records of v4 into the library, newest first within the limits.
  function migrateSkills(tx){
    const request=tx.objectStore('skills').getAll();
    request.onsuccess=()=>{
      const all=[];for(const record of request.result||[])for(const n of record.notes||[])all.push(skillRecord(n,record.origin));
      all.sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
      const notes=[],ids=new Set();
      for(const n of all){
        let id=n.id;for(let i=2;ids.has(id);i++)id=(n.id.slice(0,55)+'_'+i);
        const next=notes.concat({...n,id});
        if(next.length>SKILL_LIMITS.count||JSON.stringify(next).length>SKILL_LIMITS.size)continue;
        notes.push({...n,id});ids.add(id);
      }
      tx.objectStore('skillLibrary').put({scope:'skills',version:notes.length?1:0,notes});
      tx.db.deleteObjectStore('skills');
    };
  }
  // One database serves site notes, global notes, site skills, conversation history and task images; every opener uses this upgrade.
  function openDatabase(factory,name,onClose){
    return new Promise((resolve,reject)=>{
      if(!factory){reject(new Error('浏览器不支持长期记忆数据库'));return;}
      const request=factory.open(name,6);let blocked=false;
      request.onupgradeneeded=()=>{
        const db=request.result;
        if(!db.objectStoreNames.contains('sites'))db.createObjectStore('sites',{keyPath:'origin'});
        if(!db.objectStoreNames.contains('global'))db.createObjectStore('global',{keyPath:'scope'});
        if(!db.objectStoreNames.contains('history'))db.createObjectStore('history',{keyPath:'taskId'}).createIndex('updatedAt','updatedAt');
        if(!db.objectStoreNames.contains('historyViews'))db.createObjectStore('historyViews',{keyPath:'taskId'});
        if(!db.objectStoreNames.contains('skillLibrary')){
          db.createObjectStore('skillLibrary',{keyPath:'scope'});
          if(db.objectStoreNames.contains('skills'))migrateSkills(request.transaction);
        }
        // v6: images attached to tasks (compressed in the side panel); task records keep only their ids.
        if(!db.objectStoreNames.contains('attachments'))db.createObjectStore('attachments',{keyPath:'id'});
      };
      request.onerror=()=>reject(new Error('无法打开长期记忆数据库'));
      request.onblocked=()=>{blocked=true;reject(new Error('长期记忆数据库被其他扩展页面占用，请关闭后重试'));};
      request.onsuccess=()=>{
        const db=request.result;if(blocked){db.close();return;}
        db.onversionchange=()=>{db.close();onClose?.();};
        resolve(db);
      };
    });
  }
  function createSiteMemory({factory=root.indexedDB,name='page-agent-memory',now=()=>Date.now(),scope='site'}={}){
    if(!['site','global','skill'].includes(scope))throw new Error('长期记忆范围无效');
    const storeName={site:'sites',global:'global',skill:'skillLibrary'}[scope],skill=scope==='skill';
    const limits=skill?{...SKILL_LIMITS,message:'技能容量已满（共 32 个 / 96000 字符），请先删除不用的技能'}:{count:32,size:64000,message:'长期记忆容量已满（每个范围 32 条 / 64000 字符），请先整理'};
    const key=value=>scope==='global'?'global':skill?'skills':originKey(value);
    const empty=value=>scope==='global'?{scope:'global',version:0,notes:[]}:skill?{scope:'skills',version:0,notes:[]}:{origin:value,version:0,notes:[]};
    let opening;
    function open(){
      if(!opening){
        const pending=openDatabase(factory,name,()=>{opening=null;});
        opening=pending;pending.catch(()=>{if(opening===pending)opening=null;});
      }
      return opening;
    }
    async function read(origin){
      origin=key(origin);const db=await open();
      return new Promise((resolve,reject)=>{
        const tx=db.transaction(storeName,'readonly'),request=tx.objectStore(storeName).get(origin);
        tx.oncomplete=()=>resolve(request.result||empty(origin));
        tx.onabort=()=>reject(new Error('读取长期记忆失败'));
        tx.onerror=()=>{};
      });
    }
    // Skills ignore the first argument; `from` is the origin the review ran on (null on browser pages).
    async function change(origin,{action,id,text,description,sites=[],from=null,expectedVersion,source='user',signal}={}){
      origin=key(origin);
      if(!['write','delete','clear'].includes(action)||!Number.isSafeInteger(expectedVersion)||expectedVersion<0)throw new Error('长期记忆操作无效');
      if(action==='write')skill?validSkill(id,description,text,sites):validNote(id,text);
      if(skill&&action==='write'){sites=[...new Set(sites.map(originKey))];from=typeof from==='string'&&/^https?:/.test(from)?originKey(from):null;}
      if(action==='delete')validNote(id,'delete');
      const db=await open();
      if(signal?.aborted)throw new Error('长期记忆操作已取消');
      return new Promise((resolve,reject)=>{
        const tx=db.transaction(storeName,'readwrite'),store=tx.objectStore(storeName);let saved,error;
        const abort=()=>{error=new Error('长期记忆操作已取消');try{tx.abort();}catch{}};
        signal?.addEventListener('abort',abort,{once:true});
        const clean=()=>signal?.removeEventListener('abort',abort);
        tx.oncomplete=()=>{clean();resolve(saved);};
        tx.onabort=()=>{clean();reject(error||new Error('保存长期记忆失败，原数据未修改'));};
        tx.onerror=()=>{};
        const request=store.get(origin);
        request.onsuccess=()=>{
          try{
            const current=request.result||empty(origin);
            if(current.version!==expectedVersion)throw conflict();
            let notes=current.notes.filter(n=>action==='clear'?false:n.id!==id);
            if(action==='write')notes.push({id,...(skill?{description:description.trim(),sites,from}:{}),text:text.trim(),source:source==='model'?'model':'user',createdAt:current.notes.find(n=>n.id===id)?.createdAt||now(),updatedAt:now()});
            if(notes.length>limits.count||JSON.stringify(notes).length>limits.size)throw new Error(limits.message);
            saved={...empty(origin),version:current.version+1,notes};store.put(saved);
          }catch(e){error=e;tx.abort();}
        };
      });
    }
    async function close(){if(opening){const db=await opening;db.close();opening=null;}}
    return {read,change,close};
  }
  // Task images: the side panel stores drafts (taskId null); submit claims them for one task; ending or
  // clearing the task deletes them; prune drops images of tasks that no longer run and stale drafts.
  const IMAGE_DATA=/^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+=*$/,IMAGE_ID=/^[A-Za-z0-9_-]{8,64}$/;
  const imageMeta=r=>({id:r.id,type:r.type,width:r.width,height:r.height,size:r.size});
  function createAttachmentStore({factory=root.indexedDB,name='page-agent-memory',now=()=>Date.now(),draftAge=86400000}={}){
    let opening;
    function open(){
      if(!opening){const pending=openDatabase(factory,name,()=>{opening=null;});opening=pending;pending.catch(()=>{if(opening===pending)opening=null;});}
      return opening;
    }
    // Every operation reads all records (a handful at most) and decides synchronously inside one transaction.
    async function run(mode,work){
      const db=await open();
      return new Promise((resolve,reject)=>{
        const tx=db.transaction('attachments',mode),store=tx.objectStore('attachments');let value,error;
        tx.oncomplete=()=>resolve(value);tx.onabort=()=>reject(error||new Error('图片存储失败，请重试'));tx.onerror=()=>{};
        const request=store.getAll();
        request.onsuccess=()=>{try{value=work(request.result||[],store);}catch(e){error=e;try{tx.abort();}catch{}}};
      });
    }
    async function put({id,data,type,width,height,size}){
      if(typeof id!=='string'||!IMAGE_ID.test(id)||typeof data!=='string'||data.length>4000000||!IMAGE_DATA.test(data)||![width,height,size].every(n=>Number.isSafeInteger(n)&&n>0))throw new Error('图片数据无效');
      return run('readwrite',(all,store)=>{
        if(all.filter(r=>!r.taskId).length>=16)throw new Error('待发送图片过多，请先发送或移除');
        const record={id,taskId:null,createdAt:now(),data,type:data.slice(5,data.indexOf(';')),width,height,size};store.put(record);return imageMeta(record);
      });
    }
    async function get(ids){const wanted=new Set(ids);return run('readonly',all=>all.filter(r=>wanted.has(r.id)).sort((a,b)=>ids.indexOf(a.id)-ids.indexOf(b.id)));}
    // Binds drafts to a task; an id that is missing or owned by another task fails the whole claim.
    async function claim(ids,taskId){
      return run('readwrite',(all,store)=>ids.map(id=>{
        const record=all.find(r=>r.id===id);
        if(!record||record.taskId&&record.taskId!==taskId)throw new Error('图片已失效，请重新添加');
        store.put({...record,taskId,claimedAt:now()});return imageMeta(record);
      }));
    }
    async function discard(id){return run('readwrite',(all,store)=>{const record=all.find(r=>r.id===id&&!r.taskId);if(record)store.delete(id);return !!record;});}
    async function removeTask(taskId){return run('readwrite',(all,store)=>{const gone=all.filter(r=>r.taskId===taskId);for(const r of gone)store.delete(r.id);return gone.length;});}
    async function prune(liveTaskIds){
      const live=new Set(liveTaskIds),time=now();
      // A claim younger than a minute may belong to a task that is still being saved.
      return run('readwrite',(all,store)=>{const gone=all.filter(r=>r.taskId?!live.has(r.taskId)&&time-(r.claimedAt||0)>60000:time-(r.createdAt||0)>draftAge);for(const r of gone)store.delete(r.id);return gone.length;});
    }
    async function close(){if(opening){const db=await opening;db.close();opening=null;}}
    return {put,get,claim,discard,removeTask,prune,close};
  }
  const api={createSiteMemory,createAttachmentStore,openDatabase,validNote,validSkill,originKey};root.PageAgentSiteMemory=api;
  if(typeof module!=='undefined')module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
