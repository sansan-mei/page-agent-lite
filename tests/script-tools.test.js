const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');
const S=require('../extension/script-tools.js');
const C=require('../extension/core.js');
const T=require('../extension/tool-protocol.js');
const {createBrowserTools}=require('../extension/browser-tools.js');

function fakeChrome({permission=true,api=true,execute}={}){
  const calls=[];
  const chrome={calls,
    tabs:{async get(){return {url:'https://example.test/page',status:'complete'};}},
    permissions:{async contains(q){return q.permissions?permission:true;}}};
  Object.defineProperty(chrome,'userScripts',{configurable:true,get(){
    // Chrome 138+ with the toggle off (or no permission) exposes no usable API.
    if(!permission)return undefined;
    return {getScripts(){if(!api)return Promise.reject(Error('Disabled'));return Promise.resolve([]);},async configureWorld(c){calls.push(['configure',c]);},async execute(i){calls.push(['execute',i]);return execute(i);}};
  }});
  return chrome;
}
const policy={origin:'https://example.test',allowedOrigins:['https://example.test']};
const pending=value=>({operationId:'op1',documentId:'d1',url:'https://example.test/page',plan:{action:'run_script',value}});
const helpers={checkOrigin:async()=>{},tab:async()=>({url:'https://example.test/page'}),documentId:async()=>'d1'};
const inPage=document=>async i=>[{frameId:0,result:await vm.runInNewContext(i.js[0].code,{document})}];

test('agentPlan validates run_script values in the worker registry',()=>{
  const snap={nodes:new Map()};
  assert.equal(C.agentTool('run_script').route,'browser');
  assert.equal(C.agentPlan(JSON.stringify({reply:'r',action:'run_script',value:'return document.title'}),snap).value,'return document.title');
  assert.equal(C.agentPlan(JSON.stringify({reply:'r',action:'run_script',value:{code:'return 1',world:'MAIN'}}),snap).value.world,'MAIN');
  for(const value of ['',' ','x'.repeat(20001),{code:'1',world:'ISOLATED'},{code:'1',extra:1},42,['1']])
    assert.throws(()=>C.agentPlan(JSON.stringify({reply:'r',action:'run_script',value}),snap),/run_script/);
  assert.throws(()=>C.agentPlan(JSON.stringify({reply:'r',action:'run_script',value:'1',id:'t1'}),snap),/id/);
});

test('status separates the optional permission from a usable userScripts API',async()=>{
  assert.deepEqual(await S.status(fakeChrome({permission:false})),{permission:false,api:false,available:false});
  assert.deepEqual(await S.status(fakeChrome({api:false})),{permission:true,api:false,available:false});
  assert.deepEqual(await S.status(fakeChrome()),{permission:true,api:true,available:true});
  // Chrome < 135: userScripts exists but has no execute().
  const old=fakeChrome();Object.defineProperty(old,'userScripts',{value:{getScripts:async()=>[]}});
  assert.equal((await S.status(old)).available,false);
  assert.match(S.unavailableMessage({permission:false}),/设置页「脚本执行」/);
  assert.match(S.unavailableMessage({permission:true,api:false}),/Chrome 135[\s\S]*允许用户脚本[\s\S]*开发者模式/);
});

test('run_script executes through userScripts and returns the stringified value',async()=>{
  const chrome=fakeChrome({execute:inPage({title:'Hello'})});
  const r=await S.execute(chrome,T,1,pending('return {title:document.title,n:[1,2]}'),policy,helpers);
  assert.equal(r.status,'success');assert.equal(r.code,'SCRIPT_RESULT');assert.equal(r.dispatch,'sent');
  assert.equal(r.observed.result,'{"title":"Hello","n":[1,2]}');assert.equal(r.observed.world,'USER_SCRIPT');
  const exec=chrome.calls.find(c=>c[0]==='execute')[1];
  assert.deepEqual(exec.target,{tabId:1,frameIds:[0]});assert.equal(exec.world,'USER_SCRIPT');
});

