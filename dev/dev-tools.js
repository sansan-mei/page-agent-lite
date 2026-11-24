// Developer build only. `npm run build:dev` copies this file into dist/extension-dev/ and loads it
// before core.js; the store package (extension/) never contains it, so run_script does not exist there.
// run_script executes model-written JavaScript in the current tab through chrome.userScripts.execute
// (Chrome 135+, "Allow User Scripts" toggle on the extension details page).
(function(root){
  'use strict';
  const MAX_CODE=20000,MAX_RESULT=4000,TIMEOUT_MS=30000;
  // tool-protocol drops observed beyond 4500 JSON characters, so escaped text is trimmed to fit.
  function fit(text){let s=String(text).slice(0,MAX_RESULT);while(s&&JSON.stringify(s).length>4200)s=s.slice(0,Math.floor(s.length*0.9));return s;}
  const registry=Object.freeze({run_script:{route:'browser',effect:'page',target:'none',timeout:false,guard:false}});
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
  function available(chrome){try{chrome.userScripts.getScripts();return typeof chrome.userScripts.execute==='function';}catch{return false;}}
  async function execute(chrome,T,tabId,pending,policy,helpers){
    await helpers.checkOrigin(tabId,policy);
    const current=await helpers.tab(tabId);
    if(current.url!==pending.url)throw Object.assign(new Error('页面已变化，重新观察后再执行脚本'),{code:'STALE'});
    if(!chrome.userScripts||!available(chrome))throw Object.assign(new Error('开发版脚本不可用：需 Chrome 135+，并在扩展详情页打开「允许用户脚本」（138 以下为打开开发者模式）'),{code:'PERMISSION_DENIED'});
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
  const prompt=` DEVELOPER BUILD OVERRIDE: this local build adds action run_script and lifts the "no scripts" rule for it only. run_script value is JavaScript source (string, max ${MAX_CODE} chars) or {code, world}; it runs as an async function body in the current tab's top frame, so use return to send back a value (stringified, max ${MAX_RESULT} chars, in outcome.observed.result; exceptions in outcome.observed.error). world defaults to USER_SCRIPT (isolated, DOM access, exempt from page CSP); use world "MAIN" only when page JavaScript globals are needed. Do not pass id. Prefer the normal tools when they work; use run_script for reading or operating what they cannot reach (cross-origin or nested iframes, shadow roots, framework state, bulk extraction). Scripts may have side effects: never rerun a script whose outcome is unknown, and observe again afterwards because element IDs become stale.`;
  root.PageAgentDevTools=Object.freeze({registry,validate,execute,prompt,handles:name=>Object.prototype.hasOwnProperty.call(registry,name)});
  if(typeof module!=='undefined')module.exports=root.PageAgentDevTools;
})(globalThis);
