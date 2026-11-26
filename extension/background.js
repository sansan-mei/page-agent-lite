'use strict';
let startupFailure=null;
try {
  importScripts('tool-protocol.js','conditions.js','script-tools.js','core.js','prompts.js','backend.js','task-store.js','site-memory.js','history-store.js','frame-tools.js','browser-tools.js','runtime.js');
} catch(error) {
  const match=String(error?.message||'').match(/\/([a-z-]+\.js)(?:['"\s]|$)/);
  const file=match&&['tool-protocol.js','conditions.js','script-tools.js','core.js','prompts.js','backend.js','task-store.js','site-memory.js','history-store.js','frame-tools.js','browser-tools.js','runtime.js'].includes(match[1])?match[1]:'后台依赖文件';
  startupFailure=`扩展无法加载 ${file}。请在扩展管理页重新加载，并刷新网页、重新打开侧边栏；仍失败时检查扩展目录文件是否齐全。`;
}
if(startupFailure){
  // Keep the UI reachable even when a local extension asset failed to load.
  // Never fetch/evaluate replacement code or start a partially initialized agent.
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if(sender.id!==chrome.runtime.id)return;
    respond({ok:false,error:startupFailure});
  });
  chrome.action.onClicked.addListener(tab=>{
    void chrome.sidePanel.open({tabId:tab.id}).catch(()=>{});
  });
  void Promise.allSettled([
    chrome.action.setBadgeText({text:'!'}),
    chrome.action.setTitle({title:'扩展依赖加载失败，请重新加载扩展'})
  ]);
}else{
const service=PageAgentBackend.createService(chrome);
const store=PageAgentTaskStore.createTaskStore(chrome);
const tools=PageAgentBrowserTools.createBrowserTools(chrome);
const siteMemory=PageAgentSiteMemory.createSiteMemory();
const globalMemory=PageAgentSiteMemory.createSiteMemory({scope:'global'});
const history=PageAgentHistoryStore.createHistoryStore();
const historyTimers=new Map(),forgottenHistory=new Set();let historyQueue=Promise.resolve();
// Session conversations are copied to IndexedDB through one queue, so a delete is never overtaken by an older save.
function historyJob(operation){const job=historyQueue.catch(()=>{}).then(operation);historyQueue=job.catch(()=>{});return job;}
function saveHistory(taskId){return historyJob(async()=>{if(forgottenHistory.has(taskId))return;const view=await store.conversation(taskId);if(view&&!forgottenHistory.has(taskId))await history.save(view);});}
function queueHistory(taskId){clearTimeout(historyTimers.get(taskId));historyTimers.set(taskId,setTimeout(()=>{historyTimers.delete(taskId);void saveHistory(taskId).catch(()=>{});},500));}
function forgetHistory(taskId){forgottenHistory.add(taskId);clearTimeout(historyTimers.get(taskId));historyTimers.delete(taskId);return historyJob(()=>history.remove(taskId));}
async function syncHistory(){const ids=await store.conversationIds();for(const id of ids)await saveHistory(id);await historyJob(()=>history.interrupt(new Set(ids)));}
const timers=new Map(),scheduledTasks=new Map(),scheduleVersions=new Map(),scheduleQueues=new Map();
function queueSchedule(tabId,operation){const job=(scheduleQueues.get(tabId)||Promise.resolve()).catch(()=>{}).then(operation);scheduleQueues.set(tabId,job);job.finally(()=>{if(scheduleQueues.get(tabId)===job)scheduleQueues.delete(tabId);}).catch(()=>{});return job;}
function schedule(tabId,delay=0){
  const version=(scheduleVersions.get(tabId)||0)+1;scheduleVersions.set(tabId,version);
  void queueSchedule(tabId,async()=>{
    const task=await store.get(tabId);if(scheduleVersions.get(tabId)!==version||!task||!['running','waiting_page'].includes(task.status))return;
    const previous=scheduledTasks.get(tabId);
    if(previous&&previous!==task.taskId){clearTimeout(timers.get(previous));timers.delete(previous);await chrome.alarms.clear('task-id:'+previous);}
    if(scheduleVersions.get(tabId)!==version)return;
    const taskId=task.taskId;scheduledTasks.set(tabId,taskId);
    await chrome.alarms.create('task-id:'+taskId,{delayInMinutes:0.5,periodInMinutes:0.5});
    if(scheduleVersions.get(tabId)!==version){await chrome.alarms.clear('task-id:'+taskId);return;}
    clearTimeout(timers.get(taskId));timers.set(taskId,setTimeout(()=>{timers.delete(taskId);void runtime.tick(tabId,taskId).catch(()=>{});},delay));
  }).catch(()=>{});
}
async function cancelSchedule(tabId){
  scheduleVersions.set(tabId,(scheduleVersions.get(tabId)||0)+1);
  return queueSchedule(tabId,async()=>{
    const taskId=scheduledTasks.get(tabId)||(await store.get(tabId))?.taskId;scheduledTasks.delete(tabId);
    if(taskId){clearTimeout(timers.get(taskId));timers.delete(taskId);await chrome.alarms.clear('task-id:'+taskId);}
    await chrome.alarms.clear('task:'+tabId);
  });
}
const runtime=PageAgentRuntime.createRuntime({store,tools,siteMemory,globalMemory,schedule,cancelSchedule,
  preferences:()=>service.preferences(),
  model:(text,signal,capabilities)=>service.generateAgent(text,signal,capabilities),
  summarize:(text,signal)=>service.summarizeAgent(text,signal),
  identity:()=>service.identity(),
  protocol:()=>service.agentProtocol(),
  // run_script is offered to the model only on turns where the optional permission and API are usable.
  scriptAccess:()=>PageAgentScriptTools.status(chrome)
});
const ready=(async()=>{
  await service.init();await store.migrate();
  await chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true});
  // Upgrade registrations created by older extension versions.
  const registered=await chrome.scripting.getRegisteredContentScripts();
  const legacyIds=registered.filter(item=>item.id.startsWith('pa-')).map(item=>item.id);
  if(legacyIds.length)await chrome.scripting.unregisterContentScripts({ids:legacyIds});
  await runtime.recover();return true;
})().catch(()=>false);
void ready.then(ok=>ok&&syncHistory()).catch(()=>{});
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area!=='session')return;
  for(const [name,change] of Object.entries(changes)){const taskId=change.newValue?.taskId;if(typeof taskId==='string'&&/^(taskRoot|task|conversation|conversation-origin):/.test(name))queueHistory(taskId);}
});
function panelSender(s){return s.id===chrome.runtime.id&&s.url===chrome.runtime.getURL('sidepanel.html')&&(s.frameId===undefined||s.frameId===0);}
function contentSender(s){
  if(s.id!==chrome.runtime.id||s.frameId!==0||!Number.isInteger(s.tab?.id))return false;
  try{return ['http:','https:'].includes(new URL(s.url).protocol);}catch{return false;}
}
function errorText(e){const text=typeof e?.message==='string'?e.message:'';return /^[\u3400-\u9fff]|^API /u.test(text)&&text.length<180?text:'操作失败，请检查权限、配置或存储后重试';}
chrome.runtime.onMessage.addListener((m,s,respond)=>{
  (async()=>{
    if(!await ready)throw new Error('扩展初始化失败，请重新加载扩展');
    if(!m||typeof m.type!=='string'||JSON.stringify(m).length>160000)throw new Error('消息格式无效');
    if(m.type==='openOptions'){
      if(!panelSender(s)&&!contentSender(s))throw new Error('消息来源无效');
      await chrome.runtime.openOptionsPage();return {opened:true};
    }
    if(m.type==='pageReady'){
      if(!contentSender(s))throw new Error('消息来源无效');
      const task=await runtime.get(s.tab.id);
      if(task?.origin===new URL(s.url).origin&&['running','waiting_page'].includes(task.status))schedule(s.tab.id);
      return {ready:true};
    }
    if(['task:global-memory','task:global-memory-change'].includes(m.type)){
      const optionsSender=s.id===chrome.runtime.id&&s.url===chrome.runtime.getURL('options.html')&&(s.frameId===undefined||s.frameId===0);
      if(!panelSender(s)&&!optionsSender)throw new Error('拒绝访问全局记忆');
      if(m.type==='task:global-memory')return runtime.getGlobalMemory();
      return runtime.editGlobalMemory({action:m.action,id:m.id,text:m.text,expectedVersion:m.expectedVersion});
    }
    if(m.type.startsWith('task:')){
      const managementSender=s.id===chrome.runtime.id&&s.url===chrome.runtime.getURL('options.html')&&(s.frameId===undefined||s.frameId===0)&&['task:site-memory','task:site-memory-change'].includes(m.type);
      if((!panelSender(s)&&!managementSender)||!Number.isInteger(m.tabId)||m.tabId<0)throw new Error('拒绝访问任务');
      // Commands on a non-executing member tab act on its task's executing tab; notes stay per tab.
      const taskTab=['task:get','task:sensitive-access','task:tab-access','task:script-approval','task:script-revoke','task:members','task:member-change','task:scope-change','task:diagnostics','task:finish','task:resume','task:stop','task:takeover','task:choose','task:approve','task:clear','task:goal-mode'].includes(m.type)&&runtime.resolve?await runtime.resolve(m.tabId):m.tabId;
      if(m.type==='task:get'){
        const task=await runtime.get(taskTab);
        if(!task)return task;
        // Display-only history: never write merged site content back into the runtime.
        const conversation=await store.conversation(task.taskId);
        return {...task,displayLog:{results:conversation?.results||task.results||[],events:conversation?.events||task.events||[]}};
      }
      if(m.type==='task:sensitive-access')return runtime.sensitiveAccess(taskTab,{taskId:m.taskId,requestId:m.requestId,allow:m.allow});
      if(m.type==='task:tab-access'){
        if(typeof m.taskId!=='string'||typeof m.requestId!=='string'||typeof m.allow!=='boolean')throw new Error('标签页授权无效');
        return runtime.tabAccess(taskTab,{taskId:m.taskId,requestId:m.requestId,allow:m.allow});
      }
      if(m.type==='task:script-approval'){
        // Strict shape: allow is boolean; scope is once|task (default once); a task-wide grant must approve.
        const scope=m.scope===undefined?'once':m.scope;
        if(typeof m.taskId!=='string'||typeof m.requestId!=='string'||typeof m.allow!=='boolean'||!['once','task'].includes(scope)||scope==='task'&&!m.allow)throw new Error('脚本确认无效');
        return runtime.scriptApproval(taskTab,{taskId:m.taskId,requestId:m.requestId,allow:m.allow,scope});
      }
      if(m.type==='task:script-revoke'){
        if(typeof m.taskId!=='string')throw new Error('脚本确认无效');
        return runtime.revokeScriptApproval(taskTab,{taskId:m.taskId});
      }
      if(m.type==='task:members')return runtime.members(taskTab,m.taskId);
      if(m.type==='task:member-change')return runtime.changeMembers(taskTab,{taskId:m.taskId,expectedMembersRevision:m.expectedMembersRevision,action:m.action,memberTabId:m.memberTabId,tabRef:m.tabRef});
      if(m.type==='task:scope-change')return runtime.changeOrigins(taskTab,{taskId:m.taskId,expectedRevision:m.expectedRevision,origin:m.origin,action:m.action});
      if(m.type==='task:diagnostics')return runtime.diagnostics(taskTab,m.taskId);
      if(m.type==='task:history')return history.list();
      if(m.type==='task:history-get'||m.type==='task:history-delete'){
        if(typeof m.taskId!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(m.taskId))throw new Error('对话标识无效');
        if(m.type==='task:history-get'){
          const live=await store.conversation(m.taskId),view=live?PageAgentHistoryStore.snapshot(live):await history.get(m.taskId);
          if(!view)throw new Error('对话不存在或已删除');return view;
        }
        const live=await store.getByTaskId(m.taskId);
        if(live){if(!['completed','ended','stopped','failed'].includes(live.status))throw new Error('该对话仍在进行，请先结束后再删除');await runtime.remove(live.tabId);}
        await store.deleteConversation(m.taskId);await forgetHistory(m.taskId);return true;
      }
      if(m.type==='task:site-memory')return runtime.getSiteMemory(m.tabId);
      if(m.type==='task:site-memory-change')return runtime.editSiteMemory(m.tabId,{origin:m.origin,action:m.action,id:m.id,text:m.text,expectedVersion:m.expectedVersion});
      if(m.type==='task:connect'){await tools.inject(m.tabId);return {connected:true};}
      if(m.type==='task:start'||m.type==='task:submit')return typeof m.goalMode==='boolean'?runtime.submit(m.tabId,m.goal,{goalMode:m.goalMode}):runtime.submit(m.tabId,m.goal);
      if(m.type==='task:goal-mode'){
        if(typeof m.taskId!=='string'||typeof m.enabled!=='boolean')throw new Error('目标模式参数无效');
        return runtime.setGoalMode(taskTab,m.taskId,m.enabled);
      }
      if(m.type==='task:finish')return runtime.finish(taskTab);
      if(m.type==='task:resume')return runtime.resume(taskTab);
      if(m.type==='task:stop')return runtime.stop(taskTab);
      if(m.type==='task:takeover')return runtime.takeover(taskTab);
      if(m.type==='task:choose')return runtime.choose(taskTab,m.taskId,m.questionId,m.indices);
      if(m.type==='task:approve')return runtime.approve(taskTab,m.taskId);
      if(m.type==='task:clear'){const cleared=await runtime.get(taskTab);await runtime.remove(taskTab);if(typeof cleared?.taskId==='string')await forgetHistory(cleared.taskId);return null;}
      throw new Error('未知任务操作');
    }
    if(m.type==='model'&&m.task==='agent')throw new Error('请从侧边栏发起任务');
    return service.handle(m,s);
  })().then(value=>respond({ok:true,value}),e=>respond({ok:false,error:errorText(e)}));
  return true;
});
chrome.action.onClicked.addListener(tab=>{
  if(!Number.isInteger(tab.id))return;
  void (async()=>{
    try{
      if(!await ready)throw new Error('初始化失败');
      const current=await tools.tab(tab.id,true);if(['http:','https:'].includes(new URL(current.url).protocol))await tools.inject(tab.id);
      await chrome.action.setBadgeText({tabId:tab.id,text:''});
    }catch{
      await chrome.action.setBadgeText({tabId:tab.id,text:'!'});
      await chrome.action.setTitle({tabId:tab.id,title:'打开侧栏开始对话；网页操作需要网站授权。'});
    }
  })();
});
chrome.alarms.onAlarm.addListener(alarm=>{
  if(alarm.name.startsWith('task-id:')){
    const taskId=alarm.name.slice(8);void ready.then(async ok=>{if(!ok)return;const task=await store.getByTaskId(taskId);if(task)await runtime.tick(task.tabId,taskId);else await chrome.alarms.clear(alarm.name);}).catch(()=>{});return;
  }
  if(!alarm.name.startsWith('task:'))return;
  const id=Number(alarm.name.slice(5));if(Number.isInteger(id))void ready.then(async ok=>{await chrome.alarms.clear(alarm.name);if(ok)schedule(id);}).catch(()=>{});
});
chrome.tabs.onUpdated.addListener((id,change)=>{
  if(change.url||change.status==='loading'){void ready.then(ok=>ok&&runtime.navigationChanged(id,change.url)).catch(()=>{});return;}
  if(change.status==='complete')void ready.then(async ok=>{
    if(!ok)return;const task=await runtime.get(id);
    if(task&&['running','waiting_page'].includes(task.status))schedule(id);
  }).catch(()=>{});
});
chrome.permissions.onRemoved.addListener(()=>{void ready.then(ok=>ok&&runtime.reviewPermissions()).catch(()=>{});});
chrome.tabs.onRemoved.addListener(id=>{void ready.then(ok=>ok&&runtime.memberClosed(id)).catch(()=>{});});
}