test('run_script reports thrown errors and truncates large results without throwing',async()=>{
  const run=async code=>S.execute(fakeChrome({execute:inPage({})}),T,1,pending(code),policy,helpers);
  const failed=await run('throw new Error("boom")');
  assert.equal(failed.status,'error');assert.equal(failed.code,'SCRIPT_ERROR');assert.match(failed.observed.error,/boom/);
  const big=await run('return "a".repeat(9000)');
  assert.equal(big.observed.result.length,4000);assert.equal(big.observed.truncated,true);
  const quoted=await run('return "\\"".repeat(5000)');
  assert.ok(quoted.observed.result.length>0);assert.ok(JSON.stringify(quoted.observed).length<=4500);assert.equal(quoted.observed.truncated,true);
  assert.equal((await run('return )')).status,'error');
  assert.equal((await run('let x=1;')).observed.result,'undefined');
});

test('run_script refuses before dispatch when scripts are unavailable or the page or document changed',async()=>{
  const never=async()=>assert.fail('must not execute');
  await assert.rejects(()=>S.execute(fakeChrome({permission:false,execute:never}),T,1,pending('1'),policy,helpers),e=>e.code==='PERMISSION_DENIED'&&/授权脚本执行/.test(e.message));
  await assert.rejects(()=>S.execute(fakeChrome({api:false,execute:never}),T,1,pending('1'),policy,helpers),e=>e.code==='PERMISSION_DENIED'&&/允许用户脚本/.test(e.message));
  const on=fakeChrome({execute:never});
  await assert.rejects(()=>S.execute(on,T,1,pending('1'),policy,{...helpers,tab:async()=>({url:'https://example.test/other'})}),e=>e.code==='STALE');
  await assert.rejects(()=>S.execute(on,T,1,pending('1'),policy,{...helpers,documentId:async()=>'d2'}),e=>e.code==='STALE');
  await assert.rejects(()=>S.execute(on,T,1,pending('1'),policy,{...helpers,documentId:async()=>{throw Error('no content script');}}),e=>e.code==='STALE');
  await assert.rejects(()=>S.execute(on,T,1,pending('1'),policy,{...helpers,checkOrigin:async()=>{throw Object.assign(Error('x'),{code:'PERMISSION_DENIED'});}}),e=>e.code==='PERMISSION_DENIED');
  await assert.rejects(()=>S.execute(on,T,1,pending('1'),policy,{...helpers,live:async()=>false}),e=>e.code==='CANCELLED');
  assert.equal(on.calls.filter(c=>c[0]==='execute').length,0);
});

test('run_script timeout is reported as unknown, never retried',async()=>{
  const realSetTimeout=global.setTimeout;global.setTimeout=(fn)=>realSetTimeout(fn,0);
  try{
    const chrome=fakeChrome({execute:()=>new Promise(()=>{})});
    const r=await S.execute(chrome,T,1,pending('while(true){}'),policy,helpers);
    assert.equal(r.status,'unknown');assert.equal(r.code,'SCRIPT_TIMEOUT');
    assert.equal(chrome.calls.filter(c=>c[0]==='execute').length,1);
  }finally{global.setTimeout=realSetTimeout;}
});

test('browser-tools routes run_script to userScripts after probing the page document',async()=>{
  const chrome=fakeChrome({execute:async()=>[{result:{__palValue:'"ok"'}}]}),sent=[];
  chrome.tabs.sendMessage=async(id,m)=>{sent.push(m.type);return m.type==='agent:document'?{ok:true,value:{documentId:'d1',url:'https://example.test/page'}}:{ok:false,error:'x',code:'UNSUPPORTED_ACTION'};};
  const tools=createBrowserTools(chrome);
  const r=await tools.execute(1,pending('return "ok"'),policy,async()=>true);
  assert.equal(r.code,'SCRIPT_RESULT');assert.equal(r.observed.result,'"ok"');assert.deepEqual(sent,['agent:document']);
  await assert.rejects(()=>tools.execute(1,pending('1'),policy,async()=>false),e=>e.code==='CANCELLED');
  assert.equal(chrome.calls.filter(c=>c[0]==='execute').length,1);
});
