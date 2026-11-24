// run_script: model-written JavaScript in the task tab through chrome.userScripts.execute.
// Loaded by the service worker (before core.js) and the options page, never by content scripts,
// so the page-side executor keeps refusing the action. The store build pauses each run for
// side-panel approval (runtime.scriptApproval) unless the user allowed scripts for this task on
// the same tab and origin (task.scriptApproval); only the local developer build sets
// PageAgentDevFlags.autoApproveScripts. userScripts is an optional permission in the store
// manifest; running also needs Chrome 135+ and the "Allow User Scripts" toggle (Chrome 138+).
(function(root){
  'use strict';
  const MAX_CODE=20000,MAX_RESULT=4000,TIMEOUT_MS=30000,PERMISSION='userScripts';
  // tool-protocol drops observed beyond 4500 JSON characters, so escaped text is trimmed to fit.
  function fit(text){let s=String(text).slice(0,MAX_RESULT);while(s&&JSON.stringify(s).length>4200)s=s.slice(0,Math.floor(s.length*0.9));return s;}
  const registry=Object.freeze({run_script:{route:'browser',effect:'page',target:'none',timeout:false,guard:false}});
  const handles=name=>typeof name==='string'&&Object.prototype.hasOwnProperty.call(registry,name);
  function source(plan){return typeof plan.value==='string'?{code:plan.value,world:'USER_SCRIPT'}:{code:plan.value.code,world:plan.value.world==='MAIN'?'MAIN':'USER_SCRIPT'};}
  function validate(p){
    const v=p.value,object=v&&typeof v==='object'&&!Array.isArray(v);
    if(!(typeof v==='string'||object&&typeof v.code==='string'&&Object.keys(v).every(k=>['code','world'].includes(k))&&(v.world===undefined||['MAIN','USER_SCRIPT'].includes(v.world))))throw new Error('run_script 需要字符串代码，或 {code, world:"USER_SCRIPT"|"MAIN"}');
    const {code}=source(p);
    if(!code.trim()||code.length>MAX_CODE)throw new Error('run_script 代码为空或超过 '+MAX_CODE+' 字符');
    if(p.id!==undefined)throw new Error('run_script 不接受元素 id；在代码里自行查找节点');
  }
  // The model's code is an async function body: `return` sends a value back. Results are
  // stringified inside the page so non-cloneable values (nodes, functions) still come back as text.
  function wrap(code){
    return `(async()=>{let __pal;try{__pal=await (async()=>{\n${code}\n})();}catch(e){return {__palError:String(e&&e.stack||e).slice(0,${MAX_RESULT})};}\nlet s;try{s=typeof __pal==='string'?__pal:JSON.stringify(__pal);}catch{s=String(__pal);}\nreturn {__palValue:s===undefined?'undefined':String(s).slice(0,${MAX_RESULT+1})};})()`;
  }
  // permission: optional userScripts granted (always true in the developer build);
  // api: chrome.userScripts.execute usable (Chrome 135+ and the user-script toggle on).
  async function status(chrome){
    let permission=false,api=false;
    try{permission=await chrome.permissions.contains({permissions:[PERMISSION]});}catch{permission=false;}
    if(permission)try{const u=chrome.userScripts;if(u&&typeof u.execute==='function'&&typeof u.getScripts==='function'){await u.getScripts();api=true;}}catch{api=false;}
    return {permission,api,available:permission&&api};
  }
  function unavailableMessage(state){
    if(!state?.permission)return '脚本执行未开启：请在设置页「脚本执行」点击「授权脚本执行」，再到 chrome://extensions 本扩展「详情」中打开「允许用户脚本」';
    return '脚本执行不可用：需 Chrome 135 或更高版本，并在 chrome://extensions 本扩展「详情」中打开「允许用户脚本」（Chrome 138 以下改为打开右上角「开发者模式」）';
  }
  const stale=message=>Object.assign(new Error(message),{code:'STALE'});
  async function execute(chrome,T,tabId,pending,policy,helpers){
    await helpers.checkOrigin(tabId,policy);
    const current=await helpers.tab(tabId);
    if(current.url!==pending.url)throw stale('页面已变化，脚本未执行；重新观察后再决定');
    const state=await status(chrome);
    if(!state.available)throw Object.assign(new Error(unavailableMessage(state)),{code:'PERMISSION_DENIED'});
    if(helpers.documentId){
      let id=null;try{id=await helpers.documentId(tabId,policy);}catch{id=null;}
      if(!pending.documentId||id!==pending.documentId)throw stale('页面文档已变化，脚本未执行；重新观察后再决定');
    }
    if(helpers.live&&!await helpers.live())throw Object.assign(new Error('脚本请求已取消'),{code:'CANCELLED'});
    const {code,world}=source(pending.plan);
    const base={operationId:pending.operationId,documentId:pending.documentId,dispatch:'sent',scope:'dispatch',recovery:'observe'};
    if(world==='USER_SCRIPT')try{await chrome.userScripts.configureWorld({csp:"script-src 'self' 'unsafe-eval' 'unsafe-inline'",messaging:false});}catch{ /* default world CSP still allows the wrapper */ }
    let timer;
    const timeout=new Promise(resolve=>{timer=setTimeout(()=>resolve('timeout'),TIMEOUT_MS);});
    let results;
    try{results=await Promise.race([chrome.userScripts.execute({target:{tabId,frameIds:[0]},js:[{code:wrap(code)}],world,injectImmediately:true}),timeout]);}
    catch(error){return T.result({...base,dispatch:'unknown',status:'error',code:'SCRIPT_ERROR',message:'脚本注入失败：'+String(error?.message||error).slice(0,500)});}
    finally{clearTimeout(timer);}
    if(results==='timeout')return T.result({...base,status:'unknown',code:'SCRIPT_TIMEOUT',message:'脚本 '+TIMEOUT_MS/1000+' 秒内未返回；它可能仍在页面中运行，重新观察核对，不要重复执行'});
    const first=Array.isArray(results)?results[0]:null,value=first?.result;
    if(first?.error||value?.__palError!==undefined)return T.result({...base,status:'error',code:'SCRIPT_ERROR',observed:{error:fit(first?.error||value.__palError)},message:'脚本抛出异常，见 observed.error'});
    const text=typeof value?.__palValue==='string'?value.__palValue:'undefined',result=fit(text);
    return T.result({...base,status:'success',code:'SCRIPT_RESULT',observed:{result,truncated:result.length<text.length,world},message:'脚本已执行，返回值见 observed.result；页面可能已变化，下一轮重新观察'});
  }
  // Appended to the system prompt only on turns where run_script is offered.
  const prompt=` OPTIONAL TOOL run_script (offered only while the user has enabled script execution) is the single exception to the "no scripts" rule. Its value is JavaScript source (string, max ${MAX_CODE} chars) or {code, world}; it runs as an async function body in the current tab's top frame, so use return to send back a value (stringified, max ${MAX_RESULT} chars, in outcome.observed.result; exceptions in outcome.observed.error). world defaults to USER_SCRIPT (isolated, DOM access, exempt from page CSP); use world "MAIN" only when page JavaScript globals are needed. Do not pass id. Prefer the normal tools when they work; use run_script for reading or operating what they cannot reach (cross-origin or nested iframes, shadow roots, framework state, bulk extraction). Keep scripts short and readable: the user may have to read and approve each run. Outcome SCRIPT_REJECTED (dispatch not_sent) means the user declined that script: do not resend it, use the normal tools or another method, or pause to ask. STALE or SCRIPT_DISCARDED means it did not run. Scripts may have side effects: never rerun a script whose outcome is unknown, and observe again afterwards because element IDs become stale.`;
  // Native tool schema for run_script, in the [description, parameters, required] shape of prompts.js.
  const tools=Object.freeze({run_script:['Run JavaScript in the current tab and return a value; the user may have to approve each run.',{value:{anyOf:[{type:'string'},{type:'object',properties:{code:{type:'string'},world:{type:'string',enum:['USER_SCRIPT','MAIN']}},required:['code']}],description:'Async function body, or {code, world}'}},['value']]});
  root.PageAgentScriptTools=Object.freeze({registry,validate,source,execute,status,unavailableMessage,prompt,tools,handles,permission:PERMISSION,limits:Object.freeze({code:MAX_CODE,result:MAX_RESULT,timeoutMs:TIMEOUT_MS})});
  if(typeof module!=='undefined')module.exports=root.PageAgentScriptTools;
})(globalThis);
