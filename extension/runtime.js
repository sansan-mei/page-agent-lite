(function (root) {
  'use strict';
  const C = typeof module !== 'undefined' ? require('./core.js') : root.PageAgentCore;
  const P = typeof module !== 'undefined' ? require('./prompts.js') : root.PageAgentPrompts;
  const T = typeof module !== 'undefined' ? require('./tool-protocol.js') : root.PageAgentProtocol;
  const G = typeof module !== 'undefined' ? require('./conditions.js') : root.PageAgentConditions;
  const originOf=tab=>{const url=new URL(tab.url);return ['http:','https:'].includes(url.protocol)?url.origin:'browser';};
  const ACTIVE = new Set(['running', 'waiting_page']);
  const refOf=t=>(t.members||[]).find(member=>member.tabId===t.tabId)?.tabRef||'tab0';
  const S = typeof module !== 'undefined' ? require('./script-tools.js') : root.PageAgentScriptTools;
  // A run_script that never reached the page: rejected, stale or discarded before dispatch.
  function scriptEntry(t,pending,code,message,recovery='observe',time=Date.now()){
    return {request:pending.plan,time,action:'run_script',label:'run_script',origin:t.origin,tabRef:refOf(t),result:message,
      outcome:T.result({operationId:pending.operationId,documentId:pending.documentId,status:'error',dispatch:'not_sent',scope:'dispatch',code,recovery,message})};
  }
  // Drops a pending approval (or an approved run not yet dispatched); it is recorded as not run, never replayed.
  function discardScript(t,message,time=Date.now()){
    const pending=t.scriptRequest?.pending||(t.phase==='approved'&&t.pending?.plan?.action==='run_script'?t.pending:null);
    if(!pending)return false;
    t.results=(t.results||[]).concat(scriptEntry(t,pending,'SCRIPT_DISCARDED',message,'observe',time));
    t.scriptRequest=null;if(t.phase==='approved'){t.phase='observe';t.pending=null;}
    t.events=recent((t.events||[]).concat({time,text:message}),40,16000);return true;
  }
  function recent(items, count = 12, size = 10000) {
    const next = items.slice(-count);
    while (JSON.stringify(next).length > size) next.shift();
    return next;
  }
  function createRuntime({store, tools, siteMemory=null, globalMemory=null, model, summarize, review=null, siteSkills=null, identity=async()=>null, protocol=async()=>'json', scriptAccess=async()=>({permission:false,api:false,available:false}), preferences, schedule, cancelSchedule, uuid = () => crypto.randomUUID(), now = () => Date.now()}) {
    let globalEpoch=0,globalEditing=false,globalEditQueue=Promise.resolve();
    const locks=new Map(),bindingLocks=new Map(),jobs=new Map(),controllers=new Map(),controllerTasks=new Map(),detachedReviews=new Set();
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
        const existing=new Set(task.results||[]);fn(task);task.results=(task.results||[]).map(entry=>existing.has(entry)||entry.origin?entry:{...entry,origin:task.origin,tabRef:refOf(task)}); task.version=task.version===3?3:2;task.updatedAt = now(); await store.set(tabId, task); return task;
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
    // A finished task earns one memory review request when it did page work or received user corrections.
    const pageWork=t=>(t.results||[]).concat(...(t.contextArchive||[]).map(a=>a.results||[])).some(r=>C.agentTool(r.action)?.effect==='page'||r.action==='run_script');
    function markReview(t){t.reviewState=review&&(t.instructions?.length||pageWork(t)||t.contextSummary)&&!(t.prefs?.maxSteps&&t.steps>=t.prefs.maxSteps)?'pending':null;}
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
        t.phase='observe';t.pending=null;t.results=t.results.concat({origin:t.origin,tabRef:refOf(t),request:plan.action.endsWith('_read')?plan:withoutSubgoals(plan),time:now(),action:plan.action,result});event(t,'全局长期记忆：'+plan.action+(result.error?' · '+result.error:' · 已完成'));await store.set(t.tabId,t);
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
        t.phase='observe';t.pending=null;t.results=t.results.concat({origin:t.origin,tabRef:refOf(t),request:plan.action.endsWith('_read')?plan:withoutSubgoals(plan),time:Date.now(),action:plan.action,result});event(t,'网站长期记忆：'+plan.action+(result.error?' · '+result.error:' · 已完成'));await store.set(t.tabId,t);
      });
    }
    // Skills are written only by the task review or deleted by the user; the agent can only read them.
    async function siteSkillRead(task,plan,signal){
      await serial(task.tabId,async()=>{
        const t=await store.get(task.tabId);if(t?.token!==task.token||signal.aborted||!ACTIVE.has(t.status))return;
        let result;
        try{
          if(!siteSkills||t.origin==='browser')throw new Error('当前页面没有网站技能');
          const current=await siteSkills.read(t.origin),skill=current.notes.find(n=>n.id===plan.id);
          result=skill?{version:current.version,skill:{id:skill.id,description:skill.description,text:skill.text,updatedAt:skill.updatedAt}}:{version:current.version,error:'没有此网站技能'};
        }catch(e){result={error:e.message,code:e.code||'SITE_SKILL_ERROR'};}
        if(signal.aborted)return;
        t.phase='observe';t.pending=null;t.results=t.results.concat({origin:t.origin,tabRef:refOf(t),request:plan,time:now(),action:plan.action,result});event(t,'网站技能：读取 '+plan.id+(result.error?' · '+result.error:''));await store.set(t.tabId,t);
      });
    }
    async function getSiteSkills(tabId){
      const tab=await tools.tab(tabId),origin=new URL(tab.url).origin;
      if(!siteSkills)throw new Error('网站技能服务不可用，请重新加载扩展');
      return siteSkills.read(origin);
    }
    async function editSiteSkills(tabId,operation){
      const tab=await tools.tab(tabId),origin=new URL(tab.url).origin;
      if(operation.origin!==origin)throw new Error('网页已切换，请刷新网站技能后重试');
      if(!siteSkills)throw new Error('网站技能服务不可用，请重新加载扩展');
      if(!['delete','clear'].includes(operation.action))throw new Error('网站技能只能删除或清空');
      return siteSkills.change(origin,{action:operation.action,id:operation.id,expectedVersion:operation.expectedVersion,source:'user'});
    }
    const policyFor=t=>({origin:t.origin,allowedOrigins:t.allowedOrigins||[t.origin],scopeRevision:t.scopeRevision,sensitiveFields:t.sensitiveAccess==='allowed'});
    const inScope=t=>t.origin==='browser'||(t.allowedOrigins||[t.origin]).includes(t.origin);
    async function scopePause(task,reason,message=null){
      controllerForTab(task.tabId)?.abort();
      return update(task.tabId,task.token,t=>{t.token=uuid();t.status='paused';t.reason=reason;t.nextObservation=null;t.contextUsage=null;event(t,message||(reason==='permission_denied'?'浏览器网站权限已撤销，任务暂停；已发出的操作不会撤销或重做。':'当前网站已不在任务授权范围，任务暂停。'));});
    }
    async function adoptOrigin(task,tab){
      const origin=new URL(tab.url).origin;
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
        const t=await store.get(tabId);
        if(t?.scriptRequest&&!ACTIVE.has(t.status)){t.token=uuid();discardScript(t,'页面已变化，待批准的脚本已作废，未执行；点击继续重新观察',now());t.reason='script_stale';t.updatedAt=now();await store.set(tabId,t);return null;}
        if(!t||!ACTIVE.has(t.status))return null;
        controllerForTab(tabId)?.abort();t.token=uuid();t.nextObservation=null;discardScript(t,'页面已变化，已批准的脚本未执行；重新观察',now());
        if(!t.check&&t.phase==='executing'&&t.pending&&url&&new URL(url).origin===t.origin&&url!==t.pending.url){
          const pending=t.pending;t.uncertainClicks=(t.uncertainClicks||[]).concat({url:pending.url,documentId:pending.documentId,key:pending.targetKey,target:pending.targetDescriptor}).slice(-2);
          t.results=(t.results||[]).concat({action:pending.plan.action,request:pending.plan,origin:t.origin,tabRef:refOf(t),outcome:T.result({status:'unknown',dispatch:'unknown',scope:'dispatch',code:'DOCUMENT_CHANGED',recovery:'observe',operationId:pending.operationId,message:'页面已导航，旧操作未重放；重新观察核对'})});t.phase='observe';t.pending=null;
        }
        if(!t.check&&t.phase!=='executing'){t.phase='observe';t.pending=null;}
        await store.set(tabId,t);return t;
      });if(saved)schedule(tabId);
    }
    async function sensitiveAccess(tabId,{taskId,requestId,allow}){
      const saved=await serial(tabId,async()=>{
        const t=await store.get(tabId);
        if(!t||t.taskId!==taskId||t.status!=='paused'||t.reason!=='sensitive_access'||!t.sensitiveRequest||t.sensitiveRequest.id!==requestId||typeof allow!=='boolean')throw new Error('敏感字段确认已过期');
        if(new URL((await tools.tab(tabId)).url).origin!==t.origin)throw new Error('网页来源已变化，请返回任务网站');
        controllerForTab(tabId)?.abort();await cancelSchedule(tabId);
        t.token=uuid();t.sensitiveAccess=allow?'allowed':'denied';t.sensitiveRequest=null;t.phase='observe';t.nextObservation=null;t.pending=null;t.check=null;t.waitDeadline=null;
        t.status=allow?'running':'paused';t.reason=allow?null:'sensitive_access_denied';
        event(t,allow?'已授权本次对话读取和操作敏感字段；重新观察':'未授权，本次对话继续屏蔽敏感字段');await store.set(tabId,t);return t;
      });
      if(allow)schedule(tabId);return saved;
    }
    // Trusted side-panel decision on one pending run_script. scope 'once': the exact stored code runs
    // once on the same tab and document. scope 'task' additionally grants this task automatic approval
    // for later scripts on the same tab and origin (task.scriptApproval). Rejection is reported to the model.
    async function scriptApproval(tabId,{taskId,requestId,allow,scope='once'}){
      const saved=await serial(tabId,async()=>{
        const t=await store.get(tabId),request=t?.scriptRequest;
        if(!['once','task'].includes(scope)||scope==='task'&&allow!==true)throw new Error('脚本确认无效');
        if(!t||t.taskId!==taskId||t.status!=='paused'||t.reason!=='script_approval'||!request?.pending||request.id!==requestId||typeof allow!=='boolean')throw new Error('脚本确认已过期');
        controllerForTab(tabId)?.abort();await cancelSchedule(tabId);
        t.token=uuid();t.scriptRequest=null;t.status='running';t.reason=null;t.phase='observe';t.pending=null;t.check=null;t.waitDeadline=null;t.nextObservation=null;t.retries=0;
        if(!allow){
          t.results=t.results.concat(scriptEntry(t,request.pending,'SCRIPT_REJECTED','用户拒绝执行该脚本，脚本未运行；不要重复提交同一脚本，改用其他方法或询问用户','replan',now()));
          event(t,'你拒绝了脚本，未执行；助手将改用其他方法');
        }else{
          let current=null;try{current=await tools.tab(tabId);}catch{current=null;}
          if(request.pending.tabId!==tabId||t.tabId!==tabId||current?.url!==request.pending.url||originOf(current)!==t.origin){
            t.results=t.results.concat(scriptEntry(t,request.pending,'STALE','页面已变化，已批准的脚本未执行；重新观察后再决定','observe',now()));
            event(t,'页面已变化，已批准的脚本未执行；重新观察');
          }else{
            t.phase='approved';t.pending=request.pending;
            if(scope==='task'){t.scriptApproval={scope:'task',origin:t.origin,tabId,grantedAt:now()};event(t,'你已允许本任务在 '+t.origin+' 自动执行脚本（同一标签页与网站；可随时撤销）；执行这段脚本');}
            else event(t,'你已批准脚本，执行一次');
          }
        }
        t.updatedAt=now();await store.set(tabId,t);return t;
      });
      schedule(tabId);return saved;
    }
    // Trusted side-panel revoke of the task-scoped script approval; later scripts pause for approval again.
    async function revokeScriptApproval(tabId,{taskId}){
      return serial(tabId,async()=>{
        const t=await store.get(tabId);
        if(!t||t.taskId!==taskId)throw new Error('任务已变化，请刷新后重试');
        if(!t.scriptApproval)return t;
        t.scriptApproval=null;event(t,'已撤销本任务的脚本自动批准；之后的脚本需逐次批准');t.updatedAt=now();await store.set(tabId,t);return t;
      });
    }
    // The userScripts permission was removed: no task keeps an automatic script approval.
    async function reviewScriptApprovals(){
      const access=await scriptAccess().catch(()=>null);if(access?.permission===true)return;
      for(const task of await store.list()){
        if(!task.scriptApproval)continue;
        await serial(task.tabId,async()=>{const t=await store.get(task.tabId);if(!t?.scriptApproval)return;t.scriptApproval=null;event(t,'脚本执行权限已撤销，本任务的脚本自动批准已取消');t.updatedAt=now();await store.set(task.tabId,t);});
      }
    }
    async function changeOrigins(tabId,operation){
      return serial(tabId,async()=>{
        const task=await store.get(tabId);
        if(!task||task.taskId!==operation.taskId||task.scopeRevision!==operation.expectedRevision||['ended','completed'].includes(task.status))throw new Error('任务范围已变化，请刷新后重试');
        let url;try{url=new URL(operation.origin);}catch{throw new Error('请输入完整 HTTP/HTTPS 站点来源');}
        if(!['http:','https:'].includes(url.protocol)||url.origin!==operation.origin||url.username||url.password||url.hostname.includes('*')||!['add','remove'].includes(operation.action)||operation.origin.length>300)throw new Error('站点来源或范围操作无效');
        if(operation.rememberFrame!==undefined&&typeof operation.rememberFrame!=='boolean')throw new Error('嵌入式网站授权格式无效');
        const exists=(task.allowedOrigins||[task.origin]).includes(operation.origin);
        if(operation.rememberFrame===true){
          const request=task.frameAccessRequest,current=await tools.tab(tabId,true);
          if(operation.action!=='add'||task.reason!=='frame_access'||!request?.origins?.includes(operation.origin)||current.url!==request.url||originOf(current)!==task.origin)throw new Error('嵌入式网站授权已过期，请重新观察');
          const snap=await tools.observe(tabId,undefined,policyFor(task));
          if(snap.url!==request.url||snap.documentId!==request.documentId||!snap.page.frames?.some(f=>f.origin===operation.origin&&(f.reason==='permission_required'||f.read===true)))throw new Error('嵌入式表单已变化，请重新观察');
        }
        if(operation.action==='add'&&(!tools.hasOriginAccess||!await tools.hasOriginAccess(operation.origin)))throw new Error('请先从任务范围面板授权该网站');
        const remembered=(await tools.frameOrigins?.(task.origin)||[]).includes(operation.origin);
        if(!operation.rememberFrame&&(operation.action==='add'&&exists||operation.action==='remove'&&!exists&&!remembered))return task;
        controllerForTab(tabId)?.abort();await cancelSchedule(tabId);
        if(operation.rememberFrame===true){
          if(!tools.rememberFrame)throw new Error('无法保存嵌入式网站授权');
          await tools.rememberFrame(task.origin,operation.origin);
          // A-to-B permission is frame-only, not a task-wide grant that C could inherit after navigation.
          const saved={...task,token:uuid(),status:'paused',reason:'scope_changed',nextObservation:null};await store.set(tabId,saved);
          return {...saved,rememberedFrameOrigins:await tools.frameOrigins(task.origin)};
        }
        if(operation.action==='remove')await tools.forgetFrame?.(task.origin,operation.origin);
        let saved;
        if(operation.action==='add'&&exists||operation.action==='remove'&&!exists){
          saved=task;
          if(operation.action==='remove'){saved={...task,token:uuid(),status:'paused',reason:'scope_changed'};await store.set(tabId,saved);}
        }else saved=await store.changeOrigins(tabId,{...operation,token:uuid(),updatedAt:now()});
        return {...saved,rememberedFrameOrigins:await tools.frameOrigins?.(task.origin)||[]};
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
      await reviewScriptApprovals();
      if(!tools.hasOriginAccess)return;
      for(const task of await store.list()){
        if(['ended','completed','stopped','failed'].includes(task.status)||task.origin==='browser'||await tools.hasOriginAccess(task.origin))continue;
        controllers.get(task.taskId)?.abort();await cancelSchedule(task.tabId);await scopePause(task,'permission_denied');
      }
    }
    const inputLimit=prefs=>prefs?.inputChars??2000;
    // Total instructions scale with the single-input limit so one maximal input still leaves room for corrections.
    const instructionLimit=prefs=>Math.max(12000,inputLimit(prefs)*6);
    async function start(tabId, goal) {
      const prefs = await preferences(), limit = inputLimit(prefs);
      if (typeof goal !== 'string' || !goal.trim() || goal.length > limit) throw new Error(`请输入不超过 ${limit} 字的任务`);
      const page = await tools.tab(tabId,true);
      controllerForTab(tabId)?.abort();
      const task = {version:2, taskId:uuid(), token:uuid(), tabId, origin:originOf(page),allowedOrigins:originOf(page)==='browser'?[]:[originOf(page)], goal:goal.trim(), status:'running', phase:'observe', steps:0, prefs, results:[], events:[], pending:null, updatedAt:Date.now(), retries:0};
      event(task, '任务已开始');
      await serial(tabId, () => store.set(tabId, task)); schedule(tabId); return task;
    }
    // Side-panel tab that is a non-executing member: route to its task, or release it if that task is finished.
    async function resolve(tabId){const owner=store.owner?await store.owner(tabId):null;return owner?.role==='member'&&Number.isInteger(owner.taskTabId)?owner.taskTabId:tabId;}
    async function submit(tabId,text,options={}){
      const limit=inputLimit(await preferences());
      if(typeof text!=='string'||!text.trim()||text.length>limit)throw new Error(`请输入不超过 ${limit} 字的指令`);
      const owner=store.owner?await store.owner(tabId):null;
      if(owner?.role!=='member')return submitHere(tabId,text,options);
      const owning=Number.isInteger(owner.taskTabId)?await store.get(owner.taskTabId):null;
      if(owning?.taskId!==owner.taskId)throw new Error('该标签页已加入其他任务，请到任务所在标签页操作或先移出');
      if(owning.status!=='ended')return submitHere(owner.taskTabId,text,options);
      await serial(owner.taskTabId,()=>store.changeMembers(owner.taskTabId,{taskId:owner.taskId,action:'release',memberTabId:tabId,updatedAt:now()}));
      return submitHere(tabId,text,options);
    }
    async function submitHere(tabId, text, options={}) {
      const prefs=await preferences(),limit=inputLimit(prefs);
      if(typeof text!=='string'||!text.trim()||text.length>limit)throw new Error(`请输入不超过 ${limit} 字的指令`);
      const page=await tools.tab(tabId,true);
      const saved=await serial(tabId,async()=>{
        let task=await store.get(tabId);
        // Only an explicit new conversation (ended) starts a new task; a completed task keeps the conversation going.
        if(task&&task.status!=='ended'){
          const wasCompleted=task.status==='completed';
          if(!inScope(task))throw new Error('当前网站不在任务授权范围，请先添加后继续');
          if(['scope_changed','permission_denied'].includes(task.reason)&&(task.phase==='executing'||task.check))throw new Error('请先点击继续核对未确定操作，再补充指令');
          // A completed task has no unresolved checkpoint, so the next turn may adopt the new origin through the usual isolation path.
          if(!wasCompleted&&originOf(page)!==task.origin)throw new Error('当前任务尚未结束，请回到原站点补充指令，或先结束任务');
          const instructions=(task.instructions||[]).concat({text:text.trim(),time:now()});
          if(JSON.stringify(instructions).length>instructionLimit(prefs))throw new Error('补充指令已达上下文上限，请结束当前任务后开始新任务；已有指令未删除');
          controllerForTab(tabId)?.abort();discardScript(task,'收到补充指令，待批准的脚本已作废，未执行',now());
          task.token=uuid();task.nextObservation=null;task.check=null;task.waitDeadline=null;task.recoveryCount=0;task.completionChecks=null;task.completionEvidence=null;task.instructions=instructions;task.memoryReview={pending:true,instructionCount:instructions.length};task.reviewState=null;
          task.question=null;task.helpAttempts=0;task.tabHops=0;task.verificationRecoveries=0;task.status='running';task.phase='observe';task.pending=null;task.reason=null;task.retries=0;task.prefs=prefs;
          if(wasCompleted)task.steps=0;
          if(typeof options.goalMode==='boolean')task.goalMode=options.goalMode;
          event(task,'你（补充指令）：'+text.trim());
        }else{
          controllerForTab(tabId)?.abort();
          task={version:2,taskId:uuid(),token:uuid(),tabId,origin:originOf(page),allowedOrigins:originOf(page)==='browser'?[]:[originOf(page)],goal:text.trim(),instructions:[],goalMode:options.goalMode===true,status:'running',phase:'observe',steps:0,prefs,results:[],events:[],pending:null,retries:0};
          event(task,'你：'+text.trim());event(task,task.goalMode?'任务已开始（目标模式）':'任务已开始');
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
        if(JSON.stringify(instructions).length>instructionLimit(t.prefs))throw new Error('补充指令已达上下文上限');
        controllerForTab(tabId)?.abort();t.token=uuid();t.nextObservation=null;t.instructions=instructions;t.question=null;t.helpAttempts=0;t.tabHops=0;t.verificationRecoveries=0;t.status='running';t.reason=null;t.phase='observe';t.pending=null;t.check=null;t.waitDeadline=null;t.retries=0;event(t,'你（补充指令）：'+text);await store.set(tabId,t);return t;
      });schedule(tabId);return saved;
    }
    async function finish(tabId){
      await tools.clearPointer?.(tabId);
      const saved=await serial(tabId,async()=>{
        const task=await store.get(tabId);if(!task)return null;
        controllerForTab(tabId)?.abort();discardScript(task,'任务已结束，待批准的脚本已作废，未执行',now());task.scriptApproval=null;task.token=uuid();task.nextObservation=null;task.check=null;task.waitDeadline=null;task.status='ended';task.phase='idle';task.pending=null;task.updatedAt=now();
        event(task,'用户已结束任务，下次发送将新建任务');await store.set(tabId,task);return task;
      });
      await cancelSchedule(tabId);return saved;
    }
    async function stop(tabId) {
      await tools.clearPointer?.(tabId);
      controllerForTab(tabId)?.abort();
      const task = await store.get(tabId); if (!task) return null;
      const saved = await update(tabId, task.token, t => {discardScript(t,'已停止，待批准的脚本已作废，未执行',now());t.token=uuid();t.nextObservation=null;t.check=null;t.waitDeadline=null;t.status='stopped';t.pending=null;event(t,'已停止；已发出的网页操作不会自动撤销');});
      await cancelSchedule(tabId); return saved;
    }
    async function takeover(tabId){
      controllerForTab(tabId)?.abort();
      const saved=await serial(tabId,async()=>{
        const t=await store.get(tabId);if(!t||['completed','ended'].includes(t.status))throw new Error('没有可接管的进行中任务');
        discardScript(t,'用户接管网页，待批准的脚本已作废，未执行',now());
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
      if(task.sensitiveRequest&&task.reason==='sensitive_access')throw new Error('请先选择是否授权本次对话操作敏感字段');
      if(task.scriptRequest&&task.reason==='script_approval')throw new Error('请先在侧栏批准或拒绝待执行的脚本');
      if(task.tabRequest&&task.reason==='tab_access')throw new Error('请先选择是否允许读取该标签页');
      if(task.status==='ended')throw new Error('任务已手动结束，请输入新目标开始新任务');
      const page=await tools.tab(tabId,true);
      if(originOf(page)!==task.origin){const moved=await adoptOrigin(task,page);if(!moved)throw new Error('请核对任务范围和原站点未确定操作后再继续');schedule(tabId);return moved;}
      if(!inScope(task))throw new Error('当前网站不在任务授权范围，请先添加后继续');
      if(task.origin!=='browser'&&tools.hasOriginAccess&&!await tools.hasOriginAccess(task.origin))throw new Error('请先授权当前网站后继续');
      if (ACTIVE.has(task.status)) return task;
      const tab = await tools.tab(tabId,true);
      if (originOf(tab) !== task.origin) throw new Error('请回到任务原站点继续，跨站任务尚未支持');
      const prefs = await preferences();
      const saved = await update(tabId, task.token, t => {
        const wasCompleted=t.status==='completed';
        const recovery=['global_memory_changed','scope_reconciled','scope_changed','permission_denied','origin','origin_verification','origin_storage'].includes(t.reason)&&(t.check||t.phase==='executing')?{phase:t.phase,check:t.check,waitDeadline:t.waitDeadline,pending:t.pending}:null;
        t.question=null;t.helpAttempts=0;t.tabHops=0;t.verificationRecoveries=0;t.token=uuid();t.nextObservation=null;t.status='running';t.phase='observe';t.pending=null;t.check=null;t.waitDeadline=null;t.recoveryCount=0;t.completionEvidence=null;t.prefs=prefs;t.retries=0;
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
    // Goal mode trades pauses for more autonomous replanning; the step budget still bounds it.
    const caps=t=>t?.goalMode===true?{verify:5,recovery:5,help:3,noChange:6,hops:10}:{verify:2,recovery:2,help:3,noChange:3,hops:6};
    async function setGoalMode(tabId,taskId,enabled){
      if(typeof enabled!=='boolean')throw new Error('目标模式参数无效');
      return serial(tabId,async()=>{
        const t=await store.get(tabId);
        if(!t||t.taskId!==taskId||t.status==='ended')throw new Error('任务已变化，请刷新后重试');
        if(t.goalMode===enabled)return t;
        t.goalMode=enabled;t.updatedAt=now();
        event(t,enabled?'已开启目标模式：核对未通过、目标失效或遇到阻碍时自动重新规划，直到完成、停止或用完轮数':'已关闭目标模式');
        await store.set(tabId,t);return t;
      });
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
        const permitted=task.origin==='browser'||!tools.hasOriginAccess||await tools.hasOriginAccess(task.origin);
        const current = await store.get(tabId);
        return permitted&&!globalEditing && epoch===globalEpoch && !controller.signal.aborted && current?.token===token && ACTIVE.has(current.status)&&inScope(current);
      };
      try {
        const tab = await tools.tab(tabId,true);
        if(originOf(tab)!==task.origin){await adoptOrigin(task,tab);return;}
        if(!inScope(task)){await scopePause(task,'scope_changed');return;}
        if(task.origin!=='browser'&&tools.hasOriginAccess&&!await tools.hasOriginAccess(task.origin)){await scopePause(task,'permission_denied');return;}
        if (!await live()) return;
        if(task.check?.kind==='delay'){await delayCheck(task);return;}
        let readySnapshot=null;
        if (task.origin!=='browser'&&tab.status === 'loading') {
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
        if (task.origin!=='browser'&&tab.status === 'loading'&&!readySnapshot) {
          const deadline=task.check?.deadline||task.waitDeadline||now()+30000;
          if(now()>=deadline){await pause(task,'页面加载超过等待期限，任务暂停；未重复发送操作','timeout');return;}
          await update(tabId, token, t => {t.status='waiting_page';t.waitDeadline=deadline;if(!t.check&&t.phase!=='executing'){discardScript(t,'页面正在加载，已批准的脚本未执行；加载后重新观察',now());t.phase='observe';t.pending=null;}});return;
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
          if(pending?.plan?.action==='run_script'){
            // Exactly the approved code, once, only on the tab and URL it was approved for (document checked before dispatch).
            call={request:pending.plan,time:pending.time||now()};
            if(pending.tabId!==tabId||pending.url!==tab.url)throw Object.assign(new Error('页面已变化，已批准的脚本未执行；重新观察后再决定'),{code:'STALE'});
            await execute(task,pending,live);return;
          }
          if (!pending || pending.url!==tab.url) {
            await update(tabId,token,t=>{t.phase='observe';t.pending=null;event(t,'页面已变化，旧确认失效，重新规划');});return;
          }
          await execute(task,pending,live);return;
        }
        // Queued fill_fields steps make no model request, so they are not stopped by the round budget.
        if (!task.batch&&task.prefs.maxSteps && task.steps>=task.prefs.maxSteps) {await pause(task,'达到执行轮数上限，点击继续可开启新预算。','budget');return;}
        const readingScope=task.nextObservation;
        let snap = task.origin==='browser'?{url:tab.url,snapshotId:null,nodes:new Map(),page:{browser:true,text:'',elements:[],regions:[],coverage:{absenceComplete:false}}}:readingScope?await tools.observe(tabId,readingScope.value,policyFor(task)):readySnapshot||await tools.observe(tabId,undefined,policyFor(task));
        if(!await live())return;
        if(readingScope){
          task=await update(tabId,token,t=>{t.nextObservation=null;});
          if(!task)return;
          if(snap.url!==readingScope.url||snap.documentId!==readingScope.documentId)snap=await tools.observe(tabId,undefined,policyFor(task));
        }
        if (!await live()) return;
        const observedTab=await tools.tab(tabId,true);
        if(observedTab.url!==snap.url||originOf(snap)!==task.origin){if(originOf(observedTab)!==task.origin)await adoptOrigin(task,observedTab);return;}
        const durable=siteMemory&&task.origin!=='browser'?await siteMemory.read(task.origin):{version:0,notes:[]};
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
        const siteSkillIndex=siteSkills&&task.origin!=='browser'?(await siteSkills.read(task.origin).catch(()=>({notes:[]}))).notes.map(n=>({id:n.id,description:n.description})):[];
        const modelIdentity=await identity(),modelProtocol=await protocol();
        const scriptState=task.origin==='browser'?{permission:false,api:false,available:false}:await scriptAccess().catch(()=>({permission:false,api:false,available:false}));
        const capabilities={scripts:scriptState?.available===true};
        if(task.scriptApproval&&scriptState?.permission!==true){task=await update(tabId,token,t=>{t.scriptApproval=null;event(t,'脚本执行权限已撤销，本任务的脚本自动批准已取消');});if(!task)return;}
        if(!await live())return;
        const page={...snap.page,url:snap.url,documentId:snap.documentId};
        const tabsView=await taskTabs(task);
        if(!await live())return;
        if(JSON.stringify(task.tabCandidates||[])!==JSON.stringify(tabsView.candidates)){task=await update(tabId,token,t=>{t.tabCandidates=tabsView.candidates;});if(!task||!await live())return;}
        const tabsArgs=[tabsView.members.length>1?tabsView.members:null,tabsView.others.length?tabsView.others:null];
        // fill_fields continuation: the next queued field runs without a model request, found again by its stable key.
        let batchPlan=null,batchState=null;
        if(task.batch){
          const b=task.batch,last=(task.results||[]).at(-1),next=b.queue[0];
          const ran=b.token===task.token&&last?.outcome?.operationId===b.current&&last.outcome.status==='success';
          const samePage=snap.url===b.url&&(!b.documentId||snap.documentId===b.documentId);
          const matches=next?snap.page.elements.filter(e=>e.key&&e.key===next.key):[];
          if(ran&&samePage&&next&&matches.length===1){
            batchPlan={reply:b.reply+'（'+(b.index+1)+'/'+b.total+'）',action:next.action,id:matches[0].id,value:next.value};
            batchState={...b,index:b.index+1,queue:b.queue.slice(1)};
          }else{
            const done=ran&&!next,left=b.queue.map(q=>q.label).filter(Boolean).join('、');
            const why=b.token!==task.token?'任务收到新的指令或被打断':!ran?'第 '+b.index+' 步未成功':!samePage?'页面已变化':'找不到第 '+(b.index+1)+' 步的目标字段';
            const message=done?'批量填写完成，共 '+b.total+' 项':'批量填写在第 '+b.index+'/'+b.total+' 步后停止（'+why+'）；未执行 '+b.queue.length+' 项'+(left?'：'+left:'');
            task=await update(tabId,token,t=>{t.batch=null;t.results=t.results.concat({action:'fill_fields',time:now(),result:message,
              outcome:T.result({status:done?'success':'error',dispatch:done?'sent':'not_sent',scope:'dispatch',code:done?'BATCH_DONE':'BATCH_STOPPED',recovery:done?'none':'replan',documentId:snap.documentId,message})});if(!done)event(t,message);});
            if(!task||!await live())return;
          }
        }
        let planText;
        if(batchPlan){
          task=await update(tabId,token,t=>{t.status='running';t.phase='thinking';t.pending=null;t.waitDeadline=null;});
          if(!task||!await live())return;
          planText=JSON.stringify(batchPlan);
        }else{
        if (task.prefs.maxSteps && task.steps>=task.prefs.maxSteps) {await pause(task,'达到执行轮数上限，点击继续可开启新预算。','budget');return;}
        const currentPayload=P.agentInput(task,page,siteMemoryIndex,globalMemoryIndex,...tabsArgs,siteSkillIndex);
        const pressure=P.pressure(task,currentPayload,modelIdentity,modelProtocol,capabilities);
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
          const archive={origin:task.origin,tabRef:refOf(task),id:'h'+from,from,to:from+older.length-1,results:older};
          const archives=(task.contextArchive||[]).concat(archive);
          if(JSON.stringify(archives).length>1000000){await pause(task,'任务历史归档达到 100 万字符上限，请结束任务；原记录已保留','context');return;}
          const input=JSON.stringify({goal:task.goal,instructions:task.instructions||[],previousSummary:task.contextSummary?.content||null,archiveId:archive.id,olderResults:older.map(r=>{
            if(['site_memory_read','global_memory_read','site_skill_read'].includes(r.action))return {action:r.action,result:'Memory bodies omitted; read again if needed'};
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
        const payload = P.agentInput(task,page,siteMemoryIndex,globalMemoryIndex,...tabsArgs,siteSkillIndex);
        const sentEstimate=P.pressure(task,payload,null,modelProtocol,capabilities).estimatedTokens;
        const result = await measured(task,'model',()=>model(payload,controller.signal,capabilities),live);
        if (!await live()) return;
        task=await update(tabId,token,t=>{t.compactionGuard=false;t.contextPressure=pressure;
          t.contextUsage=result.usage&&Number.isSafeInteger(result.usage.promptTokens)?{...result.usage,estimatedTokens:sentEstimate,modelIdentity:result.modelIdentity||modelIdentity}:null;
        });
        if(!task||!await live())return;
        const current = await tools.tab(tabId,true);
        if (!await live()) return;
        if (current.url!==snap.url) {await update(tabId,token,t=>{t.phase='observe';event(t,'页面已跳转，丢弃旧回复');});return;}
        if((await getGlobalMemoryOrEmpty()).version!==shared.version){
          if(await live())await update(tabId,token,t=>{forgetGlobalContext(t);t.phase='observe';event(t,'全局长期记忆已更新，丢弃旧回复并重新读取');});return;
        }
        if(task.origin!=='browser'&&siteMemory&&(await siteMemory.read(task.origin)).version!==durable.version){
          if(await live())await update(tabId,token,t=>{forgetSiteContext(t);t.phase='observe';event(t,'网站长期记忆已在其他任务更新，丢弃旧回复并重新读取');});return;
        }
        if(!await live())return;
        planText=result.text;
        }
        let plan = C.agentPlan(planText, {nodes:new Map(snap.page.elements.map(e=>[e.id,true]))});
        if(task.origin==='browser'&&!['navigate','tab_switch','done','pause'].includes(plan.action)){await pause(task,'请提供要打开的网站；当前标签页不支持网页操作','access');return;}
        if(plan.subgoals!==undefined){
          const updates=plan.subgoals.map(g=>{
            const checks=g.checks?G.bind(g.checks,snap):[],verification=checks.length?G.evaluate(checks,snap):null;
            return {id:g.id,title:g.title,status:g.status==='completed'&&verification?.status!=='success'?'active':g.status,verification,updatedAt:now(),documentId:snap.documentId||null,url:snap.url};
          });
          const merged=plan.subgoals.length?(task.taskPlan||[]).filter(g=>!updates.some(u=>u.id===g.id)).concat(updates):[];
          if(merged.length>8)throw new Error('子目标总数超过 8 项，请先用空列表清空后重列');
          task=await update(tabId,token,t=>{t.taskPlan=merged;});if(!task||!await live())return;
        }
        // Model notebook for multi-page collection: results never carry old page text, so this is what survives a page change.
        if(plan.progress!==undefined){task=await update(tabId,token,t=>{t.progress={text:plan.progress,url:snap.url,time:now()};});if(!task||!await live())return;}
        if(plan.action==='fill_fields'){
          const steps=plan.value.map(step=>({...step,target:snap.page.elements.find(e=>e.id===step.id)}));
          if(steps.some(step=>!step.target?.key)){
            await update(tabId,token,t=>{t.phase='observe';t.results=t.results.concat({request:plan,time:now(),action:'fill_fields',outcome:T.result({status:'error',dispatch:'not_sent',scope:'dispatch',code:'BATCH_UNSUPPORTED',recovery:'replan',documentId:snap.documentId,message:'部分字段没有稳定标识，无法批量填写；请逐项填写'})});});return;
          }
          const [first,...rest]=steps;
          batchState={token,documentId:snap.documentId||null,url:snap.url,total:steps.length,index:1,reply:plan.reply,queue:rest.map(step=>({action:step.action,value:step.value,key:step.target.key,label:step.target.label||null}))};
          plan={reply:plan.reply+'（1/'+steps.length+'）',action:first.action,id:first.id,value:first.value,...(plan.notice?{notice:plan.notice}:{})};
        }
        if(!['done','pause'].includes(plan.action))call={request:plan,time:Date.now()};
        // run_script was not offered this turn (no optional permission, old Chrome or toggle off): nothing runs.
        if(plan.action==='run_script'&&!capabilities.scripts){await pause(task,S.unavailableMessage(scriptState),'access');return;}
        if(plan.action==='request_sensitive_access'){
          await update(tabId,token,t=>{t.status='paused';t.reason='sensitive_access';t.phase='observe';t.pending=null;t.check=null;t.nextObservation=null;
            if(t.sensitiveAccess!=='allowed'&&t.sensitiveAccess!=='denied')t.sensitiveRequest={id:uuid(),text:plan.reply};
            event(t,t.sensitiveAccess==='denied'?'本次对话已拒绝敏感字段授权':t.sensitiveAccess==='allowed'?'本次对话已授权敏感字段，请继续重新观察':plan.reply);
          });return;
        }
        if(plan.action==='pause'){
          if(plan.choices){await update(tabId,token,t=>{t.status='paused';t.reason='question';t.pending=null;t.check=null;t.waitDeadline=null;t.question={id:uuid(),text:plan.reply,options:plan.choices};event(t,plan.reply);});return;}
          // Missing browser/frame scope grants require a user gesture, not model recovery.
          const frameOrigins=[...new Set((snap.page.frames||[]).filter(f=>f.reason==='permission_required').map(f=>{
            try{const u=new URL(f.url);return ['http:','https:'].includes(u.protocol)&&u.origin===f.origin&&!u.username&&!u.password?u.origin:null;}catch{return null;}
          }).filter(Boolean))].slice(0,10);
          if(frameOrigins.length){
            await update(tabId,token,t=>{t.status='paused';t.reason='frame_access';t.phase='observe';t.pending=null;t.check=null;t.waitDeadline=null;t.nextObservation=null;
              t.frameAccessRequest={url:snap.url,documentId:snap.documentId,origins:frameOrigins};
              event(t,plan.reply);event(t,'嵌入式表单缺少网站权限或任务范围授权，请点击侧栏对应网站的授权按钮；敏感字段授权不能替代网站权限。未重试或提交表单。');
            });return;
          }
          const helpCap=caps(task).help;
          if(plan.pauseReason!=='user'&&(task.helpAttempts||0)<helpCap){
            await update(tabId,token,t=>{t.helpAttempts=(t.helpAttempts||0)+1;t.phase='observe';t.results=t.results.concat({action:'replan',result:'尚未解决：'+plan.reply+'。请改用其他通用方法探索'+(t.goalMode?'；先核对当前页面再决定是否重做':'；禁止重复结果不确定的操作')+'。自主恢复 '+t.helpAttempts+'/'+helpCap});event(t,'正在尝试其他方法（'+t.helpAttempts+'/'+helpCap+'）');});return;
          }
          await pause(task,plan.reply,'model');return;
        }
        if(plan.action==='tab_switch'){await switchAction(task,plan,call);return;}
        if(plan.action==='tab_open'){await openTabAction(task,plan,call,live);return;}
        if(plan.action==='tab_close'){await closeTabAction(task,plan,call,live);return;}
        if(plan.action==='history_read'){
          const archive=task.contextArchive?.find(a=>a.id===plan.id),offset=plan.value||0;
          const text=archive?JSON.stringify(archive.results):null;
          const result=text?{id:archive.id,offset,text:text.slice(offset,offset+4000),nextOffset:offset+4000<text.length?offset+4000:null}:{error:'历史归档不存在'};
          await update(tabId,token,t=>{t.phase='observe';t.results=t.results.concat({...call,action:'history_read',result});event(t,'读取任务历史：'+plan.id);});return;
        }
        if(plan.action.startsWith('global_memory_')){await globalMemoryAction(task,plan,shared.version,controller.signal);return;}
        if(plan.action.startsWith('site_memory_')){await siteMemoryAction(task,plan,durable.version,controller.signal);return;}
        if(plan.action==='site_skill_read'){await siteSkillRead(task,plan,controller.signal);return;}
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
          await update(tabId,token,t=>{t.status='completed';t.phase='idle';t.completionEvidence='model_reported';t.results=t.results.concat({action:'done',result:plan.reply,time:now()});event(t,plan.reply);event(t,'模型报告完成；未提供可执行的任务完成条件');markReview(t);});return;
        }
        const target = snap.page.elements.find(e=>e.id===plan.id);
        const combined=[...plan.expected||[]];
        for(const c of G.automatic(plan))if(!combined.some(e=>e.kind===c.kind&&e.id===c.id&&e.value===c.value))combined.push(c);
        if(plan.action==='navigate'){
          const destination=new URL(plan.value).origin;
          if(tools.hasOriginAccess&&!await tools.hasOriginAccess(destination)){await update(tabId,token,t=>{t.status='paused';t.reason='browser_target';t.phase='observe';t.browserTarget=plan.value;event(t,'任务未完成：尚未打开目标网站，缺少浏览器网站权限，请授权后继续。');});return;}
          if(destination!==task.origin&&combined.some(condition=>!condition.kind.startsWith('url_')))throw Object.assign(new Error('跨站导航只支持 URL 条件核对，不能使用旧站点 DOM 条件'),{code:'NAVIGATION_DENIED'});
        }
        const expected=G.bind(combined,snap,plan.action==='navigate'?{allowedOrigins:[...(task.allowedOrigins||[task.origin]),new URL(plan.value).origin]}:null);
        // Goal mode lets the model redo an uncertain target after re-reading the page; the runtime itself never replays.
        for(const guard of C.agentTool(plan.action).guard&&!task.goalMode?(task.uncertainClicks||[]):[]){
          const sameTarget=target&&(guard.key?guard.key===target.key:JSON.stringify(guard.target)===JSON.stringify(G.descriptor(target,snap.page)));
          if(guard.url===snap.url&&guard.documentId===snap.documentId&&sameTarget){
            await pause(task,'该点击的结果仍不确定，已阻止重复点击同一目标；请核实当前状态或选择新的确认控件','uncertain');return;
          }
        }
        const pending={frameRoute:snap.frameRoutes?.[plan.id],tabId,origin:task.origin,scopeRevision:task.scopeRevision,targetKey:target?.key,targetDescriptor:target?G.descriptor(target,snap.page):null,plan,snapshotId:snap.snapshotId,documentId:snap.documentId,url:snap.url,label:target?.label||plan.action,sensitive:target?.sensitive===true?true:undefined,operationId:uuid(),expected,time:call.time};
        if(plan.action==='run_script'){
          // Nothing runs until the user approves this exact code in the side panel, or the user
          // allowed scripts for this task on this same tab and origin. Decided on the stored record so a revoke wins.
          const {code,world}=S.source(plan);let granted=false;
          const decided=await update(tabId,token,t=>{
            const grant=t.scriptApproval;
            if(grant?.scope==='task'&&grant.tabId===tabId&&t.tabId===tabId&&grant.origin===t.origin&&originOf(snap)===grant.origin){
              granted=true;t.pending=pending;t.retries=0;event(t,plan.reply);event(t,'本任务已允许脚本自动执行：执行一次，完整代码见对话记录');return;
            }
            if(grant)t.scriptApproval=null;
            t.status='paused';t.reason='script_approval';t.phase='observe';t.pending=null;t.check=null;t.waitDeadline=null;t.nextObservation=null;
            t.scriptRequest={id:uuid(),code,world,url:snap.url,origin:t.origin,documentId:snap.documentId||null,snapshotId:snap.snapshotId||null,reply:plan.reply,time:now(),pending};
            event(t,plan.reply);event(t,'等待你在侧栏批准脚本：批准后执行，拒绝则改用其他方法');});
          if(!decided||!granted)return;
          task=decided;if(!await live())return;
          await execute(task,pending,live);return;
        }
        task = await update(tabId,token,t=>{t.pending=pending;t.retries=0;if(batchState)t.batch={...batchState,current:pending.operationId};event(t,plan.reply);const notice=plan.notice||(/提交|删除|支付|购买|发布|发送|确认订单|submit|delete|pay|purchase|publish|send/i.test(pending.label)?'即将执行：'+pending.label:null);if(notice){t.notice=notice;event(t,'重要操作：'+notice);}});
        if (!task || !await live()) return;
        await execute(task,pending,live);
      } catch (error) {
        if (!await live()) return;
        await update(tabId,token,t=>{t.lastOutcome=error.result||T.failure(error,call?{}:{dispatch:'not_sent'});if(call)t.results=t.results.concat({...call,action:call.request.action,label:t.pending?.label,sensitive:t.pending?.sensitive,outcome:t.lastOutcome,result:t.lastOutcome.message});});
        if(!await live())return;
        if (['STALE','TARGET_BLOCKED'].includes(error.code)) {
          if((task.recoveryCount||0)>=caps(task).recovery){await pause(task,'连续目标失效，已达到重新定位上限','recovery');return;}
          await update(tabId,token,t=>{t.recoveryCount=(t.recoveryCount||0)+1;t.phase='observe';t.pending=null;t.check=null;event(t,error.code==='TARGET_BLOCKED'?'目标被遮挡，重新读取后先处理遮挡层':'目标已变化，重新读取后规划');});
        } else if (['NAVIGATION','PAGE_BUSY'].includes(error.code)) {
          const deadline=task.check?.deadline||task.waitDeadline||now()+30000;
          if(now()>=deadline){await pause(task,'页面连接或忙碌等待超时，未重复操作','timeout');return;}
          await update(tabId,token,t=>{t.status='waiting_page';t.waitDeadline=deadline;t.pending=null;t.phase=t.check?'verifying':'observe';event(t,'正在等待页面加载或上一操作结束，随后重新读取');});
        } else if (['INPUT_CANCELLED','INVALID_FIELD_VALUE','UNSUPPORTED_EDITABLE'].includes(error.code))await pause(task,error.message,'input');
        else if (error.code==='MODEL_PROTOCOL_FALLBACK'&&task.retries<2) {
          await update(tabId,token,t=>{t.retries++;t.phase='observe';event(t,'接口未使用原生工具调用，改用 JSON 文本协议重试（'+t.retries+'/2）');});
        }
        else if (/API (?:网络|请求超时|429|5\d\d)/.test(error.message)&&task.retries<2) {
          await update(tabId,token,t=>{t.retries++;t.phase='observe';event(t,'模型暂时不可用，稍后重试（'+t.retries+'/2）');});
        } else if(error.code==='ORIGIN_BOUNDARY')await scopePause(task,'origin','页面来源已改变，未读取新来源内容；请核对范围后继续');
        else if(['PERMISSION_DENIED','UNSUPPORTED_PAGE','TAB_CLOSED'].includes(error.code))await pause(task,error.message,'access');
        else await pause(task, error.message || '任务失败，请检查页面与配置');
      } finally {
        if(controllers.get(runningTaskId)===controller){controllers.delete(runningTaskId);if(controllerTasks.get(tabId)===runningTaskId)controllerTasks.delete(tabId);}
      }
    }
    // Model-visible directory: this task's open members, plus other open web tabs owned by no task
    // (origin and a bounded untrusted title only). Reading another tab needs a side-panel grant.
    async function taskTabs(task){
      const members=[],others=[],candidates=[],known=new Set([task.tabId,...(task.members||[]).map(member=>member.tabId)]);
      for(const member of task.members||[]){
        let tab;try{tab=await tools.tab(member.tabId,true);}catch{continue;}
        const origin=originOf(tab);members.push({tabRef:member.tabRef,kind:member.kind,active:member.tabId===task.tabId,origin:origin==='browser'?null:origin,title:String(tab.title||'').slice(0,80)});
      }
      const open=tools.listTabs?await tools.listTabs().catch(()=>[]):[];
      for(const tab of open){
        if(candidates.length>=20)break;
        if(known.has(tab.id))continue;
        const {origin,title}=tabView(tab,[]);if(!origin||await store.owner(tab.id))continue;
        const tabRef='open'+(candidates.length+1);
        candidates.push({tabRef,tabId:tab.id,url:tab.url});others.push({tabRef,origin,title});
      }
      return {members,others,candidates};
    }
    function tabResult(t,call,plan,data){
      const outcome=T.result({dispatch:'not_sent',scope:'dispatch',...data});
      t.phase='observe';t.pending=null;t.lastOutcome=outcome;t.results=t.results.concat({...call,action:plan.action,outcome,result:outcome.message});event(t,outcome.message);
    }
    const tabReject=(task,call,plan,code,message)=>update(task.tabId,task.token,t=>tabResult(t,call,plan,{status:'error',code,recovery:'replan',message}));
    // Rebind execution to a member: cancels the old request, rotates token and scopeRevision, never focuses the tab.
    async function switchTo(task,toTabId,entry){
      return serial(task.tabId,async()=>{
        const t=await store.get(task.tabId);if(!t||t.taskId!==task.taskId||t.token!==task.token)return null;
        controllerForTab(task.tabId)?.abort();
        const results=(t.results||[]).concat({origin:t.origin,tabRef:refOf(t),...entry});
        const events=recent((t.events||[]).concat({time:now(),text:entry.result}),40,16000);
        // Trusted move history and model handoff notes survive switchOrigin, so a cross-origin switch is not forgotten.
        const to=(t.members||[]).find(member=>member.tabId===toTabId)?.tabRef||null,handoff=entry.request?.handoff;
        const tabTrail=(t.tabTrail||[]).concat({action:entry.action,from:refOf(t),fromOrigin:t.origin,to,time:now()}).slice(-12);
        const handoffs=handoff?(t.handoffs||[]).concat({from:refOf(t),origin:t.origin,text:handoff,time:now()}).slice(-3):t.handoffs;
        return store.switchTab(task.tabId,{taskId:t.taskId,expectedRevision:t.scopeRevision,expectedToken:t.token,toTabId,token:uuid(),updatedAt:now(),patch:{results,events,tabTrail,handoffs,tabHops:(t.tabHops||0)+1,status:'running',reason:null,phase:'observe',pending:null,check:null,waitDeadline:null,nextObservation:null,contextUsage:null,retries:0,lastOutcome:entry.outcome}});
      });
    }
    // A tab outside the task is never read before the user grants it in the side panel.
    async function candidateTab(task,tabRef){
      const candidate=(task.tabCandidates||[]).find(item=>item.tabRef===tabRef);
      if(!candidate)return {code:'TAB_NOT_LISTED',message:tabRef+' 不在最新的 otherTabs 列表中'};
      let tab;try{tab=await tools.tab(candidate.tabId,true);}catch{return {code:'TAB_CLOSED',message:tabRef+' 已关闭'};}
      if(tab.url!==candidate.url)return {code:'TAB_CHANGED',message:tabRef+' 的网页已变化；请按下一轮的列表重新选择'};
      const view=tabView(tab,[]);if(!view.origin)return {code:'UNSUPPORTED_PAGE',message:tabRef+' 不是普通网页'};
      if(await store.owner(candidate.tabId))return {code:'TAB_OWNED',message:tabRef+' 正被其他任务使用'};
      if((task.members||[]).length>=8)return {code:'TAB_LIMIT',message:'每个任务最多 8 个标签页，请先在侧栏移出不需要的标签页'};
      return {candidate,view};
    }
    async function requestTabAccess(task,plan,call){
      const checked=await candidateTab(task,plan.id);
      if(checked.code)return tabReject(task,call,plan,checked.code,checked.message);
      const saved=await update(task.tabId,task.token,t=>{t.status='paused';t.reason='tab_access';t.phase='observe';t.pending=null;t.check=null;t.nextObservation=null;
        t.tabRequest={id:uuid(),tabRef:plan.id,tabId:checked.candidate.tabId,url:checked.candidate.url,origin:checked.view.origin,title:checked.view.title,text:plan.reply,plan,time:call.time};
        event(t,'请求读取标签页：'+(checked.view.title||checked.view.origin)+'，等待你在侧栏确认');});
      if(saved)await cancelSchedule(task.tabId);
    }
    // Trusted side-panel decision: allow joins the tab as user_joined and switches execution to it.
    async function tabAccess(tabId,{taskId,requestId,allow}){
      const task=await store.get(tabId),request=task?.tabRequest;
      if(!task||task.taskId!==taskId||task.status!=='paused'||task.reason!=='tab_access'||!request||request.id!==requestId||typeof allow!=='boolean')throw new Error('标签页授权已过期');
      controllerForTab(tabId)?.abort();await cancelSchedule(tabId);
      const call={request:request.plan,time:request.time},plan=request.plan;
      const settle=async(code,message,status='error')=>{
        const saved=await update(tabId,task.token,t=>{t.tabRequest=null;t.status='running';t.reason=null;tabResult(t,call,plan,{status,code,recovery:'replan',message});});
        if(saved)schedule(tabId);return saved;
      };
      if(!allow)return settle('TAB_ACCESS_DENIED','用户未允许读取 '+request.tabRef+'；不要再请求该标签页，改用其他方式或说明限制');
      const checked=await candidateTab({...task,tabCandidates:[{tabRef:request.tabRef,tabId:request.tabId,url:request.url}]},request.tabRef);
      if(checked.code)return settle(checked.code,checked.message);
      let joined;
      try{joined=await serial(tabId,()=>store.changeMembers(tabId,{taskId,action:'join',memberTabId:request.tabId,updatedAt:now()}));}
      catch(error){return settle(error.code||'TAB_JOIN_FAILED',error.message);}
      const ref=joined.members.find(member=>member.tabId===request.tabId)?.tabRef;
      const outcome=T.result({status:'success',dispatch:'not_sent',scope:'dispatch',code:'TAB_SWITCHED',recovery:'observe',message:'用户已允许，'+request.tabRef+' 加入任务为 '+ref+'，执行目标已切换（未切换浏览器前台）；重新观察'});
      const moved=await switchTo(joined,request.tabId,{...call,action:'tab_switch',outcome,result:outcome.message});
      if(!moved)throw new Error('任务已变化，请刷新后重试');
      await tools.clearPointer?.(tabId);schedule(request.tabId);return moved;
    }
    // Bouncing between tabs without page work is a loop, even when every switch succeeds.
    async function hopLimit(task){
      const cap=caps(task).hops;if((task.tabHops||0)<cap)return false;
      await update(task.tabId,task.token,t=>{t.status='paused';t.reason='no_progress';t.phase='observe';t.pending=null;event(t,'连续 '+cap+' 次切换标签页而没有网页操作，已暂停；请检查任务或补充说明');});
      return true;
    }
    async function switchAction(task,plan,call){
      if(plan.id.startsWith('open'))return requestTabAccess(task,plan,call);
      if(await hopLimit(task))return;
      const member=(task.members||[]).find(item=>item.tabRef===plan.id);
      if(!member)return tabReject(task,call,plan,'TAB_NOT_MEMBER','只能切换到任务标签页目录中的成员');
      if(member.tabId===task.tabId)return tabReject(task,call,plan,'TAB_ALREADY_ACTIVE',member.tabRef+' 已是执行标签页');
      let tab;try{tab=await tools.tab(member.tabId,true);}catch(error){if(error.code==='NAVIGATION')throw error;return tabReject(task,call,plan,'TAB_CLOSED',member.tabRef+' 已关闭');}
      if(originOf(tab)==='browser')return tabReject(task,call,plan,'UNSUPPORTED_PAGE',member.tabRef+' 不是普通网页，不能切换');
      const outcome=T.result({status:'success',dispatch:'not_sent',scope:'dispatch',code:'TAB_SWITCHED',recovery:'observe',message:'执行目标已切换到 '+member.tabRef+'（未切换浏览器前台）；重新观察'});
      try{if(await switchTo(task,member.tabId,{...call,action:'tab_switch',outcome,result:outcome.message}))await tools.clearPointer?.(task.tabId);}
      catch(error){if(error.code!=='TAB_NOT_MEMBER')throw error;return tabReject(task,call,plan,'TAB_NOT_MEMBER','该标签页已不属于本任务');}
    }
    async function openTabAction(task,plan,call,live){
      if(!tools.openTab)return tabReject(task,call,plan,'UNSUPPORTED_ACTION','当前环境不能打开标签页');
      if(await hopLimit(task))return;
      if((task.members||[]).length>=8)return tabReject(task,call,plan,'TAB_LIMIT','每个任务最多 8 个标签页，请先关闭任务创建的标签页');
      if(tools.hasOriginAccess&&!await tools.hasOriginAccess(new URL(plan.value).origin)){await update(task.tabId,task.token,t=>{t.status='paused';t.reason='browser_target';t.phase='observe';t.browserTarget=plan.value;event(t,'任务未完成：尚未打开新标签页，缺少目标网站的浏览器权限，请授权后继续。');});return;}
      // Create intent: a worker restart while executing pauses as uncertain and never opens a second tab.
      const operationId=uuid();
      const saved=await update(task.tabId,task.token,t=>{t.phase='executing';t.check=null;t.pending={tabId:task.tabId,origin:t.origin,scopeRevision:t.scopeRevision,plan,operationId,label:'tab_open',time:call.time};t.metrics={...t.metrics,actions:(t.metrics?.actions||0)+1};event(t,plan.reply);});
      if(!saved||!await live())return;
      let created;
      try{created=await tools.openTab(plan.value,{openerTabId:task.tabId});}
      catch(error){
        if(['PERMISSION_DENIED','NAVIGATION_DENIED'].includes(error.code))return update(task.tabId,task.token,t=>tabResult(t,call,plan,{status:'error',code:error.code,recovery:'pause',operationId,message:error.message}));
        await update(task.tabId,task.token,t=>{tabResult(t,call,plan,{status:'unknown',dispatch:'unknown',code:'TAB_OPEN_UNKNOWN',recovery:'pause',operationId,message:'无法确认新标签页是否已打开；任务暂停，不会重复打开或按网址认领，请检查浏览器标签页后继续'});t.status='paused';t.reason='uncertain';});
        return;
      }
      // Register the browser-returned tabId even if the run was stopped meanwhile, so the tab stays attributable.
      let registered=null;
      try{registered=await serial(task.tabId,()=>store.changeMembers(task.tabId,{taskId:task.taskId,action:'created',memberTabId:created.id,updatedAt:now()}));}catch{ /* Reported below; the tab is left to the user. */ }
      if(!registered){await update(task.tabId,task.token,t=>{tabResult(t,call,plan,{status:'unknown',dispatch:'sent',code:'TAB_UNREGISTERED',recovery:'pause',operationId,message:'新标签页已打开但未能登记为任务标签页；任务暂停，该标签页按普通标签页处理'});t.status='paused';t.reason='uncertain';});return;}
      const ref=registered.members.find(member=>member.tabId===created.id)?.tabRef;
      const outcome=T.result({status:'success',dispatch:'sent',scope:'dispatch',code:'TAB_OPENED',recovery:'observe',operationId,message:'已在后台打开 '+ref+' 并切换执行目标；重新观察'});
      await switchTo(task,created.id,{...call,action:'tab_open',outcome,result:outcome.message});
    }
    async function closeTabAction(task,plan,call,live){
      const member=(task.members||[]).find(item=>item.tabRef===plan.id);
      if(!member||member.kind!=='task_created')return tabReject(task,call,plan,'TAB_NOT_CLOSABLE','只能关闭本任务打开的标签页');
      if(member.tabId===task.tabId)return tabReject(task,call,plan,'TAB_ACTIVE','不能关闭执行标签页；请先用 tab_switch 切到其他成员');
      if((await store.owner(member.tabId))?.taskId!==task.taskId)return tabReject(task,call,plan,'TAB_NOT_CLOSABLE','该标签页已不属于本任务');
      let tab=null;try{tab=await tools.tab(member.tabId,true);}catch(error){if(error.code==='NAVIGATION')throw error; /* Already gone: only the directory changes. */ }
      if(tab&&!(task.allowedOrigins||[]).includes(originOf(tab)))return tabReject(task,call,plan,'TAB_NOT_CLOSABLE','该标签页已离开任务站点，可能正被你使用，不会关闭');
      const operationId=uuid();
      if(tab){
        const saved=await update(task.tabId,task.token,t=>{t.phase='executing';t.check=null;t.pending={tabId:task.tabId,origin:t.origin,scopeRevision:t.scopeRevision,plan,operationId,label:'tab_close',time:call.time};t.metrics={...t.metrics,actions:(t.metrics?.actions||0)+1};event(t,plan.reply);});
        if(!saved||!await live())return;
        try{await tools.closeTab(member.tabId);}catch{ /* Existence is checked below; never retried. */ }
        let open=true;try{await tools.tab(member.tabId,true);}catch(error){open=error.code==='NAVIGATION';}
        if(open)return update(task.tabId,task.token,t=>tabResult(t,call,plan,{status:'not_satisfied',dispatch:'unknown',code:'TAB_STILL_OPEN',recovery:'replan',operationId,message:member.tabRef+' 仍然打开，未重试关闭'}));
      }
      await serial(task.tabId,()=>store.changeMembers(task.tabId,{taskId:task.taskId,action:'closed',memberTabId:member.tabId,updatedAt:now()}));
      await update(task.tabId,task.token,t=>tabResult(t,call,plan,{status:'success',dispatch:tab?'sent':'not_sent',code:'TAB_CLOSED_BY_TASK',recovery:'observe',operationId,message:member.tabRef+' 已关闭并移出任务'}));
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
      if(task.origin==='browser'){const tab=await tools.tab(task.tabId,true);outcome=T.result({...G.evaluate(check.expected,{url:tab.url,page:{elements:[],regions:[]}}),dispatch:'not_sent',scope:'page'});}
      else if(tools.verify)outcome=T.normalize(await tools.verify(task.tabId,check,policyFor(task)));
      else{
        const snap=await tools.observe(task.tabId,undefined,policyFor(task));const evaluated=G.evaluate(check.expected,snap);
        outcome=T.result({...evaluated,scope:'page',code:evaluated.status==='success'?'CONDITIONS_MATCH':'CONDITIONS_UNMET'});
      }
      if(!await live())return;
      await update(task.tabId,task.token,t=>{
        const expired=now()>=check.deadline;
        const pending=outcome.status!=='success'&&!expired;
        // Unverified effects go back to the model with fresh evidence instead of pausing; nothing is re-sent here.
        const replannable=expired&&outcome.status!=='success'&&(check.kind==='action'||t.goalMode===true&&['wait','completion'].includes(check.kind));
        const verifyCap=caps(t).verify,reobserve=replannable&&(t.verificationRecoveries||0)<verifyCap;
        const finalOutcome=T.result({...outcome,operationId:check.operationId,dispatch:check.kind==='action'?(check.dispatch||'unknown'):outcome.dispatch,status:pending?'pending':outcome.status,recovery:pending?'wait':outcome.status==='success'?'none':reobserve?'replan':'pause',
          code:pending?'WAITING_CONDITIONS':outcome.status==='success'?'CONDITIONS_MATCH':expired&&!['verify','completion'].includes(check.kind)?'CONDITION_TIMEOUT':outcome.code});
        t.lastOutcome=finalOutcome;
        if(pending){t.status='waiting_page';t.phase='verifying';return;}
        t.check=null;t.waitDeadline=null;t.phase='observe';t.recoveryCount=0;
        t.results=t.results.concat({action:check.action||check.kind,origin:t.origin,tabRef:refOf(t),request:check.request,time:check.time||Date.now(),outcome:finalOutcome,result:finalOutcome.message});
        if(reobserve){
          t.verificationRecoveries=(t.verificationRecoveries||0)+1;
          // Field writes are idempotent: an observed mismatch may be rewritten, so only unknown or non-field effects are guarded.
          if(check.kind==='action'&&(outcome.status==='unknown'||!['fill','check','select'].includes(check.action)))t.uncertainClicks=(t.uncertainClicks||[]).concat({url:check.url,documentId:check.documentId,key:check.key,target:check.target}).slice(-2);
          t.status='running';event(t,(check.kind==='completion'?'完成条件尚未核实，继续推进':outcome.status==='not_satisfied'?'预期结果与页面不符，重新读取当前页面规划':'预期结果无法核对，重新读取当前页面规划')+'（'+t.verificationRecoveries+'/'+verifyCap+'）；未自动重发原操作');
        }else if(outcome.status==='success'){
          t.verificationRecoveries=0;
          if(check.kind==='completion'){t.status='completed';t.phase='idle';t.completionEvidence='verified';if(check.reply)t.results=t.results.concat({action:'done',result:check.reply,time:now()});event(t,check.reply);markReview(t);}
          else{t.status='running';event(t,'预期条件已核实，继续任务');}
        }else if(check.kind==='verify'){
          t.status='running';event(t,'验证未满足或结果未知，交给模型重新规划');
        }else{
          t.status='paused';t.reason='verification';event(t,'等待期限内未核实预期结果，已暂停；未重复发送原操作');
        }
      });
    }
    async function diagnostics(tabId,taskId){
      const tab=await tools.tab(tabId,true),task=await store.get(tabId);
      if(!task||task.taskId!==taskId||originOf(tab)!==task.origin)throw new Error('任务或网站已变化，请刷新后再导出');
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
        t.pending=null;t.phase='observe';t.status=result.navigation?'waiting_page':'running';t.lastOutcome=result;t.tabHops=0;
        if(t.check)t.check.dispatch=result.dispatch;
        if(result.status==='success'){t.check=null;t.waitDeadline=null;t.recoveryCount=0;}
        else if(t.check){t.phase='verifying';t.status='waiting_page';}
        const entry={request:pending.plan,time:pending.time||Date.now(),action:pending.plan.action,label:pending.label,sensitive:pending.sensitive,result:result.message||'操作已发出，下一轮检查页面',outcome:result,verification:result.verification,connection:result.connection};
        t.results=t.results.concat(entry);event(t,entry.result);
        if(result.legacy&&result.verification?.verified===false){t.status='paused';t.reason='verification';t.check=null;event(t,'字段结果尚未核实，已暂停，不能声称按指定答案完成');}
        const noChange=caps(t).noChange;
        if(t.results.length>=noChange&&t.results.slice(-noChange).every(r=>r.outcome?.code==='NO_CHANGE'&&r.label===entry.label&&r.action===entry.action)){
          t.status='paused';t.reason='no_progress';event(t,'连续 '+noChange+' 次未观察到进展，已暂停，请检查页面');
        }
      });
    }
    // One extra model request after completion proposes durable notes. It never touches the page,
    // is cancelled by any new input, and writes with the versions it read (a conflict stops it).
    async function reviewTask(tabId,initial){
      const {taskId,token}=initial,controller=new AbortController();
      controllers.set(taskId,controller);controllerTasks.set(tabId,taskId);
      // A review detached by 「新对话」 keeps running without its task record; CAS versions still guard every write.
      const live=async()=>{if(controller.signal.aborted||globalEditing)return false;if(detachedReviews.has(taskId))return true;const c=await store.get(tabId);return c?.taskId===taskId&&c.token===token&&c.status==='completed';};
      const close=text=>update(tabId,token,t=>{if(t.taskId!==taskId||t.reviewState!=='running')return;t.reviewState='done';if(text)event(t,text);});
      const done=[];
      const label=op=>(op.action==='delete'?'删除':'记住')+(op.scope==='site'?'网站笔记 ':'全局笔记 ')+op.id;
      try{
        const task=await update(tabId,token,t=>{if(t.taskId===taskId&&t.status==='completed'&&t.reviewState==='pending'){t.reviewState='running';t.steps++;}});
        if(task?.reviewState!=='running'||!await live())return;
        const site=task.origin!=='browser'&&siteMemory?await siteMemory.read(task.origin):null;
        const shared=globalMemory?await globalMemory.read(null):null;
        const skills=task.origin!=='browser'&&siteSkills?await siteSkills.read(task.origin):null;
        const response=await review(P.reviewInput(task,site,shared,skills),controller.signal);
        if(!await live())return;
        const {notes,skills:skillOps}=P.parseReview(response.text,{site:!!site,global:!!shared,skill:!!skills});
        let siteVersion=site?.version,globalVersion=shared?.version;
        for(const op of notes){
          if(!await live())return;
          const change={action:op.action,id:op.id,text:op.text,source:'model',signal:controller.signal};
          if(op.scope==='site')siteVersion=(await siteMemory.change(task.origin,{...change,expectedVersion:siteVersion})).version;
          else{
            globalVersion=(await globalMemory.change(null,{...change,expectedVersion:globalVersion})).version;
            globalEpoch++;for(const [id,other] of controllers)if(id!==taskId)other.abort();
          }
          done.push(label(op));
        }
        let skillVersion=skills?.version;
        for(const op of skillOps){
          if(!await live())return;
          skillVersion=(await siteSkills.change(task.origin,{action:op.action,id:op.id,description:op.description,text:op.text,expectedVersion:skillVersion,source:'model',signal:controller.signal})).version;
          done.push((op.action==='delete'?'删除技能 ':'保存技能 ')+op.id);
        }
        await close(done.length?'任务复盘：'+done.join('、')+'（可在设置「管理记忆」查看或修改）':null);
      }catch(error){
        if(await live())await close('任务复盘未完成：'+error.message+(done.length?'；已保存：'+done.join('、'):'')+'。任务结果不受影响');
      }finally{
        detachedReviews.delete(taskId);
        if(controllers.get(taskId)===controller){controllers.delete(taskId);if(controllerTasks.get(tabId)===taskId)controllerTasks.delete(tabId);}
      }
    }
    async function tick(tabId,expectedTaskId){
      const initial=await store.get(tabId);if(!initial||expectedTaskId&&initial.taskId!==expectedTaskId)return;
      const taskId=initial.taskId;if(jobs.has(taskId))return jobs.get(taskId);
      const job=turn(tabId,taskId);jobs.set(taskId,job);
      try{await job;}finally{
        if(jobs.get(taskId)===job)jobs.delete(taskId);
        const task=await store.get(tabId);
        if(task&&ACTIVE.has(task.status))schedule(tabId,task.retries?2000:task.status==='waiting_page'?1000:100);
        else {
          await tools.clearPointer?.(tabId);await cancelSchedule(tabId);
          // tab_switch / tab_open moved the binding: continue on the new executing tab.
          const moved=!task&&store.getByTaskId?await store.getByTaskId(taskId).catch(()=>null):null;
          if(moved&&moved.tabId!==tabId&&ACTIVE.has(moved.status))schedule(moved.tabId);
          if(task?.status==='completed'&&task.reviewState==='pending')await reviewTask(tabId,task);
        }
      }
    }
    // The executing tab closed while other members remain: pause on another member; unknown work is recorded, never replayed.
    function closedPatch(t,next){
      const results=[...(t.results||[])],uncertainClicks=[...(t.uncertainClicks||[])];
      const source=t.check?.kind==='action'?t.check:t.phase==='executing'?t.pending:null;
      const script=t.scriptRequest?.pending||(t.phase==='approved'&&t.pending?.plan?.action==='run_script'?t.pending:null);
      if(script)results.push(scriptEntry(t,script,'SCRIPT_DISCARDED','执行标签页已关闭，待执行的脚本已作废，未执行','observe',now()));
      if(source){
        const request=source.request||source.plan;
        results.push({action:request?.action||source.action,request,time:now(),origin:t.origin,tabRef:refOf(t),outcome:T.result({status:'unknown',dispatch:t.check?.dispatch||'unknown',scope:'dispatch',code:'TAB_CLOSED',recovery:'observe',operationId:source.operationId,message:'执行标签页已关闭，原操作结果未知，不会重放'})});
        if(source.url)uncertainClicks.push({url:source.url,documentId:source.documentId,key:source.targetKey||source.key,target:source.targetDescriptor||source.target});
      }
      const terminal=['completed','stopped','failed'].includes(t.status);
      const events=recent((t.events||[]).concat({time:now(),text:'执行标签页 '+refOf(t)+' 已关闭；任务暂停在 '+next.tabRef+'，点击继续将重新观察'}),40,16000);
      return {results,uncertainClicks:uncertainClicks.slice(-2),events,scriptRequest:null,pending:null,check:null,waitDeadline:null,phase:'observe',nextObservation:null,contextUsage:null,status:terminal?t.status:'paused',reason:terminal?t.reason:'active_tab_closed'};
    }
    async function memberClosed(tabId){
      // Abort synchronously before waiting for storage or a running update.
      controllerForTab(tabId)?.abort();
      const owner=store.owner?await store.owner(tabId):null;
      if(owner?.role==='member'){
        // A joined, non-executing member only leaves the directory; the task keeps running.
        if(owner.taskTabId===null)return null;
        return serial(owner.taskTabId,()=>store.changeMembers(owner.taskTabId,{taskId:owner.taskId,action:'closed',memberTabId:tabId,updatedAt:now()}));
      }
      return serial(tabId,async()=>{
        const task=await store.get(tabId);
        await cancelSchedule(tabId);
        if(!task)return null;
        controllers.get(task.taskId)?.abort();
        if(task.status!=='ended'&&store.switchTab)for(const member of (task.members||[]).filter(item=>item.tabId!==tabId)){
          try{await tools.tab(member.tabId,true);}catch{continue;}
          try{return await store.switchTab(tabId,{taskId:task.taskId,expectedRevision:task.scopeRevision,toTabId:member.tabId,token:uuid(),updatedAt:now(),closed:true,patch:closedPatch(task,member)});}
          catch(error){if(error.code!=='TAB_NOT_MEMBER')throw error;}
        }
        return store.closeMember(tabId,task.taskId,now());
      });
    }
    async function remove(tabId) {
      // Clearing a finished chat must not lose its review: users usually start a new chat right after a task ends.
      const current=await store.get(tabId);
      if(current?.status==='completed'&&current.reviewState==='running'&&controllers.has(current.taskId)){
        detachedReviews.add(current.taskId);if(controllerTasks.get(tabId)===current.taskId)controllerTasks.delete(tabId);
        await tools.clearPointer?.(tabId);await cancelSchedule(tabId);
      }else{controllerForTab(tabId)?.abort();await stop(tabId);}
      await serial(tabId,()=>store.remove(tabId));
    }
    async function recover() {
      // Missing tabs can have closed while the worker was unavailable. Query failure
      // propagates: absence must be proven, never inferred from a page access error.
      const existing=tools.existingTabIds?new Set(await tools.existingTabIds()):null;
      for(const task of await store.list()){
        if(existing&&!existing.has(task.tabId)){await memberClosed(task.tabId);continue;}
        if(existing)for(const member of task.members||[])if(member.tabId!==task.tabId&&!existing.has(member.tabId))await memberClosed(member.tabId);
        if(ACTIVE.has(task.status))schedule(task.tabId);
      }
    }
    return {start,submit,setGoalMode,resolve,choose,finish,stop,takeover,resume,approve,tick,recover,remove,memberClosed,sensitiveAccess,tabAccess,scriptApproval,revokeScriptApproval,reviewScriptApprovals,changeOrigins,members,changeMembers,reviewPermissions,navigationChanged,diagnostics,getSiteSkills,editSiteSkills,getSiteMemory,editSiteMemory,getGlobalMemory,editGlobalMemory,get:async tabId=>{const task=await store.get(tabId);return task&&tools.frameOrigins?{...task,rememberedFrameOrigins:await tools.frameOrigins(task.origin)}:task;}};
  }
  const api={createRuntime,recent};root.PageAgentRuntime=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
