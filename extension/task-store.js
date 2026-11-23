(function(root){
  'use strict';
  function createTaskStore(chrome) {
    const area=chrome.storage.session;
    const key=id=>'task:'+id;
    return {
      async get(id){return (await area.get(key(id)))[key(id)]||null;},
      async set(id,task){
        const previous=await this.get(id),values={[key(id)]:task};
        if(previous?.taskId&&previous.taskId!==task.taskId){
          const {token,pending,check,...record}=previous;
          values['conversation:'+id+':'+previous.taskId]={...record,archived:true};
        }
        // Preserve the old conversation and replace the current checkpoint together.
        await area.set(values);
      },
      async history(id,origin){
        const all=await area.get(null),current=all[key(id)];
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
