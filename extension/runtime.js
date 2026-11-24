(function (root) {
  'use strict';
  const C = typeof module !== 'undefined' ? require('./core.js') : root.PageAgentCore;
  const P = typeof module !== 'undefined' ? require('./prompts.js') : root.PageAgentPrompts;
  const T = typeof module !== 'undefined' ? require('./tool-protocol.js') : root.PageAgentProtocol;
  const G = typeof module !== 'undefined' ? require('./conditions.js') : root.PageAgentConditions;
  const ACTIVE = new Set(['running', 'waiting_page']);
  function recent(items, count = 12, size = 10000) {
    const next = items.slice(-count);
    while (JSON.stringify(next).length > size) next.shift();
    return next;
  }
  function createRuntime({store, tools, siteMemory=null, globalMemory=null, model, summarize, identity=async()=>null, preferences, schedule, cancelSchedule, uuid = () => crypto.randomUUID(), now = () => Date.now()}) {
    let globalEpoch=0,globalEditing=false,globalEditQueue=Promise.resolve();
    const locks=new Map(),bindingLocks=new Map(),jobs=new Map(),controllers=new Map(),controllerTasks=new Map();
    const controllerForTab=id=>controllers.get(controllerTasks.get(id));
    function enqueue(map,key,fn){const operation=(map.get(key)||Promise.resolve()).catch(()=>{}).then(fn);map.set(key,operation);operation.finally(()=>{if(map.get(key)===operation)map.delete(key);}).catch(()=>{});return operation;}
    function serial(tabId,fn){
      // A tab publication gate protects replacement; taskId is the execution lock.
      return enqueue(bindingLocks,tabId,async()=>{const task=await store.get(tabId);return enqueue(locks,task?.taskId||'new:'+tabId,fn);});
    }
    function update(tabId, token, fn) {
      return serial(tabId, async () => {
        const task = await store.get(tabId);
        if (!task || task.token !== token) return null;
        const existing=new Set(task.results||[]);fn(task);task.results=(task.results||[]).map(entry=>existing.has(entry)||entry.origin?entry:{...entry,origin:task.origin,tabRef:'tab0'}); task.version=task.version===3?3:2;task.updatedAt = now(); await store.set(tabId, task); return task;
      });
    }
    async function measured(task,kind,operation,live){
      const saved=await update(task.tabId,task.token,t=>{
        const timings=t.metrics?.timings||{},previous=timings[kind]||{};
        t.metrics={...t.metrics,timings:{...timings,[kind]:{attempts:(previous.attempts||0)+1,completed:previous.completed||0,failed:previous.failed||0,totalMs:previous.totalMs||0,lastMs:previous.lastMs??null}}};
      });
      if(!saved||!await live())throw Object.assign(new Error('请求已取消'),{code:'CANCELLED'});
      const started=now();let failed=false;
      try{return await operation();}catch(error){failed=true;throw error;}
      finally{
        const elapsed=Math.max(0,now()-started);
        if(await live())await update(task.tabId,task.token,t=>{
          const timings=t.metrics?.timings||{},previous=timings[kind]||{};
          t.metrics={...t.metrics,timings:{...timings,[kind]:{...previous,completed:(previous.completed||0)+(failed?0:1),failed:(previous.failed||0)+(failed?1:0),totalMs:(previous.totalMs||0)+elapsed,lastMs:elapsed}}};
        });
      }
    }
    const event = (t, text) => {t.events = recent(t.events.concat({time:Date.now(), text}), 40, 16000);};
    const withoutSubgoals=plan=>{if(!plan||!Object.prototype.hasOwnProperty.call(plan,'subgoals'))return plan;const {subgoals,...rest}=plan;return rest;};
    function forgetPlanContext(t){
      t.taskPlan=null;
      const clean=r=>r.request?{...r,request:withoutSubgoals(r.request)}:r;
      t.results=(t.results||[]).map(clean);
      t.contextArchive=(t.contextArchive||[]).map(a=>({...a,results:a.results.map(clean)}));
      // Keep action/checkpoint evidence intact; only discard planning metadata.
      if(t.pending?.plan)t.pending={...t.pending,plan:withoutSubgoals(t.pending.plan)};
      if(t.check?.request)t.check={...t.check,request:withoutSubgoals(t.check.request)};
    }
    function forgetSiteContext(t){
      forgetPlanContext(t);
      t.contextSummary=null;t.contextUsage=null;t.compactionGuard=false;
      const keep=r=>!r.action?.startsWith('site_memory_')&&r.action!=='history_read';
      t.results=(t.results||[]).filter(keep);
      t.contextArchive=(t.contextArchive||[]).map(a=>({...a,results:a.results.filter(keep)}));
    }
    function forgetGlobalContext(t){
      forgetPlanContext(t);
      t.contextSummary=null;t.contextUsage=null;t.compactionGuard=false;
      const keep=r=>!r.action?.startsWith('global_memory_')&&r.action!=='history_read';
      t.results=(t.results||[]).filter(keep);
      t.contextArchive=(t.contextArchive||[]).map(a=>({...a,results:a.results.filter(keep)}));
    }
    const getGlobalMemoryOrEmpty=()=>globalMemory?globalMemory.read(null):Promise.resolve({version:0,notes:[]});
    async function getGlobalMemory(){
      if(!globalMemory)throw new Error('全局长期记忆服务不可用，请重新加载扩展');
      return globalMemory.read(null);
    }
    function editGlobalMemory(operation){
      const job=globalEditQueue.catch(()=>{}).then(async()=>{
        if(!globalMemory)throw new Error('全局长期记忆服务不可用，请重新加载扩展');
        globalEditing=true;globalEpoch++;
        try{
          for(const controller of controllers.values())controller.abort();
          for(const old of await store.list())await serial(old.tabId,async()=>{
            const t=await store.get(old.tabId);if(!t)return;
            controllerForTab(t.tabId)?.abort();t.token=uuid();t.nextObservation=null;forgetGlobalContext(t);t.memoryReview=null;
            // Keep uncertain side effects and existing deadlines for read-only recovery.
            if(t.phase!=='executing'&&!t.check){t.pending=null;t.phase='observe';}
            if(!['completed','ended','stopped','failed'].includes(t.status)){t.status='paused';t.reason='global_memory_changed';}
            event(t,'用户正在修改全局长期记忆，旧请求失效；继续任务将重新读取');await store.set(t.tabId,t);
          });
          return await globalMemory.change(null,{...operation,source:'user'});
        }finally{globalEditing=false;}
      });
      globalEditQueue=job;return job;
    }
    async function globalMemoryAction(task,plan,version,signal){
      await serial(task.tabId,async()=>{
        const t=await store.get(task.tabId);if(t?.token!==task.token||signal.aborted||globalEditing||!ACTIVE.has(t.status))return;
        let result;
        try{
          if(!globalMemory)throw new Error('全局长期记忆服务不可用');
          if(plan.action==='global_memory_read'){
            const current=await globalMemory.read(null),note=current.notes.find(n=>n.id===plan.id);
            result=note?{version:current.version,note}:{version:current.version,error:'没有此全局长期记忆'};
          }else{
            const saved=await globalMemory.change(null,{action:plan.action.slice('global_memory_'.length),id:plan.id,text:plan.value,expectedVersion:version,source:'model',signal});
            globalEpoch++;for(const [id,controller] of controllers)if(id!==t.taskId)controller.abort();forgetGlobalContext(t);t.globalMemoryVersion=saved.version;
            result={version:saved.version,saved:plan.id||null,action:plan.action};if(plan.action==='global_memory_write')t.memoryReview=null;
          }
        }catch(e){result={error:e.message,code:e.code||'GLOBAL_MEMORY_ERROR'};}
        if(signal.aborted)return;
        t.phase='observe';t.pending=null;t.results=t.results.concat({origin:t.origin,tabRef:'tab0',request:plan.action.endsWith('_read')?plan:withoutSubgoals(plan),time:now(),action:plan.action,result});event(t,'全局长期记忆：'+plan.action+(result.error?' · '+result.error:' · 已完成'));await store.set(t.tabId,t);
      });
    }
    async function getSiteMemory(tabId){
      const tab=await tools.tab(tabId),origin=new URL(tab.url).origin;
      if(!siteMemory)throw new Error('长期记忆服务不可用，请重新加载扩展');
      return siteMemory.read(origin);
    }
    async function editSiteMemory(tabId,operation){
      const tab=await tools.tab(tabId),origin=new URL(tab.url).origin;
      if(operation.origin!==origin)throw new Error('网页已切换，请刷新网站长期记忆后重试');
      if(!siteMemory)throw new Error('长期记忆服务不可用，请重新加载扩展');
      const affected=(await store.list()).filter(t=>t.origin===origin);
      for(const t of affected)controllerForTab(t.tabId)?.abort();
      const saved=await siteMemory.change(origin,{...operation,source:'user'});
      for(const old of affected)await serial(old.tabId,async()=>{
        const t=await store.get(old.tabId);if(!t||t.origin!==origin)return;
        controllerForTab(t.tabId)?.abort();t.token=uuid();t.nextObservation=null;forgetSiteContext(t);t.siteMemoryVersion=saved.version;
        t.check=null;t.waitDeadline=null;t.pending=null;t.memoryReview=null;t.phase='observe';
        if(!['completed','ended','stopped','failed'].includes(t.status)){t.status='paused';t.reason='site_memory_changed';}
        event(t,'用户已修改网站长期记忆，旧请求失效；继续任务将重新读取');await store.set(t.tabId,t);
      });
      return saved;
    }
    async function siteMemoryAction(task,plan,version,signal){
      await serial(task.tabId,async()=>{
        const t=await store.get(task.tabId);if(t?.token!==task.token||signal.aborted||!ACTIVE.has(t.status))return;
        let result;
        try{
          if(!siteMemory)throw new Error('长期记忆服务不可用');
          if(plan.action==='site_memory_read'){
            const current=await siteMemory.read(t.origin),note=current.notes.find(n=>n.id===plan.id);
            result=note?{version:current.version,note}:{version:current.version,error:'没有此长期记忆'};
          }else{
            const saved=await siteMemory.change(t.origin,{action:plan.action.slice('site_memory_'.length),id:plan.id,text:plan.value,expectedVersion:version,source:'model',signal});
            result={version:saved.version,saved:plan.id||null,action:plan.action};forgetSiteContext(t);t.siteMemoryVersion=saved.version;if(plan.action==='site_memory_write')t.memoryReview=null;
          }
        }catch(e){result={error:e.message,code:e.code||'SITE_MEMORY_ERROR'};}
        if(signal.aborted)return;
        t.phase='observe';t.pending=null;t.results=t.results.concat({origin:t.origin,tabRef:'tab0',request:plan.action.endsWith('_read')?plan:withoutSubgoals(plan),time:Date.now(),action:plan.action,result});event(t,'网站长期记忆：'+plan.action+(result.error?' · '+result.error:' · 已完成'));await store.set(t.tabId,t);
      });
    }
    const policyFor=t=>({origin:t.origin,allowedOrigins:t.allowedOrigins||[t.origin],scopeRevision:t.scopeRevision});
    const inScope=t=>(t.allowedOrigins||[t.origin]).includes(t.origin);
    async function scopePause(task,reason,message=null){
      controllerForTab(task.tabId)?.abort();
      return update(task.tabId,task.token,t=>{t.token=uuid();t.status='paused';t.reason=reason;t.nextObservation=null;t.contextUsage=null;event(t,message||(reason==='permission_denied'?'浏览器网站权限已撤销，任务暂停；已发出的操作不会撤销或重做。':'当前网站已不在任务授权范围，任务暂停。'));});
    }
    async function adoptOrigin(task,tab){
      const origin=new URL(tab.url).origin;
      if(!(task.allowedOrigins||[task.origin]).includes(origin)){await scopePause(task,'origin','目标站点未加入任务范围，任务暂停；回到原站点或授权目标站点后继续。');return null;}
      if(tools.hasOriginAccess&&!await tools.hasOriginAccess(origin)){await scopePause(task,'permission_denied','目标网站缺少浏览器权限，任务暂停；未读取目标网页。');return null;}
      let proof=null;
      if(task.check||task.phase==='executing'){
        const check=task.check;
        if(!check?.expected?.length||!check.expected.every(condition=>condition.kind==='url_equals'||condition.kind==='url_changed'&&typeof condition.beforeURL==='string')||check.tabId!==undefined&&check.tabId!==task.tabId){await scopePause(task,'origin_verification','原站点操作尚未核实，不能在新站点核对旧 DOM 条件；请回到原站点检查。');return null;}
        const evaluated=G.evaluate(check.expected,{url:tab.url,page:{elements:[],regions:[]}});
        if(evaluated.status!=='success'){await scopePause(task,'origin_verification','导航目标尚未核实（可能发生重定向），任务暂停；未读取新站点或重发导航。');return null;}
        proof=T.result({...evaluated,scope:'page',operationId:check.operationId,dispatch:check.dispatch||'unknown',code:'CONDITIONS_MATCH',recovery:'observe'});
      }
      return serial(task.tabId,async()=>{
        const current=await store.get(task.tabId);if(current?.token!==task.token)return null;
        controllerForTab(task.tabId)?.abort();
        const latest=await tools.tab(task.tabId);if(latest.url!==tab.url)return null;
        try{return await store.switchOrigin(task.tabId,{taskId:task.taskId,expectedRevision:current.scopeRevision,expectedToken:task.token,origin,token:uuid(),updatedAt:now(),proof});}
        catch(error){
          let failed;try{failed=await store.get(task.tabId);}catch{throw error;}
          if(failed?.token===task.token){failed.token=uuid();failed.status='paused';failed.reason='origin_storage';event(failed,'站点切换未完成，原记录已保留；请检查会话容量或重新加载扩展对账');await store.set(task.tabId,failed);}
          throw error;
        }
      });
    }
    async function navigationChanged(tabId,url){
      controllerForTab(tabId)?.abort();
      const saved=await serial(tabId,async()=>{
        const t=await store.get(tabId);if(!t||!ACTIVE.has(t.status))return null;
        controllerForTab(tabId)?.abort();t.token=uuid();t.nextObservation=null;
        if(!t.check&&t.phase==='executing'&&t.pending&&url&&new URL(url).origin===t.origin&&url!==t.pending.url){
          const pending=t.pending;t.uncertainClicks=(t.uncertainClicks||[]).concat({url:pending.url,documentId:pending.documentId,key:pending.targetKey,target:pending.targetDescriptor}).slice(-2);
          t.results=(t.results||[]).concat({action:pending.plan.action,request:pending.plan,origin:t.origin,tabRef:'tab0',outcome:T.result({status:'unknown',dispatch:'unknown',scope:'dispatch',code:'DOCUMENT_CHANGED',recovery:'observe',operationId:pending.operationId,message:'页面已导航，旧操作未重放；重新观察核对'})});t.phase='observe';t.pending=null;
        }
        if(!t.check&&t.phase!=='executing'){t.phase='observe';t.pending=null;}
        await store.set(tabId,t);return t;
      });if(saved)schedule(tabId);
    }
    async function changeOrigins(tabId,operation){
      return serial(tabId,async()=>{
        const task=await store.get(tabId);
        if(!task||task.taskId!==operation.taskId||task.scopeRevision!==operation.expectedRevision||['ended','completed'].includes(task.status))throw new Error('任务范围已变化，请刷新后重试');
        let url;try{url=new URL(operation.origin);}catch{throw new Error('请输入完整 HTTP/HTTPS 站点来源');}
        if(!['http:','https:'].includes(url.protocol)||url.origin!==operation.origin||url.username||url.password||url.hostname.includes('*')||!['add','remove'].includes(operation.action)||operation.origin.length>300)throw new Error('站点来源或范围操作无效');
        const exists=(task.allowedOrigins||[task.origin]).includes(operation.origin);
        if(operation.action==='add'&&exists||operation.action==='remove'&&!exists)return task;
        if(operation.action==='add'&&(!tools.hasOriginAccess||!await tools.hasOriginAccess(operation.origin)))throw new Error('请先从任务范围面板授权该网站');
        controllerForTab(tabId)?.abort();await cancelSchedule(tabId);
        return store.changeOrigins(tabId,{...operation,token:uuid(),updatedAt:now()});
      });
    }
    function tabView(tab,allowed){
      let origin=null;try{const url=new URL(tab.url);if(['http:','https:'].includes(url.protocol))origin=url.origin;}catch{ /* Non-web tabs have no origin. */ }
      return {origin,title:String(tab.title||'').slice(0,80),authorized:!!origin&&allowed.includes(origin)};
    }
    // Trusted side-panel directory: current members plus joinable open web tabs. Not sent to the model.
    async function members(tabId,taskId){
      const task=await store.get(tabId);
      if(!task||task.taskId!==taskId)throw new Error('任务已变化，请刷新后重试');
      const tabs=tools.listTabs?await tools.listTabs():[],byId=new Map(tabs.map(tab=>[tab.id,tab])),allowed=task.allowedOrigins||[task.origin];
      const directory=(task.members||[]).map(member=>{const tab=byId.get(member.tabId);return {tabRef:member.tabRef,kind:member.kind,tabId:member.tabId,active:member.tabId===tabId,open:!!tab,...(tab?tabView(tab,allowed):{origin:null,title:'',authorized:false})};});
      const joined=new Set(directory.map(member=>member.tabId)),candidates=[];
      for(const tab of tabs){
        if(joined.has(tab.id)||candidates.length>=50)continue;
        const view=tabView(tab,allowed);if(!view.origin)continue;
        candidates.push({tabId:tab.id,...view,occupied:!!await store.owner(tab.id)});
      }
      return {taskId,membersRevision:task.membersRevision??0,members:directory,candidates};
    }
    async function changeMembers(tabId,operation){
      return serial(tabId,async()=>{
        const task=await store.get(tabId);
        if(!task||task.taskId!==operation.taskId||!Number.isSafeInteger(operation.expectedMembersRevision)||(task.membersRevision??0)!==operation.expectedMembersRevision)throw new Error('任务标签页已变化，请刷新后重试');
        if(operation.action==='join'){
          if(['ended','completed'].includes(task.status))throw new Error('任务已结束，不能加入标签页');
          if(!Number.isInteger(operation.memberTabId)||operation.memberTabId<0||operation.memberTabId===tabId)throw new Error('标签页无效');
          const member=await tools.tab(operation.memberTabId);if(!tabView(member,[]).origin)throw Object.assign(new Error('该页面不支持加入，请选择普通 HTTP/HTTPS 网页'),{code:'UNSUPPORTED_PAGE'});
          return store.changeMembers(tabId,{taskId:task.taskId,expectedMembersRevision:operation.expectedMembersRevision,action:'join',memberTabId:operation.memberTabId,updatedAt:now()});
        }
        if(operation.action==='remove'){
          if(typeof operation.tabRef!=='string'||!/^tab\d{1,3}$/.test(operation.tabRef))throw new Error('标签页标识无效');
          return store.changeMembers(tabId,{taskId:task.taskId,expectedMembersRevision:operation.expectedMembersRevision,action:'remove',tabRef:operation.tabRef,updatedAt:now()});
        }
        throw new Error('成员操作无效');
      });
    }
    async function reviewPermissions(){
      if(!tools.hasOriginAccess)return;
      for(const task of await store.list()){
        if(['ended','completed','stopped','failed'].includes(task.status)||await tools.hasOriginAccess(task.origin))continue;
        controllers.get(task.taskId)?.abort();await cancelSchedule(task.tabId);await scopePause(task,'permission_denied');
      }
    }
    async function start(tabId, goal) {
      if (typeof goal !== 'string' || !goal.trim() || goal.length > 2000) throw new Error('请输入不超过 2000 字的任务');
      const page = await tools.tab(tabId), prefs = await preferences();
      controllerForTab(tabId)?.abort();
      const task = {version:2, taskId:uuid(), token:uuid(), tabId, origin:new URL(page.url).origin, goal:goal.trim(), status:'running', phase:'observe', steps:0, prefs, results:[], events:[], pending:null, updatedAt:Date.now(), retries:0};
      event(task, '任务已开始');
      await serial(tabId, () => store.set(tabId, task)); schedule(tabId); return task;
    }
    async function submit(tabId, text) {
      if(typeof text!=='string'||!text.trim()||text.length>2000)throw new Error('请输入不超过 2000 字的指令');
      const page=await tools.tab(tabId),prefs=await preferences();
      const saved=await serial(tabId,async()=>{
        let task=await store.get(tabId);
        if(task&&!['completed','ended'].includes(task.status)){
          if(!inScope(task))throw new Error('当前网站不在任务授权范围，请先添加后继续');
          if(['scope_changed','permission_denied'].includes(task.reason)&&(task.phase==='executing'||task.check))throw new Error('请先点击继续核对未确定操作，再补充指令');
          if(new URL(page.url).origin!==task.origin)throw new Error('当前任务尚未结束，请回到原站点补充指令，或先结束任务');
          const instructions=(task.instructions||[]).concat({text:text.trim(),time:now()});
          if(JSON.stringify(instructions).length>12000)throw new Error('补充指令已达上下文上限，请结束当前任务后开始新任务；已有指令未删除');
          controllerForTab(tabId)?.abort();
          task.token=uuid();task.nextObservation=null;task.check=null;task.waitDeadline=null;task.recoveryCount=0;task.completionChecks=null;task.completionEvidence=null;task.instructions=instructions;task.memoryReview={pending:true,instructionCount:instructions.length};
          task.question=null;task.helpAttempts=0;task.status='running';task.phase='observe';task.pending=null;task.reason=null;task.retries=0;task.prefs=prefs;
          event(task,'你（补充指令）：'+text.trim());
        }else{
          controllerForTab(tabId)?.abort();
          task={version:2,taskId:uuid(),token:uuid(),tabId,origin:new URL(page.url).origin,goal:text.trim(),instructions:[],status:'running',phase:'observe',steps:0,prefs,results:[],events:[],pending:null,retries:0};
          event(task,'你：'+text.trim());event(task,'任务已开始');
        }
        task.updatedAt=Date.now();await store.set(tabId,task);return task;
      });
      schedule(tabId);return saved;
    }
    async function choose(tabId,taskId,questionId,indices){
      const tab=await tools.tab(tabId);
      const saved=await serial(tabId,async()=>{
        const t=await store.get(tabId),q=t?.question;
        if(!t||!q||t.taskId!==taskId||t.status!=='paused'||t.reason!=='question'||q?.id!==questionId||new URL(tab.url).origin!==t.origin)throw new Error('选项已过期，请重新读取任务');
        if(!Array.isArray(indices)||!indices.length||indices.length>q.options.length||new Set(indices).size!==indices.length||indices.some(i=>!Number.isInteger(i)||i<0||i>=q.options.length))throw new Error('请选择有效选项');
        const text='关于「'+q.text+'」，我的选择：'+indices.map(i=>q.options[i]).join('；');
        const instructions=(t.instructions||[]).concat({text,time:now()});
        if(JSON.stringify(instructions).length>12000)throw new Error('补充指令已达上下文上限');
        controllerForTab(tabId)?.abort();t.token=uuid();t.nextObservation=null;t.instructions=instructions;t.question=null;t.helpAttempts=0;t.status='running';t.reason=null;t.phase='observe';t.pending=null;t.check=null;t.waitDeadline=null;t.retries=0;event(t,'你（补充指令）：'+text);await store.set(tabId,t);return t;
      });schedule(tabId);return saved;
    }
    async function finish(tabId){
      await tools.clearPointer?.(tabId);
      const saved=await serial(tabId,async()=>{
        const task=await store.get(tabId);if(!task)return null;
        controllerForTab(tabId)?.abort();task.token=uuid();task.nextObservation=null;task.check=null;task.waitDeadline=null;task.status='ended';task.phase='idle';task.pending=null;task.updatedAt=now();
        event(task,'用户已结束任务，下次发送将新建任务');await store.set(tabId,task);return task;
      });
      await cancelSchedule(tabId);return saved;
    }
    async function stop(tabId) {
      await tools.clearPointer?.(tabId);
      controllerForTab(tabId)?.abort();
      const task = await store.get(tabId); if (!task) return null;
      const saved = await update(tabId, task.token, t => {t.token=uuid();t.nextObservation=null;t.check=null;t.waitDeadline=null;t.status='stopped';t.pending=null;event(t,'已停止；已发出的网页操作不会自动撤销');});
      await cancelSchedule(tabId); return saved;
    }
    async function takeover(tabId){
      controllerForTab(tabId)?.abort();
      const saved=await serial(tabId,async()=>{
        const t=await store.get(tabId);if(!t||['completed','ended'].includes(t.status))throw new Error('没有可接管的进行中任务');
        const uncertain=t.phase==='executing'?t.pending:null;
        const check=t.check?.kind==='action'?t.check:null;
        if(uncertain||check){const source=uncertain||check;t.uncertainClicks=(t.uncertainClicks||[]).concat({url:source.url,documentId:source.documentId,key:source.targetKey||source.key,target:source.targetDescriptor||source.target}).slice(-2);}
        t.token=uuid();t.status='paused';t.reason='user_takeover';t.phase='observe';t.pending=null;t.check=null;t.waitDeadline=null;t.nextObservation=null;t.question=null;t.contextUsage=null;
        event(t,'用户接管网页；完成手动操作后点击继续，助手将重新观察，未确定动作不会重放');await store.set(tabId,t);return t;
      });
      await tools.clearPointer?.(tabId);await cancelSchedule(tabId);return saved;
    }
    async function resume(tabId) {
      const task = await store.get(tabId); if (!task) throw new Error('没有可继续的任务');
      if(task.status==='ended')throw new Error('任务已手动结束，请输入新目标开始新任务');
      const page=await tools.tab(tabId);
      if(new URL(page.url).origin!==task.origin){const moved=await adoptOrigin(task,page);if(!moved)throw new Error('请核对任务范围和原站点未确定操作后再继续');schedule(tabId);return moved;}
      if(!inScope(task))throw new Error('当前网站不在任务授权范围，请先添加后继续');
      if(tools.hasOriginAccess&&!await tools.hasOriginAccess(task.origin))throw new Error('请先授权当前网站后继续');
      if (ACTIVE.has(task.status)) return task;
      const tab = await tools.tab(tabId);
      if (new URL(tab.url).origin !== task.origin) throw new Error('请回到任务原站点继续，跨站任务尚未支持');
      const prefs = await preferences();
      const saved = await update(tabId, task.token, t => {
        const wasCompleted=t.status==='completed';
        const recovery=['global_memory_changed','scope_reconciled','scope_changed','permission_denied','origin','origin_verification','origin_storage'].includes(t.reason)&&(t.check||t.phase==='executing')?{phase:t.phase,check:t.check,waitDeadline:t.waitDeadline,pending:t.pending}:null;
        t.question=null;t.helpAttempts=0;t.token=uuid();t.nextObservation=null;t.status='running';t.phase='observe';t.pending=null;t.check=null;t.waitDeadline=null;t.recoveryCount=0;t.completionEvidence=null;t.prefs=prefs;t.retries=0;
        if (t.reason==='budget'||wasCompleted) t.steps=0;
        // Explicit continuation grants a new budget when the previous one is exhausted.
        if (prefs.maxSteps && t.steps>=prefs.maxSteps) t.steps=0;
        if(recovery)Object.assign(t,recovery);
        t.reason=null;event(t,'继续任务，重新读取当前页面');
      });
      schedule(tabId); return saved;
    }
    async function approve(tabId, taskId) {
      const task = await store.get(tabId);
      if (!task || task.taskId !== taskId || task.status !== 'waiting_confirmation') throw new Error('没有匹配的待确认操作');
      const saved = await update(tabId, task.token, t => {t.status='running';t.phase='approved';event(t,'用户已确认操作');});
      schedule(tabId); return saved;
    }
    async function pause(task, text, reason = 'error') {
      await update(task.tabId, task.token, t => {t.status=reason==='error'?'failed':'paused';t.reason=reason;t.pending=null;t.check=null;t.waitDeadline=null;event(t,text);});
    }
    async function turn(tabId,expectedTaskId) {
      if(globalEditing)return;
      const epoch=globalEpoch;
      let task = await store.get(tabId); if (!task || task.taskId!==expectedTaskId || !ACTIVE.has(task.status)) return;
      const token=task.token,runningTaskId=task.taskId;
      let call=null;
      const controller = new AbortController(); controllers.set(task.taskId,controller);controllerTasks.set(tabId,task.taskId);
      const live = async () => {
        const permitted=!tools.hasOriginAccess||await tools.hasOriginAccess(task.origin);
        const current = await store.get(tabId);
        return permitted&&!globalEditing && epoch===globalEpoch && !controller.signal.aborted && current?.token===token && ACTIVE.has(current.status)&&inScope(current);
      };
      try {
        const tab = await tools.tab(tabId);
        if(new URL(tab.url).origin!==task.origin){await adoptOrigin(task,tab);return;}
        if(!inScope(task)){await scopePause(task,'scope_changed');return;}
        if(tools.hasOriginAccess&&!await tools.hasOriginAccess(task.origin)){await scopePause(task,'permission_denied');return;}
        if (!await live()) return;
        if(task.check?.kind==='delay'){await delayCheck(task);return;}
        let readySnapshot=null;
        if (tab.status === 'loading') {
          // A tab may keep loading subresources after its DOM is usable. Probe
          // read-only; never treat an old document or pending navigation as ready.
          try {
            const candidate=await tools.observe(tabId,undefined,policyFor(task));
            if(!await live())return;
            if(!tab.pendingUrl&&candidate.url===tab.url&&['interactive','complete'].includes(candidate.readyState))readySnapshot=candidate;
          } catch(error) {
            if(!['NAVIGATION','PAGE_BUSY'].includes(error.code))throw error;
          }
        }
        if (tab.status === 'loading'&&!readySnapshot) {
          const deadline=task.check?.deadline||task.waitDeadline||now()+30000;
          if(now()>=deadline){await pause(task,'页面加载超过等待期限，任务暂停；未重复发送操作','timeout');return;}
          await update(tabId, token, t => {t.status='waiting_page';t.waitDeadline=deadline;if(!t.check&&t.phase!=='executing'){t.phase='observe';t.pending=null;}});return;
        }
        if (task.phase === 'executing') {
          if(task.check?.expected?.length){
            task=await update(tabId,token,t=>{t.phase='verifying';t.status='running';t.pending=null;event(t,'恢复未确定的操作，仅检查预期结果，不重复执行');});
            if(task)await verifyCheck(task,live);return;
          }
          await pause(task,'后台在执行操作期间中断，结果不确定。请检查页面后点击继续，系统不会重放该操作。','uncertain');return;
        }
        if(task.check){await verifyCheck(task,live);return;}
        if (task.phase === 'approved') {
          const pending = task.pending;
          if (!pending || pending.url!==tab.url) {
            await update(tabId,token,t=>{t.phase='observe';t.pending=null;event(t,'页面已变化，旧确认失效，重新规划');});return;
          }
          await execute(task,pending,live);return;
        }
        if (task.prefs.maxSteps && task.steps>=task.prefs.maxSteps) {await pause(task,'达到执行轮数上限，点击继续可开启新预算。','budget');return;}
        const readingScope=task.nextObservation;
        let snap = readingScope?await tools.observe(tabId,readingScope.value,policyFor(task)):readySnapshot||await tools.observe(tabId,undefined,policyFor(task));
        if(!await live())return;
        if(readingScope){
          task=await update(tabId,token,t=>{t.nextObservation=null;});
          if(!task)return;
          if(snap.url!==readingScope.url||snap.documentId!==readingScope.documentId)snap=await tools.observe(tabId,undefined,policyFor(task));
        }
        if (!await live()) return;
        const observedTab=await tools.tab(tabId);
        if(observedTab.url!==snap.url||new URL(snap.url).origin!==task.origin){if(new URL(observedTab.url).origin!==task.origin)await adoptOrigin(task,observedTab);return;}
        const memories=await store.getMemory(tabId,task.origin);
        const durable=siteMemory?await siteMemory.read(task.origin):{version:0,notes:[]};
        if(task.siteMemoryVersion!==undefined&&task.siteMemoryVersion!==durable.version){
          task=await update(tabId,token,t=>{forgetSiteContext(t);t.siteMemoryVersion=durable.version;});
          if(!task||!await live())return;
        }
        const shared=await getGlobalMemoryOrEmpty();
        if(task.globalMemoryVersion!==undefined&&task.globalMemoryVersion!==shared.version){
          task=await update(tabId,token,t=>{forgetGlobalContext(t);t.globalMemoryVersion=shared.version;});
          if(!task||!await live())return;
        }
        const globalMemoryIndex=shared.notes.map(n=>({id:n.id,updatedAt:n.updatedAt,source:n.source}));
        const siteMemoryIndex=durable.notes.map(n=>({id:n.id,updatedAt:n.updatedAt,source:n.source}));
        const modelIdentity=await identity();
        if(!await live())return;
        const page={...snap.page,url:snap.url,documentId:snap.documentId};
        const memoryIndex=memories.map(m=>({id:m.id,updatedAt:m.updatedAt}));
        const currentPayload=P.agentInput(task,page,memoryIndex,siteMemoryIndex,globalMemoryIndex);
        const pressure=P.pressure(task,currentPayload,modelIdentity);
        const history=task.results||[];
        const afterCompact=task.compactionGuard;
        if(afterCompact&&pressure.tokens>=pressure.trigger){
          await pause(task,'整理后上下文仍接近预算，已暂停避免重复压缩；请检查模型窗口设置或缩小当前页面','context');return;
        }
        if(pressure.tokens>=pressure.trigger&&history.length>6){
          // Keep at least six recent results, extending the tail up to 20% of input budget.
          let cut=history.length-6,tailTokens=P.estimateTokens(JSON.stringify(history.slice(cut)));
          while(cut>0){const cost=P.estimateTokens(JSON.stringify(history[cut-1]));if(tailTokens+cost>pressure.budget*0.20)break;tailTokens+=cost;cut--;}
          // Small result histories should not prevent reclaiming a genuinely large prefix.
          if(cut===0)cut=Math.max(0,history.length-6);
          const older=history.slice(0,cut);
          if(!older.length){await pause(task,'当前页面和受保护上下文已接近预算，无法继续压缩','context');return;}
          const from=(task.contextSummary?.through||task.contextArchive?.at(-1)?.to||0)+1;
          const archive={origin:task.origin,tabRef:'tab0',id:'h'+from,from,to:from+older.length-1,results:older};
          const archives=(task.contextArchive||[]).concat(archive);
          if(JSON.stringify(archives).length>1000000){await pause(task,'任务历史归档达到 100 万字符上限，请结束任务；原记录已保留','context');return;}
          const input=JSON.stringify({goal:task.goal,instructions:task.instructions||[],previousSummary:task.contextSummary?.content||null,archiveId:archive.id,olderResults:older.map(r=>{
            if(['memory_read','site_memory_read','global_memory_read'].includes(r.action))return {action:r.action,result:'Memory bodies omitted; read again if needed'};
            const raw=JSON.stringify(r);return raw.length<=4000?r:{action:r.action,label:r.label,truncated:true,archiveId:archive.id,excerpt:raw.slice(0,2000)+' [middle omitted; recover with history_read] '+raw.slice(-1000)};
          })});
          if(input.length>1000000||P.estimateTokens(input)+P.estimateTokens(P.summarySystem('简体中文'))>pressure.budget*0.9){await pause(task,'待整理记录超过摘要预算，原始记录已保留；请增加上下文窗口或结束任务','context');return;}
          task=await update(tabId,token,t=>{t.phase='compacting';t.steps++;event(t,'上下文接近预算，正在整理旧记录并保留近期完整结果');});
          if(!task||!await live())return;
          try{
            if(!summarize)throw new Error('摘要服务不可用');
            const response=await measured(task,'summary',()=>summarize(input,controller.signal),live);
            if(!await live())return;
            const content=P.parseSummary(response.text);
            await update(tabId,token,t=>{
              const through=archive.to;
              t.contextSummary={content,through,updatedAt:now()};t.contextArchive=archives;t.contextUsage=null;t.compactionGuard=true;t.results=t.results.slice(older.length);t.phase='observe';t.retries=0;
              event(t,'任务摘要已更新，较早过程不再发送给执行模型');
            });
          }catch(error){
            if(await live())await pause(task,'上下文整理失败，原始记录已保留；可点击继续重试：'+error.message,'context');
          }
          return;
        }
        if(pressure.tokens>=pressure.trigger){await pause(task,'当前页面和受保护内容已接近上下文预算，无法压缩；请检查窗口设置或缩小页面','context');return;}
        task = await update(tabId,token,t=>{t.status='running';t.phase='thinking';t.siteMemoryVersion=durable.version;t.globalMemoryVersion=shared.version;t.steps++;t.pending=null;t.waitDeadline=null;t.metrics={...t.metrics,observations:(t.metrics?.observations||0)+1};});
        if (!task || !await live()) return;
        const payload = P.agentInput(task,page,memoryIndex,siteMemoryIndex,globalMemoryIndex);
        const sentEstimate=P.pressure(task,payload).estimatedTokens;
        const result = await measured(task,'model',()=>model(payload,controller.signal),live);
        if (!await live()) return;
        task=await update(tabId,token,t=>{t.compactionGuard=false;t.contextPressure=pressure;
          t.contextUsage=result.usage&&Number.isSafeInteger(result.usage.promptTokens)?{...result.usage,estimatedTokens:sentEstimate,modelIdentity:result.modelIdentity||modelIdentity}:null;
        });
        if(!task||!await live())return;
        const current = await tools.tab(tabId);
        if (!await live()) return;
        if (current.url!==snap.url) {await update(tabId,token,t=>{t.phase='observe';event(t,'页面已跳转，丢弃旧回复');});return;}
        if((await getGlobalMemoryOrEmpty()).version!==shared.version){
          if(await live())await update(tabId,token,t=>{forgetGlobalContext(t);t.phase='observe';event(t,'全局长期记忆已更新，丢弃旧回复并重新读取');});return;
        }
        if(siteMemory&&(await siteMemory.read(task.origin)).version!==durable.version){
          if(await live())await update(tabId,token,t=>{forgetSiteContext(t);t.phase='observe';event(t,'网站长期记忆已在其他任务更新，丢弃旧回复并重新读取');});return;
        }
        if(!await live())return;
        const plan = C.agentPlan(result.text, {nodes:new Map(snap.page.elements.map(e=>[e.id,true]))});
        if(plan.subgoals!==undefined){
          const updates=plan.subgoals.map(g=>{
            const checks=g.checks?G.bind(g.checks,snap):[],verification=checks.length?G.evaluate(checks,snap):null;
            return {id:g.id,title:g.title,status:g.status==='completed'&&verification?.status!=='success'?'active':g.status,verification,updatedAt:now(),documentId:snap.documentId||null,url:snap.url};
          });
          const merged=plan.subgoals.length?(task.taskPlan||[]).filter(g=>!updates.some(u=>u.id===g.id)).concat(updates):[];
          if(merged.length>8)throw new Error('子目标总数超过 8 项，请先用空列表清空后重列');
          task=await update(tabId,token,t=>{t.taskPlan=merged;});if(!task||!await live())return;
        }
        if(!['done','pause'].includes(plan.action))call={request:plan,time:Date.now()};
        if(plan.action==='pause'){
          if(plan.choices){await update(tabId,token,t=>{t.status='paused';t.reason='question';t.pending=null;t.check=null;t.waitDeadline=null;t.question={id:uuid(),text:plan.reply,options:plan.choices};event(t,plan.reply);});return;}
          if(plan.pauseReason!=='user'&&(task.helpAttempts||0)<3){
            await update(tabId,token,t=>{t.helpAttempts=(t.helpAttempts||0)+1;t.phase='observe';t.results=t.results.concat({action:'replan',result:'尚未解决：'+plan.reply+'。请改用其他通用方法探索；禁止重复结果不确定的操作。自主恢复 '+t.helpAttempts+'/3'});event(t,'正在尝试其他方法（'+t.helpAttempts+'/3）');});return;
          }
          await pause(task,plan.reply,'model');return;
        }
        if(plan.action==='history_read'){
          const archive=task.contextArchive?.find(a=>a.id===plan.id),offset=plan.value||0;
          const text=archive?JSON.stringify(archive.results):null;
          const result=text?{id:archive.id,offset,text:text.slice(offset,offset+4000),nextOffset:offset+4000<text.length?offset+4000:null}:{error:'历史归档不存在'};
          await update(tabId,token,t=>{t.phase='observe';t.results=t.results.concat({...call,action:'history_read',result});event(t,'读取任务历史：'+plan.id);});return;
        }
        if(plan.action.startsWith('global_memory_')){await globalMemoryAction(task,plan,shared.version,controller.signal);return;}
        if(plan.action.startsWith('site_memory_')){await siteMemoryAction(task,plan,durable.version,controller.signal);return;}
        if(plan.action.startsWith('memory_')){await memoryAction(task,plan);return;}
        if(plan.action==='observe'){
          if(plan.value&&typeof plan.value==='object'){
            await update(tabId,token,t=>{t.phase='observe';t.nextObservation={value:plan.value,url:snap.url,documentId:snap.documentId};t.results=t.results.concat({...call,action:'observe',outcome:T.result({status:'success',scope:'dispatch',code:'READ_SCOPE_SET',message:'下一轮重新读取指定控件范围'})});});return;
          }
          const reading=plan.value===undefined?null:await tools.observe(tabId,plan.value,policyFor(task));
          if(!await live())return;
          if(reading&&(reading.url!==snap.url||snap.documentId&&reading.documentId!==snap.documentId)){await update(tabId,token,t=>{t.phase='observe';});return;}
          await update(tabId,token,t=>{t.phase='observe';t.results=t.results.concat({...call,action:'observe',result:reading?{text:reading.page.text,textRange:reading.page.textRange,untrusted:true}:undefined,outcome:T.result({status:'success',scope:'page',code:'PAGE_OBSERVED',documentId:snap.documentId,message:'当前页面已读取'})});});return;
        }
        if(plan.action==='wait'&&!plan.expected){
          task=await update(tabId,token,t=>{t.phase='verifying';t.status='waiting_page';t.check={operationId:uuid(),expected:[],deadline:now()+plan.timeoutMs,kind:'delay',request:plan,time:call.time};event(t,plan.reply);});
          return;
        }
        if(['wait','verify'].includes(plan.action)){
          const expected=G.bind(plan.expected,snap);
          task=await update(tabId,token,t=>{t.phase='verifying';t.recoveryCount=0;t.check={operationId:uuid(),expected,deadline:now()+(plan.action==='verify'?0:plan.timeoutMs||10000),kind:plan.action,request:plan,time:call.time};event(t,plan.reply);});
          if(task&&await live())await verifyCheck(task,live);return;
        }
        if (plan.action==='done') {
          const expected=plan.expected?G.bind(plan.expected,snap):task.completionChecks;
          if(expected?.length){
            task=await update(tabId,token,t=>{t.completionChecks=expected;t.phase='verifying';t.check={operationId:uuid(),expected,deadline:now(),kind:'completion',reply:plan.reply};});
            if(task&&await live())await verifyCheck(task,live);return;
          }
          await update(tabId,token,t=>{t.status='completed';t.phase='idle';t.completionEvidence='model_reported';event(t,plan.reply);event(t,'模型报告完成；未提供可执行的任务完成条件');});return;
        }
        const target = snap.page.elements.find(e=>e.id===plan.id);
        const combined=[...plan.expected||[]];
        for(const c of G.automatic(plan))if(!combined.some(e=>e.kind===c.kind&&e.id===c.id&&e.value===c.value))combined.push(c);
        if(plan.action==='navigate'){
          const destination=new URL(plan.value).origin;
          if(!(task.allowedOrigins||[task.origin]).includes(destination))throw Object.assign(new Error('导航目标未加入任务授权范围'),{code:'NAVIGATION_DENIED'});
          if(tools.hasOriginAccess&&!await tools.hasOriginAccess(destination))throw Object.assign(new Error('导航目标缺少网站权限'),{code:'PERMISSION_DENIED'});
          if(destination!==task.origin&&combined.some(condition=>!condition.kind.startsWith('url_')))throw Object.assign(new Error('跨站导航只支持 URL 条件核对，不能使用旧站点 DOM 条件'),{code:'NAVIGATION_DENIED'});
        }
        const expected=G.bind(combined,snap,plan.action==='navigate'?{allowedOrigins:task.allowedOrigins||[task.origin]}:null);
        for(const guard of C.agentTool(plan.action).guard?(task.uncertainClicks||[]):[]){
          const sameTarget=target&&(guard.key?guard.key===target.key:JSON.stringify(guard.target)===JSON.stringify(G.descriptor(target,snap.page)));
          if(guard.url===snap.url&&guard.documentId===snap.documentId&&sameTarget){
            await pause(task,'该点击的结果仍不确定，已阻止重复点击同一目标；请核实当前状态或选择新的确认控件','uncertain');return;
          }
        }
        const pending={tabId,origin:task.origin,scopeRevision:task.scopeRevision,targetKey:target?.key,targetDescriptor:target?G.descriptor(target,snap.page):null,plan,snapshotId:snap.snapshotId,documentId:snap.documentId,url:snap.url,label:target?.label||plan.action,operationId:uuid(),expected,time:call.time};
        task = await update(tabId,token,t=>{t.pending=pending;t.retries=0;event(t,plan.reply);const notice=plan.notice||(/提交|删除|支付|购买|发布|发送|确认订单|submit|delete|pay|purchase|publish|send/i.test(pending.label)?'即将执行：'+pending.label:null);if(notice){t.notice=notice;event(t,'重要操作：'+notice);}});
        if (!task || !await live()) return;
        await execute(task,pending,live);
      } catch (error) {
        if (!await live()) return;
        await update(tabId,token,t=>{t.lastOutcome=error.result||T.failure(error,call?{}:{dispatch:'not_sent'});if(call)t.results=t.results.concat({...call,action:call.request.action,label:t.pending?.label,outcome:t.lastOutcome,result:t.lastOutcome.message});});
        if(!await live())return;
        if (['STALE','TARGET_BLOCKED'].includes(error.code)) {
          if((task.recoveryCount||0)>=2){await pause(task,'连续目标失效，已达到重新定位上限','recovery');return;}
          await update(tabId,token,t=>{t.recoveryCount=(t.recoveryCount||0)+1;t.phase='observe';t.pending=null;t.check=null;event(t,'目标已变化，重新读取后规划');});
        } else if (['NAVIGATION','PAGE_BUSY'].includes(error.code)) {
          const deadline=task.check?.deadline||task.waitDeadline||now()+30000;
          if(now()>=deadline){await pause(task,'页面连接或忙碌等待超时，未重复操作','timeout');return;}
          await update(tabId,token,t=>{t.status='waiting_page';t.waitDeadline=deadline;t.pending=null;t.phase=t.check?'verifying':'observe';event(t,'正在等待页面加载或上一操作结束，随后重新读取');});
        } else if (['INPUT_CANCELLED','INVALID_FIELD_VALUE','UNSUPPORTED_EDITABLE'].includes(error.code))await pause(task,error.message,'input');
        else if (/API (?:网络|请求超时|429|5\d\d)/.test(error.message)&&task.retries<2) {
          await update(tabId,token,t=>{t.retries++;t.phase='observe';event(t,'模型暂时不可用，稍后重试（'+t.retries+'/2）');});
        } else if(error.code==='ORIGIN_BOUNDARY')await scopePause(task,'origin','页面来源已改变，未读取新来源内容；请核对范围后继续');
        else if(['PERMISSION_DENIED','UNSUPPORTED_PAGE','TAB_CLOSED'].includes(error.code))await pause(task,error.message,'access');
        else await pause(task, error.message || '任务失败，请检查页面与配置');
      } finally {
        if(controllers.get(runningTaskId)===controller){controllers.delete(runningTaskId);if(controllerTasks.get(tabId)===runningTaskId)controllerTasks.delete(tabId);}
      }
    }
    async function delayCheck(task){
      await update(task.tabId,task.token,t=>{
        const check=t.check;
        if(check?.kind!=='delay')return;
        const elapsed=now()>=check.deadline;
        const outcome=T.result({operationId:check.operationId,status:elapsed?'success':'pending',dispatch:'not_sent',scope:'dispatch',code:elapsed?'DELAY_ELAPSED':'WAITING_DELAY',recovery:elapsed?'observe':'wait',message:elapsed?'延时结束；重新读取页面后继续':'正在等待指定时长'});
        t.lastOutcome=outcome;
        if(!elapsed){t.status='waiting_page';return;}
        t.results=t.results.concat({action:'wait',request:check.request,time:check.time,outcome,result:outcome.message});
        t.check=null;t.waitDeadline=null;t.phase='observe';t.status='running';
        event(t,'延时结束，重新读取页面后继续；不代表网页操作成功');
      });
    }
    async function verifyCheck(task,live){
      const check=task.check;if(!check)return;
      await update(task.tabId,task.token,t=>{t.metrics={...t.metrics,verifications:(t.metrics?.verifications||0)+1};});
      if(!await live())return;
      let outcome;
      if(tools.verify)outcome=T.normalize(await tools.verify(task.tabId,check,policyFor(task)));
      else{
        const snap=await tools.observe(task.tabId,undefined,policyFor(task));const evaluated=G.evaluate(check.expected,snap);
        outcome=T.result({...evaluated,scope:'page',code:evaluated.status==='success'?'CONDITIONS_MATCH':'CONDITIONS_UNMET'});
      }
      if(!await live())return;
      await update(task.tabId,task.token,t=>{
        const expired=now()>=check.deadline;
        const pending=outcome.status!=='success'&&!expired;
        const reobserve=expired&&outcome.status==='unknown'&&check.kind==='action'&&check.action==='click'&&(t.verificationRecoveries||0)<2;
        const finalOutcome=T.result({...outcome,operationId:check.operationId,dispatch:check.kind==='action'?(check.dispatch||'unknown'):outcome.dispatch,status:pending?'pending':outcome.status,recovery:pending?'wait':outcome.status==='success'?'none':reobserve?'replan':'pause',
          code:pending?'WAITING_CONDITIONS':outcome.status==='success'?'CONDITIONS_MATCH':expired&&!['verify','completion'].includes(check.kind)?'CONDITION_TIMEOUT':outcome.code});
        t.lastOutcome=finalOutcome;
        if(pending){t.status='waiting_page';t.phase='verifying';return;}
        t.check=null;t.waitDeadline=null;t.phase='observe';t.recoveryCount=0;
        t.results=t.results.concat({action:check.action||check.kind,origin:t.origin,tabRef:'tab0',request:check.request,time:check.time||Date.now(),outcome:finalOutcome,result:finalOutcome.message});
        if(reobserve){
          t.verificationRecoveries=(t.verificationRecoveries||0)+1;
          t.uncertainClicks=(t.uncertainClicks||[]).concat({url:check.url,documentId:check.documentId,key:check.key,target:check.target}).slice(-2);
          t.status='running';event(t,'原预期目标无法核对，重新读取当前页面规划（'+t.verificationRecoveries+'/2）；不重发原点击');
        }else if(outcome.status==='success'){
          t.verificationRecoveries=0;
          if(check.kind==='completion'){t.status='completed';t.phase='idle';t.completionEvidence='verified';event(t,check.reply);}
          else{t.status='running';event(t,'预期条件已核实，继续任务');}
        }else if(check.kind==='verify'){
          t.status='running';event(t,'验证未满足或结果未知，交给模型重新规划');
        }else{
          t.status='paused';t.reason='verification';event(t,'等待期限内未核实预期结果，已暂停；未重复发送原操作');
        }
      });
    }
    async function memoryAction(task,plan){
      await serial(task.tabId,async()=>{
        const t=await store.get(task.tabId);if(t?.token!==task.token||!ACTIVE.has(t.status))return;
        let entries=await store.getMemory(t.tabId,t.origin),result;
        if(plan.action==='memory_read')result={entries};
        else if(plan.action==='memory_write'){
          const next=entries.filter(m=>m.id!==plan.id).concat({id:plan.id,text:plan.value,updatedAt:Date.now()});
          if(next.length>12||JSON.stringify(next).length>8000)result={error:'临时记忆容量已满，请先删除或压缩其他条目'};
          else{await store.setMemory(t.tabId,t.origin,next);result={saved:plan.id};t.memoryReview=null;}
        }else if(plan.action==='memory_delete'){
          await store.setMemory(t.tabId,t.origin,entries.filter(m=>m.id!==plan.id));result={deleted:plan.id};
          forgetPlanContext(t);t.contextSummary=null;t.contextUsage=null;t.compactionGuard=false;t.contextArchive=(t.contextArchive||[]).map(a=>({...a,results:a.results.filter(r=>!r.action?.startsWith('memory_')&&r.action!=='history_read')}));t.results=t.results.filter(r=>!r.action?.startsWith('memory_')&&r.action!=='history_read');
        }else{
          await store.setMemory(t.tabId,t.origin,[]);result={cleared:true};forgetPlanContext(t);t.contextSummary=null;t.contextUsage=null;t.compactionGuard=false;t.contextArchive=(t.contextArchive||[]).map(a=>({...a,results:a.results.filter(r=>!r.action?.startsWith('memory_')&&r.action!=='history_read')}));t.results=t.results.filter(r=>!r.action?.startsWith('memory_')&&r.action!=='history_read');
        }
        t.phase='observe';t.pending=null;t.retries=0;
        t.results=t.results.concat({origin:t.origin,tabRef:'tab0',action:plan.action,result});event(t,'临时记忆：'+plan.action+' · '+plan.reply);
        await store.set(t.tabId,t);
      });
    }
    async function diagnostics(tabId,taskId){
      const tab=await tools.tab(tabId),task=await store.get(tabId);
      if(!task||task.taskId!==taskId||new URL(tab.url).origin!==task.origin)throw new Error('任务或网站已变化，请刷新后再导出');
      const count=value=>Number.isSafeInteger(value)&&value>=0?value:0;
      const pick=(value,allowed)=>allowed.includes(value)?value:'unknown';
      const timings={};
      for(const kind of ['model','summary','tool']){
        const value=task.metrics?.timings?.[kind];if(!value)continue;
        timings[kind]=Object.fromEntries(['attempts','completed','failed','totalMs'].map(k=>[k,count(value[k])]));
        timings[kind].lastMs=value.lastMs===null?null:count(value.lastMs);
      }
      const outcomes={statuses:{},dispatches:{},actions:{}};
      const tally=entry=>{
        if(C.agentTool(entry.action))outcomes.actions[entry.action]=(outcomes.actions[entry.action]||0)+1;
        if(entry.outcome){const status=pick(entry.outcome.status,['success','not_satisfied','pending','unknown','unsupported','error']),dispatch=pick(entry.outcome.dispatch,['sent','not_sent','unknown']);outcomes.statuses[status]=(outcomes.statuses[status]||0)+1;outcomes.dispatches[dispatch]=(outcomes.dispatches[dispatch]||0)+1;}
      };
      for(const archive of task.contextArchive||[])for(const entry of archive.results||[])tally(entry);
      for(const entry of task.results||[])tally(entry);
      return {schema:'page-agent-diagnostics',version:1,generatedAt:now(),scope:'current_task_statistics',status:pick(task.status,['running','waiting_page','waiting_confirmation','paused','stopped','failed','completed','ended']),phase:pick(task.phase,['observe','thinking','executing','verifying','compacting','idle','confirm','approved']),steps:count(task.steps),maxSteps:count(task.prefs?.maxSteps),counts:{observations:count(task.metrics?.observations),actions:count(task.metrics?.actions),verifications:count(task.metrics?.verifications)},timings,outcomes};
    }
    async function getMemory(tabId){const tab=await tools.tab(tabId);return store.getMemory(tabId,new URL(tab.url).origin);}
    async function clearMemory(tabId){
      const tab=await tools.tab(tabId),origin=new URL(tab.url).origin;
      await serial(tabId,async()=>{
        await store.setMemory(tabId,origin,[]);
        const task=await store.get(tabId);
        if(task?.origin===origin){
          controllerForTab(tabId)?.abort();task.token=uuid();task.nextObservation=null;forgetPlanContext(task);task.memoryReview=null;task.check=null;task.waitDeadline=null;task.contextSummary=null;task.contextUsage=null;task.compactionGuard=false;task.contextArchive=(task.contextArchive||[]).map(a=>({...a,results:a.results.filter(r=>!r.action?.startsWith('memory_')&&r.action!=='history_read')}));task.results=task.results.filter(r=>!r.action?.startsWith('memory_')&&r.action!=='history_read');task.pending=null;
          if(!['completed','ended','stopped','failed'].includes(task.status)){task.status='paused';task.reason='memory_cleared';}
          task.phase='observe';event(task,'用户已清空临时记忆；继续任务将重新读取');await store.set(tabId,task);
        }
      });
      return [];
    }
    async function execute(task, pending, live) {
      // Checkpoint BEFORE emitting a side effect. On worker restart this phase
      // pauses for inspection rather than silently duplicating a click.
      await update(task.tabId,task.token,t=>{t.phase='executing';t.metrics={...t.metrics,actions:(t.metrics?.actions||0)+1};
        t.check=pending.expected?.length?{tabId:task.tabId,origin:task.origin,scopeRevision:task.scopeRevision,operationId:pending.operationId,expected:pending.expected,deadline:now()+(pending.plan.timeoutMs||10000),kind:'action',dispatch:'unknown',action:pending.plan.action,request:pending.plan,time:pending.time,url:pending.url,documentId:pending.documentId,key:pending.targetKey,target:pending.targetDescriptor}:null;
      });
      if (!await live()) return;
      const result = T.normalize(await measured(task,'tool',()=>tools.execute(task.tabId,pending,policyFor(task),live),live),{operationId:pending.operationId,documentId:pending.documentId});
      if (!await live()) return;
      await update(task.tabId,task.token,t=>{
        t.pending=null;t.phase='observe';t.status=result.navigation?'waiting_page':'running';t.lastOutcome=result;
        if(t.check)t.check.dispatch=result.dispatch;
        if(result.status==='success'){t.check=null;t.waitDeadline=null;t.recoveryCount=0;}
        else if(t.check){t.phase='verifying';t.status='waiting_page';}
        const entry={request:pending.plan,time:pending.time||Date.now(),action:pending.plan.action,label:pending.label,result:result.message||'操作已发出，下一轮检查页面',outcome:result,verification:result.verification,connection:result.connection};
        t.results=t.results.concat(entry);event(t,entry.result);
        if(result.legacy&&result.verification?.verified===false){t.status='paused';t.reason='verification';t.check=null;event(t,'字段结果尚未核实，已暂停，不能声称按指定答案完成');}
        if(t.results.length>=3&&t.results.slice(-3).every(r=>r.outcome?.code==='NO_CHANGE'&&r.label===entry.label&&r.action===entry.action)){
          t.status='paused';t.reason='no_progress';event(t,'连续三次未观察到进展，已暂停，请检查页面');
        }
      });
    }
    async function tick(tabId,expectedTaskId){
      const initial=await store.get(tabId);if(!initial||expectedTaskId&&initial.taskId!==expectedTaskId)return;
      const taskId=initial.taskId;if(jobs.has(taskId))return jobs.get(taskId);
      const job=turn(tabId,taskId);jobs.set(taskId,job);
      try{await job;}finally{
        if(jobs.get(taskId)===job)jobs.delete(taskId);
        const task=await store.get(tabId);
        if(task&&ACTIVE.has(task.status))schedule(tabId,task.retries?2000:task.status==='waiting_page'?1000:100);
        else {await tools.clearPointer?.(tabId);await cancelSchedule(tabId);}
      }
    }
    async function memberClosed(tabId){
      // Abort synchronously before waiting for storage or a running update.
      controllerForTab(tabId)?.abort();
      const owner=store.owner?await store.owner(tabId):null;
      if(owner?.role==='member'){
        // A joined, non-executing member only leaves the directory; the task keeps running.
        await store.removeMemory(tabId);if(owner.taskTabId===null)return null;
        return serial(owner.taskTabId,()=>store.changeMembers(owner.taskTabId,{taskId:owner.taskId,action:'closed',memberTabId:tabId,updatedAt:now()}));
      }
      return serial(tabId,async()=>{
        const task=await store.get(tabId);
        await cancelSchedule(tabId);
        if(!task){await store.removeMemory(tabId);return null;}
        controllers.get(task.taskId)?.abort();
        return store.closeMember(tabId,task.taskId,now());
      });
    }
    async function remove(tabId) {controllerForTab(tabId)?.abort();await stop(tabId);await serial(tabId,async()=>{await store.remove(tabId);await store.removeMemory(tabId);});}
    async function recover() {
      // Missing tabs can have closed while the worker was unavailable. Query failure
      // propagates: absence must be proven, never inferred from a page access error.
      const existing=tools.existingTabIds?new Set(await tools.existingTabIds()):null;
      for(const task of await store.list()){
        if(existing&&!existing.has(task.tabId)){await memberClosed(task.tabId);continue;}
        if(existing)for(const member of task.members||[])if(member.kind==='user_joined'&&!existing.has(member.tabId))await memberClosed(member.tabId);
        if(ACTIVE.has(task.status))schedule(task.tabId);
      }
    }
    return {start,submit,choose,finish,stop,takeover,resume,approve,tick,recover,remove,memberClosed,changeOrigins,members,changeMembers,reviewPermissions,navigationChanged,diagnostics,getMemory,clearMemory,getSiteMemory,editSiteMemory,getGlobalMemory,editGlobalMemory,get:tabId=>store.get(tabId)};
  }
  const api={createRuntime,recent};root.PageAgentRuntime=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
