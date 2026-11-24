(function(root){
  'use strict';
  const T=typeof module!=='undefined'?require('./tool-protocol.js'):root.PageAgentProtocol;
  function createBrowserTools(chrome) {
    // Trusted startup inventory contains IDs only and is never offered to the model.
    async function existingTabIds(){return (await chrome.tabs.query({})).map(t=>t.id).filter(Number.isInteger);}
    // Trusted side-panel member picker only; tab titles and URLs are never offered to the model.
    async function listTabs(){return (await chrome.tabs.query({})).filter(t=>Number.isInteger(t.id)).map(t=>({id:t.id,url:typeof t.url==='string'?t.url:'',title:typeof t.title==='string'?t.title:''}));}
    async function hasOriginAccess(origin){return chrome.permissions.contains({origins:[origin+'/*']});}
    async function tab(tabId){
      let t;try{t=await chrome.tabs.get(tabId);}catch{throw Object.assign(new Error('目标标签页已关闭，请切换到需要操作的网页'),{code:'TAB_CLOSED'});}
      if(!t.url)throw new Error('无法读取网页地址，请重新加载扩展并确认新增的标签页权限');
      if(!['http:','https:'].includes(new URL(t.url).protocol))throw Object.assign(new Error('该页面不支持操作，请切换到普通 HTTP/HTTPS 网页'),{code:'UNSUPPORTED_PAGE'});
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
    async function observe(tabId,textOffset=0,policy=null){
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
    async function navigate(tabId,pending,policy,live){
      const destination=new URL(pending.plan.value),source=new URL(pending.url);
      if(!['http:','https:'].includes(destination.protocol)||!(policy?.allowedOrigins||[source.origin]).includes(destination.origin)||destination.username||destination.password)throw Object.assign(new Error('导航超出当前任务站点或 URL 不安全'),{code:'NAVIGATION_DENIED'});
      if(!await hasOriginAccess(destination.origin))throw Object.assign(new Error('目标网站权限尚未授权'),{code:'PERMISSION_DENIED'});
      if(!await chrome.permissions.contains({origins:[source.origin+'/*']}))throw Object.assign(new Error('当前网站权限已撤销'),{code:'PERMISSION_DENIED'});
      if((await tab(tabId)).url!==pending.url)throw Object.assign(new Error('导航来源页面已变化'),{code:'STALE'});
      try{await call(tabId,{type:'agent:prepare-navigation',...pending});}catch(error){throw Object.assign(new Error('导航前快照无法核实，请重新观察'),{code:error.code||'STALE'});}
      if((await tab(tabId)).url!==pending.url)throw Object.assign(new Error('导航来源页面已变化'),{code:'STALE'});
      if(live&&!await live())throw Object.assign(new Error('导航请求已取消'),{code:'CANCELLED'});
      let dispatch='sent',code='NAVIGATION_DISPATCHED';
      try{await chrome.tabs.update(tabId,{url:destination.href});}catch{dispatch='unknown';code='NAVIGATION_UNKNOWN';}
      return {...T.result({operationId:pending.operationId,documentId:pending.documentId,status:'unknown',dispatch,scope:'dispatch',code,recovery:'wait',message:'导航已请求；重新观察并核对 URL，不重发结果不确定的导航'}),navigation:true};
    }
    async function execute(tabId,pending,policy=null,live=null){
      if(pending.plan?.action==='navigate')return navigate(tabId,pending,policy,live);
      try{return T.normalize(await call(tabId,{type:'agent:execute',...pending,sensitiveFields:policy?.sensitiveFields===true}),{operationId:pending.operationId,documentId:pending.documentId});}catch(error){
        if(error.code)throw error;
        // A lost response does not tell us whether the click succeeded. Reconnect
        // observation only, NEVER replay the side effect.
        const current=await tab(tabId);
        if(current.status==='loading'||current.url!==pending.url)return T.normalize({navigation:true,connection:'document_changed',message:'操作回执未返回，网页已切换或正在加载；等待后读取新页面核对，不重复点击'},{operationId:pending.operationId});
        await observe(tabId,0,policy);
        return T.normalize({navigation:false,connection:'reconnected',message:'操作回执丢失，但页面已重新连接；下一轮根据当前页面核对操作结果，连接问题已恢复，不重复点击'},{operationId:pending.operationId});
      }
    }
    async function verify(tabId,operation,policy=null){
      await checkOrigin(tabId,policy);
      try{return T.normalize(await call(tabId,{type:'agent:verify',operationId:operation.operationId,expected:operation.expected,sensitiveFields:policy?.sensitiveFields===true,...(policy?.origin?{expectedOrigin:policy.origin}:{})}));}
      catch(error){
        if(error.code)throw error;
        await observe(tabId,0,policy);
        return T.normalize(await call(tabId,{type:'agent:verify',operationId:operation.operationId,expected:operation.expected,sensitiveFields:policy?.sensitiveFields===true,...(policy?.origin?{expectedOrigin:policy.origin}:{})}));
      }
    }
    async function clearPointer(tabId){try{await call(tabId,{type:'agent:clear-pointer'});}catch{ /* Page may already be gone. */ }}
    return {tab,existingTabIds,listTabs,hasOriginAccess,inject,observe,execute,verify,clearPointer};
  }
  root.PageAgentBrowserTools={createBrowserTools};
  if(typeof module!=='undefined')module.exports=root.PageAgentBrowserTools;
})(globalThis);
