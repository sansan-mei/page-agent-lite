(function(root){
  'use strict';
  const T=typeof module!=='undefined'?require('./tool-protocol.js'):root.PageAgentProtocol;
  const scripts=()=>typeof module!=='undefined'?require('./script-tools.js'):root.PageAgentScriptTools;
  function createBrowserTools(chrome,{confirmDelay=800}={}) {
    const F=(typeof module!=='undefined'?require('./frame-tools.js'):root.PageAgentFrameTools).create(chrome,T);
    // Real-input sessions (chrome.debugger): attached on first use for a task, released by the runtime.
    const D=(typeof module!=='undefined'?require('./cdp-tools.js'):root.PageAgentCdp).create(chrome);
    // Trusted startup inventory contains IDs only and is never offered to the model.
    async function existingTabIds(){return (await chrome.tabs.query({})).map(t=>t.id).filter(Number.isInteger);}
    // Trusted side-panel member picker only; tab titles and URLs are never offered to the model.
    async function listTabs(){return (await chrome.tabs.query({})).filter(t=>Number.isInteger(t.id)).map(t=>({id:t.id,url:typeof t.url==='string'?t.url:'',title:typeof t.title==='string'?t.title:''}));}
    async function hasOriginAccess(origin){return chrome.permissions.contains({origins:[origin+'/*']});}
    async function tab(tabId,allowInternal=false){
      let t;try{t=await chrome.tabs.get(tabId);}catch{throw Object.assign(new Error('目标标签页已关闭，请切换到需要操作的网页'),{code:'TAB_CLOSED'});}
      // A freshly created or navigating tab reports an empty url with pendingUrl/status loading until its first commit.
      if(!t.url&&(t.pendingUrl||t.status==='loading'))throw Object.assign(new Error('等待新页面开始加载'),{code:'NAVIGATION'});
      if(!t.url)throw new Error('无法读取网页地址，请重新加载扩展并确认新增的标签页权限');
      if(!allowInternal&&!['http:','https:'].includes(new URL(t.url).protocol))throw Object.assign(new Error('该页面不支持操作，请切换到普通 HTTP/HTTPS 网页'),{code:'UNSUPPORTED_PAGE'});
      return t;
    }
    async function checkOrigin(tabId,policy){
      if(!policy?.origin)return;
      const current=await tab(tabId);
      if(new URL(current.url).origin!==policy.origin||!policy.allowedOrigins?.includes(policy.origin))throw Object.assign(new Error('网页来源已超出当前读取范围'),{code:'ORIGIN_BOUNDARY'});
      if(!await hasOriginAccess(policy.origin))throw Object.assign(new Error('当前网站权限已撤销'),{code:'PERMISSION_DENIED'});
    }
    async function inject(tabId,policy=null){
      await checkOrigin(tabId,policy);await tab(tabId);
      try{await chrome.scripting.executeScript({target:{tabId,frameIds:[0]},injectImmediately:true,files:['tool-protocol.js','conditions.js','core.js','page-pointer.js','content.js'],world:'ISOLATED'});}
      catch{
        const t=await tab(tabId),origin=new URL(t.url).origin;
        if(!await chrome.permissions.contains({origins:[origin+'/*']}))throw Object.assign(new Error('尚未授权当前网站，请点击侧边栏「授权当前网站」后重试'),{code:'PERMISSION_DENIED'});
        throw Object.assign(new Error('浏览器不允许访问该页面，扩展商店或受保护页面无法操作；普通网页请刷新后重试'),{code:'UNSUPPORTED_PAGE'});
      }
    }
    async function call(tabId,message){
      const response=await chrome.tabs.sendMessage(tabId,message,{frameId:0});
      if(!response?.ok){const e=new Error(response?.error||'页面工具通信失败');e.code=response?.code||(response?.ok===false?'TOOL_ERROR':undefined);e.result=response?.result;throw e;}return response.value;
    }
    // Read-only probe of the content script's per-document id; a new document answers with a different id.
    async function documentId(tabId,policy=null){return (await call(tabId,{type:'agent:document',...(policy?.origin?{expectedOrigin:policy.origin}:{})}))?.documentId||null;}
    async function observeTop(tabId,textOffset=0,policy=null){
      const message={type:'agent:observe',textOffset,...(policy?.sensitiveFields===true?{sensitiveFields:true}:{}),...(policy?.origin?{expectedOrigin:policy.origin}:{})};
      await checkOrigin(tabId,policy);
      try{return await call(tabId,message);}catch(error){
        if(error.code)throw error;
        try {
          await inject(tabId,policy);await checkOrigin(tabId,policy);
          return await call(tabId,message);
        } catch(reconnectError) {
          if(!reconnectError.code&&(await tab(tabId)).status==='loading')throw Object.assign(new Error('等待页面连接'),{code:'NAVIGATION'});
          throw reconnectError;
        }
      }
    }
    async function observe(tabId,textOffset=0,policy=null){
      const top=await observeTop(tabId,textOffset,policy);
      const combined=await F.observe(tabId,top,textOffset,policy);
      return combined;
    }
    async function navigate(tabId,pending,policy,live){
      const destination=new URL(pending.plan.value),source=new URL(pending.url);
      if(!['http:','https:'].includes(destination.protocol)||destination.username||destination.password)throw Object.assign(new Error('导航超出当前任务站点或 URL 不安全'),{code:'NAVIGATION_DENIED'});
      if(!await hasOriginAccess(destination.origin))throw Object.assign(new Error('目标网站权限尚未授权'),{code:'PERMISSION_DENIED'});
      const browserStart=policy?.origin==='browser'&&!['http:','https:'].includes(source.protocol);
      if(!browserStart&&!await chrome.permissions.contains({origins:[source.origin+'/*']}))throw Object.assign(new Error('当前网站权限已撤销'),{code:'PERMISSION_DENIED'});
      if((await tab(tabId,true)).url!==pending.url)throw Object.assign(new Error('导航来源页面已变化'),{code:'STALE'});
      try{if(!browserStart)await call(tabId,{type:'agent:prepare-navigation',...pending});}catch(error){throw Object.assign(new Error('导航前快照无法核实，请重新观察'),{code:error.code||'STALE'});}
      if((await tab(tabId,true)).url!==pending.url)throw Object.assign(new Error('导航来源页面已变化'),{code:'STALE'});
      if(live&&!await live())throw Object.assign(new Error('导航请求已取消'),{code:'CANCELLED'});
      let dispatch='sent',code='NAVIGATION_DISPATCHED';
      try{await chrome.tabs.update(tabId,{url:destination.href});}catch{dispatch='unknown';code='NAVIGATION_UNKNOWN';}
      return {...T.result({operationId:pending.operationId,documentId:pending.documentId,status:'unknown',dispatch,scope:'dispatch',code,recovery:'wait',message:'导航已请求；重新观察并核对 URL，不重发结果不确定的导航'}),navigation:true};
    }
    // Real-input fallback (click/hover on a top-document or same-origin frame target): only when synthetic events
    // cannot reach the target (nothing was sent), or a synthetic attempt is confirmed ineffective — same document and
    // URL, page fingerprint unchanged right after it and again after confirmDelay, expected not met, no high-risk label.
    // Anything uncertain keeps the synthetic result. The point comes from the content script for the same target.
    const RISKY=/提交|删除|支付|购买|发布|发送|确认订单|submit|delete|pay|purchase|publish|send/i;
    async function realInput(tabId,pending,policy,live,synthetic,reason){
      const {pageChange,...base}=synthetic,action=pending.plan?.action,unreachable=reason==='unreachable';
      const note=cdp=>({...base,observed:{...(base.observed&&typeof base.observed==='object'?base.observed:{}),input:unreachable?'none':'synthetic',...(cdp?{cdp:{code:cdp.code||'CDP_SKIPPED',message:String(cdp.message||'').slice(0,160)}}:{})}});
      if(!['click','hover'].includes(action)||pending.frameRoute)return unreachable?note({code:'CDP_UNAVAILABLE',message:'该目标不支持真实输入'}):base;
      if(!unreachable&&!(base.dispatch==='sent'&&base.status!=='success'&&pageChange==='NO_CHANGE'&&!base.navigation&&!pending.plan.notice&&!RISKY.test(pending.label||'')))return base;
      if(!D.available()||typeof policy?.taskId!=='string')return unreachable?note({code:'CDP_UNAVAILABLE',message:'真实输入不可用'}):base;
      if(!unreachable&&confirmDelay)await new Promise(resolve=>setTimeout(resolve,confirmDelay));
      if(live&&!await live())return base;
      const message={operationId:pending.operationId,url:pending.url,sensitiveFields:policy?.sensitiveFields===true,...(policy?.origin?{expectedOrigin:policy.origin}:{})};
      let point;
      try{await checkOrigin(tabId,policy);if((await tab(tabId)).url!==pending.url)throw Object.assign(new Error('页面地址已变化'),{code:'PAGE_CHANGED'});point=await call(tabId,{type:'agent:point',reason,...message});}
      catch(error){return note(error);}
      try{await D.input(tabId,policy.taskId,action,point,live);}
      catch(error){
        if(error.dispatch!=='unknown')return note(error);
        return T.result({operationId:pending.operationId,documentId:pending.documentId,status:'unknown',dispatch:'unknown',scope:'dispatch',code:/^CDP_/.test(error.code)?error.code:'CDP_COMMAND_FAILED',recovery:'observe',observed:{input:'cdp',fallback:reason},message:'真实输入中途失败，结果不确定；重新读取页面核对，不会重发'});
      }
      const lead=unreachable?'合成事件无法到达目标，已改用真实输入：':'合成操作无效，已改用真实输入：';
      try{
        const settled=T.normalize(await call(tabId,{type:'agent:settle',...message}),{operationId:pending.operationId,documentId:pending.documentId});
        return {...settled,observed:{...(settled.observed||{}),input:'cdp',fallback:reason},message:(lead+settled.message).slice(0,500)};
      }catch{
        // The real click may have navigated the page: re-read and check, never replay.
        const current=await tab(tabId).catch(()=>null),moved=!current||current.status==='loading'||current.url!==pending.url;
        return {...T.result({operationId:pending.operationId,documentId:pending.documentId,status:'unknown',dispatch:'sent',scope:'dispatch',code:moved?'DOCUMENT_CHANGED':'CDP_RESULT_UNKNOWN',recovery:'observe',observed:{input:'cdp',fallback:reason},message:lead+'回执未返回；重新读取页面核对，不重复操作'}),navigation:moved};
      }
    }
    async function execute(tabId,pending,policy=null,live=null){
      if(pending.plan?.action==='navigate')return navigate(tabId,pending,policy,live);
      // run_script runs through userScripts after the runtime's approval step (auto-approved only in the developer build).
      const S=scripts();if(S?.handles(pending.plan?.action)){if(live&&!await live())throw Object.assign(new Error('脚本请求已取消'),{code:'CANCELLED'});return S.execute(chrome,T,tabId,pending,policy,{checkOrigin,tab,live,documentId});}
      if(pending.frameRoute||pending.expected?.some(c=>c.target?.frame?.startsWith('remote:')))return F.execute(tabId,pending,policy,live,{checkOrigin,call,observe});
      let synthetic;
      try{synthetic=T.normalize(await call(tabId,{type:'agent:execute',...pending,sensitiveFields:policy?.sensitiveFields===true}),{operationId:pending.operationId,documentId:pending.documentId});}catch(error){
        if(error.code==='SYNTHETIC_UNREACHABLE'&&error.result)return realInput(tabId,pending,policy,live,error.result,'unreachable');
        if(error.code)throw error;
        // A lost response does not tell us whether the click succeeded. Reconnect
        // observation only, NEVER replay the side effect.
        const current=await tab(tabId);
        if(current.status==='loading'||current.url!==pending.url)return T.normalize({navigation:true,connection:'document_changed',message:'操作回执未返回，网页已切换或正在加载；等待后读取新页面核对，不重复点击'},{operationId:pending.operationId});
        await observe(tabId,0,policy);
        return T.normalize({navigation:false,connection:'reconnected',message:'操作回执丢失，但页面已重新连接；下一轮根据当前页面核对操作结果，连接问题已恢复，不重复点击'},{operationId:pending.operationId});
      }
      return realInput(tabId,pending,policy,live,synthetic,'no_effect');
    }
    async function verify(tabId,operation,policy=null){
      await checkOrigin(tabId,policy);
      if(operation.expected?.some(c=>c.target?.frame?.startsWith('remote:'))){
        const snap=await observe(tabId,0,policy),G=typeof module!=='undefined'?require('./conditions.js'):root.PageAgentConditions;
        const checked=G.evaluate(operation.expected,snap);
        return T.result({...checked,operationId:operation.operationId,dispatch:'not_sent',scope:'page',code:checked.status==='success'?'CONDITIONS_MATCH':'CONDITIONS_UNMET',recovery:'wait'});
      }
      try{return T.normalize(await call(tabId,{type:'agent:verify',operationId:operation.operationId,expected:operation.expected,sensitiveFields:policy?.sensitiveFields===true,...(policy?.origin?{expectedOrigin:policy.origin}:{})}));}
      catch(error){
        if(error.code)throw error;
        await observe(tabId,0,policy);
        return T.normalize(await call(tabId,{type:'agent:verify',operationId:operation.operationId,expected:operation.expected,sensitiveFields:policy?.sensitiveFields===true,...(policy?.origin?{expectedOrigin:policy.origin}:{})}));
      }
    }
    // Task tab lifecycle: open in the opener's window without taking focus; close only by tabId.
    async function openTab(url,{openerTabId}={}){
      const destination=new URL(url);
      if(!['http:','https:'].includes(destination.protocol)||destination.username||destination.password)throw Object.assign(new Error('只能打开不含凭据的 HTTP/HTTPS 网址'),{code:'NAVIGATION_DENIED'});
      if(!await hasOriginAccess(destination.origin))throw Object.assign(new Error('目标网站权限尚未授权'),{code:'PERMISSION_DENIED'});
      const opener=await tab(openerTabId,true);
      const created=await chrome.tabs.create({url:destination.href,active:false,windowId:opener.windowId,openerTabId});
      if(!Number.isInteger(created?.id))throw Object.assign(new Error('浏览器未返回新标签页'),{code:'TAB_OPEN_UNKNOWN'});
      return {id:created.id};
    }
    async function closeTab(tabId){await chrome.tabs.remove(tabId);}
    async function clearPointer(tabId){
      try{await call(tabId,{type:'agent:clear-pointer'});}catch{ /* Page may already be gone. */ }
      try{const frames=await chrome.webNavigation?.getAllFrames({tabId});await Promise.allSettled((frames||[]).filter(f=>f.frameId!==0).map(f=>chrome.tabs.sendMessage(tabId,{type:'agent:clear-pointer'},{frameId:f.frameId})));}catch{ /* No live frame inventory. */ }
    }
    return {frameOrigins:F.frameOrigins,rememberFrame:F.rememberFrame,forgetFrame:F.forgetFrame,tab,existingTabIds,listTabs,hasOriginAccess,inject,observe,execute,verify,clearPointer,openTab,closeTab,releaseInput:tabId=>D.release(tabId)};
  }
  root.PageAgentBrowserTools={createBrowserTools};
  if(typeof module!=='undefined')module.exports=root.PageAgentBrowserTools;
})(globalThis);
