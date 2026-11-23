(function(root){
  'use strict';
  const T=typeof module!=='undefined'?require('./tool-protocol.js'):root.PageAgentProtocol;
  function createBrowserTools(chrome) {
    async function tab(tabId){
      let t;try{t=await chrome.tabs.get(tabId);}catch{throw Object.assign(new Error('目标标签页已关闭，请切换到需要操作的网页'),{code:'TAB_CLOSED'});}
      if(!t.url)throw new Error('无法读取网页地址，请重新加载扩展并确认新增的标签页权限');
      if(!['http:','https:'].includes(new URL(t.url).protocol))throw Object.assign(new Error('该页面不支持操作，请切换到普通 HTTP/HTTPS 网页'),{code:'UNSUPPORTED_PAGE'});
      return t;
    }
    async function inject(tabId){
      await tab(tabId);
      try{await chrome.scripting.executeScript({target:{tabId,frameIds:[0]},injectImmediately:true,files:['tool-protocol.js','conditions.js','core.js','content.js'],world:'ISOLATED'});}
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
    async function observe(tabId){
      try{return await call(tabId,{type:'agent:observe'});}catch(error){
        if(error.code)throw error;
        try {
          await inject(tabId);
          return await call(tabId,{type:'agent:observe'});
        } catch(reconnectError) {
          if(!reconnectError.code&&(await tab(tabId)).status==='loading')throw Object.assign(new Error('等待页面连接'),{code:'NAVIGATION'});
          throw reconnectError;
        }
      }
    }
    async function execute(tabId,pending){
      try{return T.normalize(await call(tabId,{type:'agent:execute',...pending}),{operationId:pending.operationId,documentId:pending.documentId});}catch(error){
        if(error.code)throw error;
        // A lost response does not tell us whether the click succeeded. Reconnect
        // observation only, NEVER replay the side effect.
        const current=await tab(tabId);
        if(current.status==='loading'||current.url!==pending.url)return T.normalize({navigation:true,connection:'document_changed',message:'操作回执未返回，网页已切换或正在加载；等待后读取新页面核对，不重复点击'},{operationId:pending.operationId});
        await observe(tabId);
        return T.normalize({navigation:false,connection:'reconnected',message:'操作回执丢失，但页面已重新连接；下一轮根据当前页面核对操作结果，连接问题已恢复，不重复点击'},{operationId:pending.operationId});
      }
    }
    async function verify(tabId,operation){
      try{return T.normalize(await call(tabId,{type:'agent:verify',operationId:operation.operationId,expected:operation.expected}));}
      catch(error){
        if(error.code)throw error;
        await observe(tabId);
        return T.normalize(await call(tabId,{type:'agent:verify',operationId:operation.operationId,expected:operation.expected}));
      }
    }
    return {tab,inject,observe,execute,verify};
  }
  root.PageAgentBrowserTools={createBrowserTools};
  if(typeof module!=='undefined')module.exports=root.PageAgentBrowserTools;
})(globalThis);
