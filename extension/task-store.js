(function(root){
  'use strict';
  const taskStoreWrites=new WeakMap();
  function createTaskStore(chrome) {
    const area=chrome.storage.session;
    const key=id=>'task:'+id;
    const rootKey=id=>'taskRoot:'+id;
    const originKey=(id,taskId,origin)=>'conversation-origin:'+id+':'+taskId+':'+encodeURIComponent(origin);
    const serial=fn=>{const operation=(taskStoreWrites.get(area)||Promise.resolve()).catch(()=>{}).then(fn);taskStoreWrites.set(area,operation);return operation;};
    const readRegistry=async()=>{const value=(await area.get('taskRegistry')).taskRegistry;return value||{version:1,revision:0,bindings:{}};};
    const scopeError=()=>Object.assign(new Error('任务归属记录未完成，请重新加载扩展以只读核对'),{code:'TASK_SCOPE_INCONSISTENT'});
    async function get(id){
      const registry=await readRegistry();if(registry.pending?.tabId===id)throw scopeError();
      const binding=registry.bindings[id];if(!binding)return (await area.get(key(id)))[key(id)]||null;
      const task=(await area.get(rootKey(binding.taskId)))[rootKey(binding.taskId)];
      if(!task||task.taskId!==binding.taskId||task.tabId!==id||task.scopeRevision!==binding.revision)throw scopeError();
      return task;
    }
    async function finishMemberClose(registry){
      const intent=registry.pending,id=intent.tabId,binding=registry.bindings[id];
      if(!binding||binding.taskId!==intent.binding.taskId||binding.revision!==intent.binding.revision)throw scopeError();
      const task=(await area.get(rootKey(binding.taskId)))[rootKey(binding.taskId)];
      if(!task||task.taskId!==binding.taskId||task.scopeRevision!==binding.revision||task.tabId!==id)throw scopeError();
      // Terminal archive keeps unknown operation evidence; no browser effect or replay.
      const {token,...view}=task;
      const ended={...view,status:'ended',reason:'member_closed',members:[],activeTabId:null,activeOrigin:null,nextObservation:null,updatedAt:intent.closedAt,archived:true};
      await area.set({['conversation:'+id+':'+task.taskId]:ended,[rootKey(task.taskId)]:ended});
      await area.remove(key(id));await area.remove('memory:'+id);
      const bindings={...registry.bindings};delete bindings[id];
      await area.set({taskRegistry:{version:1,revision:registry.revision+1,bindings}});
      try{await area.remove(rootKey(task.taskId));}catch{ /* Archived unbound root is cleaned at startup. */ }
      return ended;
    }
    async function originView(id,taskId,origin,current){
      const base=current?.taskId===taskId?current:(await area.get('conversation:'+id+':'+taskId))['conversation:'+id+':'+taskId];
      if(!base||!(base.allowedOrigins||[base.origin]).includes(origin))return null;
      const saved=(await area.get(originKey(id,taskId,origin)))[originKey(id,taskId,origin)];
      const parts=(saved?.segments||[]).map(segment=>segment.view);
      if(base.origin===origin)parts.push(base);
      if(!parts.length)return null;
      const {token,pending,check,...view}=parts.at(-1);
      return {...view,taskId,origin,archived:base.origin!==origin||!!base.archived,results:parts.flatMap(v=>v.results||[]),events:parts.flatMap(v=>v.events||[]),contextArchive:parts.flatMap(v=>v.contextArchive||[])};
    }
    function rooted(id,task,revision,previous=null){
      if(!Number.isInteger(id)||id<0||task.tabId!==id||typeof task.taskId!=='string'||! /^[a-zA-Z0-9_-]{1,100}$/.test(task.taskId))throw new Error('任务根记录身份无效');
      if(previous&&task.origin!==previous.origin)throw scopeError();
      return {...task,version:3,scopeRevision:revision,initialTabId:id,initialOrigin:previous?.initialOrigin||task.origin,activeTabId:id,activeOrigin:task.origin,allowedOrigins:previous?.allowedOrigins||[task.origin],members:previous?.members||[{tabId:id,tabRef:'tab0',kind:'initial',joinRevision:revision}]};
    }
    return {
      get,
      async getByTaskId(taskId){const registry=await readRegistry();const entry=Object.entries(registry.bindings).find(([,binding])=>binding.taskId===taskId);if(!entry)return null;const task=await get(Number(entry[0]));return task?.taskId===taskId?task:null;},
      async set(id,task){return serial(async()=>{
        const registry=await readRegistry();if(registry.pending)throw scopeError();
        const binding=registry.bindings[id],previous=await get(id);
        if(Object.entries(registry.bindings).some(([tab,b])=>Number(tab)!==id&&b.taskId===task.taskId))throw new Error('任务已归属其他标签页');
        const same=binding?.taskId===task.taskId,revision=same?binding.revision:registry.revision+1;
        if(same&&task.scopeRevision!==undefined&&task.scopeRevision!==revision)throw scopeError();
        const record=rooted(id,task,revision,same?previous:null),values={[rootKey(task.taskId)]:record};
        if(previous?.taskId&&previous.taskId!==task.taskId){const {token,pending,check,...view}=previous;values['conversation:'+id+':'+previous.taskId]={...view,archived:true};}
        if(same){await area.set(values);return;}
        // Journal membership before root publication; a pending intent blocks execution.
        const next={taskId:task.taskId,revision};
        await area.set({taskRegistry:{...registry,pending:{tabId:id,binding:next,previousTaskId:previous?.taskId||null}}});
        await area.set(values);
        await area.set({taskRegistry:{version:1,revision,bindings:{...registry.bindings,[id]:next}}});
        try{await area.remove(key(id));}catch{ /* The committed root remains authoritative; startup retries legacy cleanup. */ }
        if(previous?.taskId&&previous.taskId!==task.taskId)try{await area.remove(rootKey(previous.taskId));}catch{ /* Unbound roots cannot execute; cleanup retries at startup. */ }
      });},
      async changeOrigins(id,{taskId,expectedRevision,origin,action,token,updatedAt}){return serial(async()=>{
        const registry=await readRegistry();if(registry.pending)throw scopeError();
        const task=await get(id),binding=registry.bindings[id];
        if(!task||task.taskId!==taskId||!binding||binding.revision!==expectedRevision||['ended','completed'].includes(task.status))throw scopeError();
        let url;try{url=new URL(origin);}catch{throw new Error('请输入完整 HTTP/HTTPS 站点来源');}
        if(!['http:','https:'].includes(url.protocol)||url.origin!==origin||url.username||url.password||url.hostname.includes('*')||origin.length>300||!['add','remove'].includes(action))throw new Error('站点来源或范围操作无效');
        const origins=task.allowedOrigins||[task.origin],exists=origins.includes(origin);
        if(action==='add'&&exists||action==='remove'&&!exists)return task;
        const allowedOrigins=action==='add'?[...origins,origin]:origins.filter(value=>value!==origin);
        if(allowedOrigins.length>16)throw new Error('每个任务最多授权 16 个站点来源');
        const revision=registry.revision+1,next={taskId,revision};
        const record={...task,token,updatedAt,scopeRevision:revision,allowedOrigins,status:'paused',reason:'scope_changed',nextObservation:null,contextSummary:null,contextUsage:null,contextPressure:null,compactionGuard:false,taskPlan:null,question:null,memoryReview:null,completionEvidence:null};
        await area.set({taskRegistry:{...registry,pending:{kind:'origins_changed',tabId:id,binding:next,previousTaskId:taskId}}});
        await area.set({[rootKey(taskId)]:record});
        await area.set({taskRegistry:{version:1,revision,bindings:{...registry.bindings,[id]:next}}});
        return record;
      });},
      async switchOrigin(id,{taskId,expectedRevision,expectedToken,origin,token,updatedAt,proof=null}){return serial(async()=>{
        const registry=await readRegistry();if(registry.pending)throw scopeError();
        const task=await get(id),binding=registry.bindings[id];
        if(!task||task.taskId!==taskId||task.token!==expectedToken||binding?.revision!==expectedRevision||!(task.allowedOrigins||[task.origin]).includes(origin))throw scopeError();
        const url=new URL(origin);if(url.origin!==origin||!['http:','https:'].includes(url.protocol)||url.username||url.password||origin===task.origin)throw scopeError();
        const name=originKey(id,taskId,task.origin),saved=(await area.get(name))[name]||{version:1,taskId,tabId:id,origin:task.origin,segments:[]};
        const {token:oldToken,pending,check,...view}=task;
        if(proof)view.results=(view.results||[]).concat({action:check?.action||'navigate',request:check?.request,time:updatedAt,origin:task.origin,tabRef:'tab0',outcome:proof});
        if(!saved.segments.some(segment=>segment.id===task.scopeRevision))saved.segments.push({id:task.scopeRevision,view:{...view,archived:true}});
        if(JSON.stringify(saved).length>1000000)throw new Error('本站历史超过 100 万字符，未切换任务；原记录已保留');
        const destination=(await area.get(originKey(id,taskId,origin)))[originKey(id,taskId,origin)];
        const uncertainClicks=(destination?.segments.at(-1)?.view.uncertainClicks||[]).filter(guard=>{try{return new URL(guard.url).origin===origin;}catch{return false;}}).slice(-2);
        const revision=registry.revision+1,next={taskId,revision};
        const record={version:3,taskId,token,tabId:id,origin,uncertainClicks,initialTabId:task.initialTabId,initialOrigin:task.initialOrigin,activeTabId:id,activeOrigin:origin,allowedOrigins:task.allowedOrigins,members:task.members,scopeRevision:revision,goal:task.goal,instructions:task.instructions||[],prefs:task.prefs,steps:task.steps,metrics:{...task.metrics,...(proof?{verifications:(task.metrics?.verifications||0)+1}:{})},updatedAt,status:'running',phase:'observe',results:[],contextArchive:[],events:[{time:updatedAt,text:'已切换站点，重新观察；旧站点内容不进入当前请求'}],pending:null,check:null,retries:0};
        await area.set({taskRegistry:{...registry,pending:{kind:'origin_changed',tabId:id,binding:next,previousTaskId:taskId,sourceOrigin:task.origin,sourceRevision:task.scopeRevision}}});
        await area.set({[name]:saved});
        await area.set({[rootKey(taskId)]:record});
        await area.set({taskRegistry:{version:1,revision,bindings:{...registry.bindings,[id]:next}}});
        return record;
      });},
      async history(id,origin){
        const all=await area.get(null),current=await get(id),ids=new Set();
        for(const [name,record] of Object.entries(all))if(name.startsWith('conversation:'+id+':')||name.startsWith('conversation-origin:'+id+':'))ids.add(record.taskId);
        if(current)ids.add(current.taskId);
        const views=await Promise.all([...ids].map(taskId=>originView(id,taskId,origin,current)));
        return views.filter(Boolean).sort((a,b)=>b.updatedAt-a.updatedAt).map(t=>({taskId:t.taskId,goal:t.goal,status:t.status,updatedAt:t.updatedAt,archived:!!t.archived}));
      },
      async historyGet(id,origin,taskId){
        const view=await originView(id,taskId,origin,await get(id));
        if(!view)throw new Error('对话不存在或不属于当前授权网站');
        return view;
      },
      async closeMember(id,expectedTaskId,closedAt){return serial(async()=>{
        const registry=await readRegistry();if(registry.pending)throw scopeError();
        const task=await get(id);if(!task||task.taskId!==expectedTaskId)return null;
        const binding=registry.bindings[id];
        if(!binding||task.members?.length!==1||task.members[0].tabId!==id)throw scopeError();
        const pending={kind:'member_closed',tabId:id,binding,closedAt};
        const journal={...registry,pending};await area.set({taskRegistry:journal});
        return finishMemberClose(journal);
      });},
      async removeHistory(id){
        for(const name of Object.keys(await area.get(null)))if(name.startsWith('conversation:'+id+':')||name.startsWith('conversation-origin:'+id+':'))await area.remove(name);
      },
      async remove(id){return serial(async()=>{
        const registry=await readRegistry();if(registry.pending)throw scopeError();const binding=registry.bindings[id],bindings={...registry.bindings};delete bindings[id];
        // Remove compatibility alias before releasing ownership; roots remain authoritative.
        if(binding)for(const name of Object.keys(await area.get(null)))if(name.startsWith('conversation-origin:'+id+':'+binding.taskId+':'))await area.remove(name);
        await area.remove(key(id));await area.set({taskRegistry:{...registry,revision:registry.revision+1,bindings}});
        if(binding)await area.remove(rootKey(binding.taskId));
      });},
      async list(){const registry=await readRegistry(),all=await area.get(null),ids=new Set([...Object.keys(registry.bindings),...Object.keys(all).filter(k=>k.startsWith('task:')).map(k=>k.slice(5))]);return Promise.all([...ids].map(id=>get(Number(id))));},
      async getMemory(id,origin){return (await area.get('memory:'+id))['memory:'+id]?.[origin]||[];},
      async setMemory(id,origin,entries){
        const name='memory:'+id,all=(await area.get(name))[name]||{};
        if(entries.length)all[origin]=entries;else delete all[origin];
        if(Object.keys(all).length>10)throw new Error('临时记忆最多保存 10 个站点，请先清理不用的记忆');
        await area.set({[name]:all});
      },
      async removeMemory(id){await area.remove('memory:'+id);},
      async reconcile(){return serial(async()=>{
        const registry=await readRegistry(),intent=registry.pending;if(!intent)return;
        if(intent.kind==='member_closed'){await finishMemberClose(registry);return;}
        const id=intent.tabId,newBinding=intent.binding,root=(await area.get(rootKey(newBinding.taskId)))[rootKey(newBinding.taskId)];
        const binding=root?.scopeRevision===newBinding.revision&&root.tabId===id?newBinding:registry.bindings[id];
        if(intent.kind==='origin_changed'&&binding?.revision!==newBinding.revision){
          const name=originKey(id,newBinding.taskId,intent.sourceOrigin),saved=(await area.get(name))[name];
          if(saved){saved.segments=saved.segments.filter(segment=>segment.id!==intent.sourceRevision);if(saved.segments.length)await area.set({[name]:saved});else await area.remove(name);}
        }
        const record=binding?(await area.get(rootKey(binding.taskId)))[rootKey(binding.taskId)]:(await area.get(key(id)))[key(id)];
        if(binding?.taskId===newBinding.taskId&&intent.previousTaskId&&intent.previousTaskId!==newBinding.taskId){
          const previous=(await area.get(rootKey(intent.previousTaskId)))[rootKey(intent.previousTaskId)];
          if(previous){const {token,pending,check,...view}=previous;await area.set({['conversation:'+id+':'+previous.taskId]:{...view,archived:true}});}
        }
        if(record){const paused={...record,status:['completed','ended','stopped'].includes(record.status)?record.status:'paused',reason:'scope_reconciled'};await area.set(binding?{[rootKey(binding.taskId)]:paused}:{[key(id)]:paused});}
        const bindings={...registry.bindings};if(binding)bindings[id]=binding;else delete bindings[id];
        await area.set({taskRegistry:{version:1,revision:Math.max(registry.revision,newBinding.revision),bindings}});
        if(binding)await area.remove(key(id));
      });},
      async migrate(){
        await this.reconcile();
        const registry=await readRegistry(),bound=new Set(Object.values(registry.bindings).map(b=>rootKey(b.taskId)));
        for(const [name,record] of Object.entries(await area.get(null)))if(name.startsWith('taskRoot:')&&!bound.has(name)){const archived=(await area.get('conversation:'+record.tabId+':'+record.taskId))['conversation:'+record.tabId+':'+record.taskId];if(archived)await area.remove(name);}
        for(const [name,old] of Object.entries(await area.get(null))){
          if(name.startsWith('task:')){const id=Number(name.slice(5));if(Number.isInteger(id)){const registry=await readRegistry();if(!registry.bindings[id])await this.set(id,{...old,metrics:old.metrics||{observations:0,verifications:0,actions:0},check:old.check||null,waitDeadline:old.waitDeadline||null});else {await get(id);await area.remove(name);}}}
          if(!name.startsWith('chat:'))continue;
          const tabId=Number(name.slice(5)),s=old?.state;
          if(Number.isInteger(tabId)&&s?.goal&&!await this.get(tabId))await this.set(tabId,{
            version:2,taskId:crypto.randomUUID(),token:crypto.randomUUID(),tabId,origin:old.origin,goal:s.goal,
            status:'paused',phase:'observe',steps:s.steps||0,prefs:{maxSteps:50},results:[],pending:null,retries:0,
            events:[{time:Date.now(),text:'已迁移旧版目标，点击继续以读取当前页'}],updatedAt:Date.now()
          });
          await area.remove(name);
        }
      }
    };
  }
  root.PageAgentTaskStore={createTaskStore};
  if(typeof module!=='undefined')module.exports=root.PageAgentTaskStore;
})(globalThis);
