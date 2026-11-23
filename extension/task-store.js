(function(root){
  'use strict';
  function createTaskStore(chrome) {
    const area=chrome.storage.session;
    const key=id=>'task:'+id;
    return {
      async get(id){return (await area.get(key(id)))[key(id)]||null;},
      async set(id,task){await area.set({[key(id)]:task});},
      async remove(id){await area.remove(key(id));},
      async list(){return Object.entries(await area.get(null)).filter(([k])=>k.startsWith('task:')).map(([,v])=>v);},
      async getMemory(id,origin){return (await area.get('memory:'+id))['memory:'+id]?.[origin]||[];},
      async setMemory(id,origin,entries){
        const name='memory:'+id,all=(await area.get(name))[name]||{};
        if(entries.length)all[origin]=entries;else delete all[origin];
        if(Object.keys(all).length>10)throw new Error('临时记忆最多保存 10 个站点，请先清理不用的记忆');
        await area.set({[name]:all});
      },
      async removeMemory(id){await area.remove('memory:'+id);},
      async migrate(){
        for(const [name,old] of Object.entries(await area.get(null))){
          if(name.startsWith('task:')&&old?.version!==2){
            await area.set({[name]:{...old,version:2,metrics:old.metrics||{observations:0,verifications:0,actions:0},check:old.check||null,waitDeadline:old.waitDeadline||null}});
          }
          if(!name.startsWith('chat:'))continue;
          const tabId=Number(name.slice(5)),s=old?.state;
          if(Number.isInteger(tabId)&&s?.goal&&!await this.get(tabId))await this.set(tabId,{
            version:2,taskId:crypto.randomUUID(),token:crypto.randomUUID(),tabId,origin:old.origin,goal:s.goal,
            status:'paused',phase:'observe',steps:s.steps||0,prefs:{maxSteps:50,autoFill:true},results:[],pending:null,retries:0,
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
