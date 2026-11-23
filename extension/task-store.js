(function(root){
  'use strict';
  const taskStoreWrites=new WeakMap();
  function createTaskStore(chrome) {
    const area=chrome.storage.session;
    const key=id=>'task:'+id;
    const rootKey=id=>'taskRoot:'+id;
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
    function rooted(id,task,revision){
      if(!Number.isInteger(id)||id<0||task.tabId!==id||typeof task.taskId!=='string'||! /^[a-zA-Z0-9_-]{1,100}$/.test(task.taskId))throw new Error('任务根记录身份无效');
      return {...task,version:3,scopeRevision:revision,initialTabId:id,initialOrigin:task.origin,activeTabId:id,activeOrigin:task.origin,allowedOrigins:[task.origin],members:[{tabId:id,tabRef:'tab0',kind:'initial',joinRevision:revision}]};
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
        const record=rooted(id,task,revision),values={[rootKey(task.taskId)]:record,[key(id)]:record};
        if(previous?.taskId&&previous.taskId!==task.taskId){const {token,pending,check,...view}=previous;values['conversation:'+id+':'+previous.taskId]={...view,archived:true};}
        if(same){await area.set(values);return;}
        // Journal membership before root publication; a pending intent blocks execution.
        const next={taskId:task.taskId,revision};
        await area.set({taskRegistry:{...registry,pending:{tabId:id,binding:next,previousTaskId:previous?.taskId||null}}});
        await area.set(values);
        await area.set({taskRegistry:{version:1,revision,bindings:{...registry.bindings,[id]:next}}});
        if(previous?.taskId&&previous.taskId!==task.taskId)try{await area.remove(rootKey(previous.taskId));}catch{ /* Unbound roots cannot execute; cleanup retries at startup. */ }
      });},
      async history(id,origin){
        const all=await area.get(null),current=await get(id);
        const records=Object.entries(all).filter(([k])=>k.startsWith('conversation:'+id+':')).map(([,v])=>v);
        if(current)records.push(current);
        return records.filter(t=>t.origin===origin).sort((a,b)=>b.updatedAt-a.updatedAt).map(t=>({taskId:t.taskId,goal:t.goal,status:t.status,updatedAt:t.updatedAt,archived:!!t.archived}));
      },
      async historyGet(id,origin,taskId){
        const current=await this.get(id);
        const record=current?.taskId===taskId?current:(await area.get('conversation:'+id+':'+taskId))['conversation:'+id+':'+taskId];
        if(!record||record.origin!==origin)throw new Error('对话不存在或不属于当前网站');
        const {token,pending,check,...view}=record;return view;
      },
      async removeHistory(id){
        for(const name of Object.keys(await area.get(null)))if(name.startsWith('conversation:'+id+':'))await area.remove(name);
      },
      async remove(id){return serial(async()=>{
        const registry=await readRegistry();if(registry.pending)throw scopeError();const binding=registry.bindings[id],bindings={...registry.bindings};delete bindings[id];
        // Remove compatibility alias before releasing ownership; roots remain authoritative.
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
        const id=intent.tabId,newBinding=intent.binding,root=(await area.get(rootKey(newBinding.taskId)))[rootKey(newBinding.taskId)];
        const binding=root?.scopeRevision===newBinding.revision&&root.tabId===id?newBinding:registry.bindings[id];
        const record=binding?(await area.get(rootKey(binding.taskId)))[rootKey(binding.taskId)]:(await area.get(key(id)))[key(id)];
        if(binding?.taskId===newBinding.taskId&&intent.previousTaskId&&intent.previousTaskId!==newBinding.taskId){
          const previous=(await area.get(rootKey(intent.previousTaskId)))[rootKey(intent.previousTaskId)];
          if(previous){const {token,pending,check,...view}=previous;await area.set({['conversation:'+id+':'+previous.taskId]:{...view,archived:true}});}
        }
        if(record){const paused={...record,status:['completed','ended','stopped'].includes(record.status)?record.status:'paused',reason:'scope_reconciled'};await area.set({[key(id)]:paused,...(binding?{[rootKey(binding.taskId)]:paused}:{})});}
        const bindings={...registry.bindings};if(binding)bindings[id]=binding;else delete bindings[id];
        await area.set({taskRegistry:{version:1,revision:Math.max(registry.revision,newBinding.revision),bindings}});
      });},
      async migrate(){
        await this.reconcile();
        const registry=await readRegistry(),bound=new Set(Object.values(registry.bindings).map(b=>rootKey(b.taskId)));
        for(const [name,record] of Object.entries(await area.get(null)))if(name.startsWith('taskRoot:')&&!bound.has(name)){const archived=(await area.get('conversation:'+record.tabId+':'+record.taskId))['conversation:'+record.tabId+':'+record.taskId];if(archived)await area.remove(name);}
        for(const [name,old] of Object.entries(await area.get(null))){
          if(name.startsWith('task:')){const id=Number(name.slice(5));if(Number.isInteger(id)){const registry=await readRegistry();if(!registry.bindings[id])await this.set(id,{...old,metrics:old.metrics||{observations:0,verifications:0,actions:0},check:old.check||null,waitDeadline:old.waitDeadline||null});}}
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
