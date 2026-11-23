'use strict';
let startupFailure=null;
try {
  importScripts('tool-protocol.js','conditions.js','core.js','prompts.js','backend.js','task-store.js','site-memory.js','browser-tools.js','runtime.js');
} catch(error) {
  const match=String(error?.message||'').match(/\/([a-z-]+\.js)(?:['"\s]|$)/);
  const file=match&&['tool-protocol.js','conditions.js','core.js','prompts.js','backend.js','task-store.js','site-memory.js','browser-tools.js','runtime.js'].includes(match[1])?match[1]:'后台依赖文件';
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
  model:(text,signal)=>service.generateAgent(text,signal),
  summarize:(text,signal)=>service.summarizeAgent(text,signal),
  identity:()=>service.identity()
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
      const managementSender=s.id===chrome.runtime.id&&s.url===chrome.runtime.getURL('options.html')&&(s.frameId===undefined||s.frameId===0)&&['task:site-memory','task:site-memory-change','task:memory','task:memory-clear'].includes(m.type);
      if((!panelSender(s)&&!managementSender)||!Number.isInteger(m.tabId)||m.tabId<0)throw new Error('拒绝访问任务');
      if(m.type==='task:get')return runtime.get(m.tabId);
      if(m.type==='task:scope-change')return runtime.changeOrigins(m.tabId,{taskId:m.taskId,expectedRevision:m.expectedRevision,origin:m.origin,action:m.action});
      if(m.type==='task:diagnostics')return runtime.diagnostics(m.tabId,m.taskId);
      if(m.type==='task:history'||m.type==='task:history-get'){
        const origin=new URL((await tools.tab(m.tabId)).url).origin;
        if(m.type==='task:history')return store.history(m.tabId,origin);
        if(typeof m.taskId!=='string'||m.taskId.length>100)throw new Error('对话标识无效');
        return store.historyGet(m.tabId,origin,m.taskId);
      }
      if(m.type==='task:site-memory')return runtime.getSiteMemory(m.tabId);
      if(m.type==='task:site-memory-change')return runtime.editSiteMemory(m.tabId,{origin:m.origin,action:m.action,id:m.id,text:m.text,expectedVersion:m.expectedVersion});
      if(m.type==='task:memory')return runtime.getMemory(m.tabId);
      if(m.type==='task:memory-clear')return runtime.clearMemory(m.tabId);
      if(m.type==='task:connect'){await tools.inject(m.tabId);return {connected:true};}
      if(m.type==='task:start'||m.type==='task:submit'){await tools.inject(m.tabId);return runtime.submit(m.tabId,m.goal);}
      if(m.type==='task:finish')return runtime.finish(m.tabId);
      if(m.type==='task:resume')return runtime.resume(m.tabId);
      if(m.type==='task:stop')return runtime.stop(m.tabId);
      if(m.type==='task:takeover')return runtime.takeover(m.tabId);
      if(m.type==='task:choose')return runtime.choose(m.tabId,m.taskId,m.questionId,m.indices);
      if(m.type==='task:approve')return runtime.approve(m.tabId,m.taskId);
      if(m.type==='task:clear'){await runtime.remove(m.tabId);return null;}
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
      await tools.tab(tab.id);await tools.inject(tab.id);
      await chrome.action.setBadgeText({tabId:tab.id,text:''});
    }catch{
      await chrome.action.setBadgeText({tabId:tab.id,text:'!'});
      await chrome.action.setTitle({tabId:tab.id,title:'请打开普通网页。配置可从扩展选项进入。'});
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
  if(change.status==='complete')void ready.then(async ok=>{
    if(!ok)return;const task=await runtime.get(id);
    if(task&&['running','waiting_page'].includes(task.status))schedule(id);
  }).catch(()=>{});
});
chrome.permissions.onRemoved.addListener(()=>{void ready.then(ok=>ok&&runtime.reviewPermissions()).catch(()=>{});});
chrome.tabs.onRemoved.addListener(id=>{void ready.then(ok=>ok&&runtime.memberClosed(id)).catch(()=>{});});
}
