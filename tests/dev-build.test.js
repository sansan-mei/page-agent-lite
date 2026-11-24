const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const vm=require('node:vm');
const root=path.join(__dirname,'..');
const {build}=require('../scripts/build-dev.cjs');
const T=require('../extension/tool-protocol.js');

// Load extension scripts into an isolated global, like importScripts in the dev service worker.
function load(files,dir){
  const context=vm.createContext({console,URL,setTimeout,clearTimeout,structuredClone});context.globalThis=context;
  for(const file of files)vm.runInContext(fs.readFileSync(path.join(dir,file),'utf8'),context,{filename:file});
  return context;
}

test('build:dev overlays dev files and leaves the store package without run_script',()=>{
  const out=fs.mkdtempSync(path.join(os.tmpdir(),'pal-dev-'));
  try{
    build(out);
    const store=JSON.parse(fs.readFileSync(path.join(root,'extension/manifest.json'),'utf8'));
    const dev=JSON.parse(fs.readFileSync(path.join(out,'manifest.json'),'utf8'));
    assert.ok(!store.permissions.includes('userScripts'));assert.equal(store.background.service_worker,'background.js');
    assert.ok(dev.permissions.includes('userScripts'));assert.equal(dev.background.service_worker,'background-dev.js');
    assert.equal(dev.name,store.name);
    for(const locale of ['zh_CN','en']){
      const read=dir=>JSON.parse(fs.readFileSync(path.join(dir,'_locales',locale,'messages.json'),'utf8')).extName.message;
      assert.equal(read(out),read(path.join(root,'extension'))+' (Dev)',locale);assert.doesNotMatch(read(path.join(root,'extension')),/Dev/);
    }
    assert.equal(dev.version,store.version);assert.equal(dev.version_name,undefined);
    assert.ok(!fs.existsSync(path.join(root,'extension/dev-tools.js')));
    assert.match(fs.readFileSync(path.join(out,'background-dev.js'),'utf8'),/importScripts\('dev-tools\.js','background\.js'\)/);
    const storeCtx=load(['tool-protocol.js','conditions.js','core.js','prompts.js'],path.join(root,'extension'));
    assert.equal(storeCtx.PageAgentCore.agentTool('run_script'),null);
    assert.doesNotMatch(storeCtx.PageAgentPrompts.agentSystem('简体中文'),/run_script/);
    const devCtx=load(['dev-tools.js','tool-protocol.js','conditions.js','core.js','prompts.js'],out);
    assert.equal(devCtx.PageAgentCore.agentTool('run_script').route,'browser');
    assert.ok(Object.isFrozen(devCtx.PageAgentCore.agentTool('run_script')));
    assert.match(devCtx.PageAgentPrompts.agentSystem('简体中文'),/DEVELOPER BUILD OVERRIDE[\s\S]*run_script/);
    // Content scripts never load dev-tools.js, so the page executor still refuses the action.
    assert.throws(()=>storeCtx.PageAgentCore.agentExecute({action:'run_script',value:'1'},{nodes:new Map()},{}),e=>e.code==='UNSUPPORTED_ACTION');
  }finally{fs.rmSync(out,{recursive:true,force:true});}
});

function devCore(){
  const out=fs.mkdtempSync(path.join(os.tmpdir(),'pal-dev-'));
  try{build(out);return load(['dev-tools.js','tool-protocol.js','conditions.js','core.js'],out);}finally{fs.rmSync(out,{recursive:true,force:true});}
}

test('dev agentPlan validates run_script values',()=>{
  const C=devCore().PageAgentCore,snap={nodes:new Map()};
  assert.equal(C.agentPlan(JSON.stringify({reply:'r',action:'run_script',value:'return document.title'}),snap).value,'return document.title');
  assert.equal(C.agentPlan(JSON.stringify({reply:'r',action:'run_script',value:{code:'return 1',world:'MAIN'}}),snap).value.world,'MAIN');
  for(const value of ['',' ','x'.repeat(20001),{code:'1',world:'ISOLATED'},{code:'1',extra:1},42,['1']])
    assert.throws(()=>C.agentPlan(JSON.stringify({reply:'r',action:'run_script',value}),snap),/run_script/);
  assert.throws(()=>C.agentPlan(JSON.stringify({reply:'r',action:'run_script',value:'1',id:'t1'}),snap),/id/);
});

function fakeChrome({available=true,execute}={}){
  const calls=[];
  const chrome={calls,
    tabs:{async get(){return {url:'https://example.test/page',status:'complete'};}},
    permissions:{async contains(){return true;}},
    userScripts:{getScripts(){if(!available)throw Error('Disabled');return Promise.resolve([]);},async configureWorld(c){calls.push(['configure',c]);},async execute(i){calls.push(['execute',i]);return execute(i);}}};
  return chrome;
}
const policy={origin:'https://example.test',allowedOrigins:['https://example.test']};
const pending=(value)=>({operationId:'op1',documentId:'d1',url:'https://example.test/page',plan:{action:'run_script',value}});

test('run_script executes through userScripts and returns the stringified value',async()=>{
  const dev=require('../dev/dev-tools.js');
  const chrome=fakeChrome({execute:async i=>{
    // Run the wrapped source the way the browser would and return its settled value.
    const value=await vm.runInNewContext(i.js[0].code,{document:{title:'Hello'}});
    return [{frameId:0,documentId:'d1',result:value}];
  }});
  const helpers=require('../extension/browser-tools.js');
  const r=await dev.execute(chrome,T,1,pending('return {title:document.title,n:[1,2]}'),policy,{checkOrigin:async()=>{},tab:async()=>({url:'https://example.test/page'})});
  assert.equal(r.status,'success');assert.equal(r.code,'SCRIPT_RESULT');assert.equal(r.dispatch,'sent');
  assert.equal(r.observed.result,'{"title":"Hello","n":[1,2]}');assert.equal(r.observed.world,'USER_SCRIPT');
  const exec=chrome.calls.find(c=>c[0]==='execute')[1];
  assert.deepEqual(exec.target,{tabId:1,frameIds:[0]});assert.equal(exec.world,'USER_SCRIPT');
  assert.ok(helpers.createBrowserTools);
});

test('run_script reports thrown errors and truncates large results without throwing',async()=>{
  const dev=require('../dev/dev-tools.js');
  const run=async code=>dev.execute(fakeChrome({execute:async i=>[{result:await vm.runInNewContext(i.js[0].code,{})}]}),T,1,pending(code),policy,{checkOrigin:async()=>{},tab:async()=>({url:'https://example.test/page'})});
  const failed=await run('throw new Error("boom")');
  assert.equal(failed.status,'error');assert.equal(failed.code,'SCRIPT_ERROR');assert.match(failed.observed.error,/boom/);
  const big=await run('return "a".repeat(9000)');
  assert.equal(big.observed.result.length,4000);assert.equal(big.observed.truncated,true);
  const quoted=await run('return "\\"".repeat(5000)');
  assert.ok(quoted.observed.result.length>0);assert.ok(JSON.stringify(quoted.observed).length<=4500);assert.equal(quoted.observed.truncated,true);
  const syntax=await run('return )');
  assert.equal(syntax.status,'error');
  const undef=await run('let x=1;');
  assert.equal(undef.observed.result,'undefined');
});

test('run_script refuses before dispatch when user scripts are disabled or the page changed',async()=>{
  const dev=require('../dev/dev-tools.js');
  const helpers={checkOrigin:async()=>{},tab:async()=>({url:'https://example.test/page'})};
  const off=fakeChrome({available:false,execute:async()=>assert.fail('must not execute')});
  await assert.rejects(()=>dev.execute(off,T,1,pending('1'),policy,helpers),e=>e.code==='PERMISSION_DENIED'&&/允许用户脚本/.test(e.message));
  const on=fakeChrome({execute:async()=>assert.fail('must not execute')});
  await assert.rejects(()=>dev.execute(on,T,1,pending('1'),policy,{...helpers,tab:async()=>({url:'https://example.test/other'})}),e=>e.code==='STALE');
  await assert.rejects(()=>dev.execute(on,T,1,pending('1'),policy,{...helpers,checkOrigin:async()=>{throw Object.assign(Error('x'),{code:'PERMISSION_DENIED'});}}),e=>e.code==='PERMISSION_DENIED');
});

test('run_script timeout is reported as unknown, never retried',async()=>{
  const dev=require('../dev/dev-tools.js');
  const realSetTimeout=global.setTimeout;global.setTimeout=(fn)=>realSetTimeout(fn,0);
  try{
    const chrome=fakeChrome({execute:()=>new Promise(()=>{})});
    const r=await dev.execute(chrome,T,1,pending('while(true){}'),policy,{checkOrigin:async()=>{},tab:async()=>({url:'https://example.test/page'})});
    assert.equal(r.status,'unknown');assert.equal(r.code,'SCRIPT_TIMEOUT');
    assert.equal(chrome.calls.filter(c=>c[0]==='execute').length,1);
  }finally{global.setTimeout=realSetTimeout;}
});

test('browser-tools routes run_script to dev tools only when they are loaded',async()=>{
  const out=fs.mkdtempSync(path.join(os.tmpdir(),'pal-dev-'));
  try{
    build(out);
    const ctx=load(['dev-tools.js','tool-protocol.js','browser-tools.js'],out);
    const chrome=fakeChrome({execute:async()=>[{result:{__palValue:'"ok"'}}]});
    const tools=ctx.PageAgentBrowserTools.createBrowserTools(chrome);
    const r=await tools.execute(1,pending('return "ok"'),policy,async()=>true);
    assert.equal(r.code,'SCRIPT_RESULT');assert.equal(r.observed.result,'"ok"');
    await assert.rejects(()=>tools.execute(1,pending('1'),policy,async()=>false),e=>e.code==='CANCELLED');
    const store=load(['tool-protocol.js','browser-tools.js'],path.join(root,'extension'));
    let sent=null;
    const plain={...chrome,tabs:{...chrome.tabs,async sendMessage(id,m){sent=m;return {ok:false,error:'该工具不能在网页执行',code:'UNSUPPORTED_ACTION'};}}};
    await assert.rejects(()=>store.PageAgentBrowserTools.createBrowserTools(plain).execute(1,pending('1'),policy),e=>e.code==='UNSUPPORTED_ACTION');
    assert.equal(sent.type,'agent:execute');
  }finally{fs.rmSync(out,{recursive:true,force:true});}
});

test('dev build content script answers its own service worker (background-dev.js)',async()=>{
  const out=fs.mkdtempSync(path.join(os.tmpdir(),'pal-dev-'));
  try{
    build(out);
    const manifest=JSON.parse(fs.readFileSync(path.join(out,'manifest.json'),'utf8'));
    const {parseHTML}=require('linkedom');const {document}=parseHTML('<html><body><p>Hello</p><input type="text"></body></html>');
    let listener;const chrome={runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,getManifest:()=>manifest,onMessage:{addListener(fn){listener=fn;}},async sendMessage(){}}};
    const ctx=load(['tool-protocol.js','conditions.js','core.js'],out);
    vm.runInNewContext(fs.readFileSync(path.join(out,'content.js'),'utf8'),{PageAgentCore:ctx.PageAgentCore,PageAgentConditions:ctx.PageAgentConditions,PageAgentProtocol:ctx.PageAgentProtocol,chrome,document,location:{href:'https://example.test/'},crypto,setTimeout});
    // An ignored message never calls respond; fail fast instead of hanging the suite.
    const r=await Promise.race([new Promise(resolve=>listener({type:'agent:observe'},{id:'test',url:'chrome-extension://test/background-dev.js'},resolve)),new Promise(resolve=>setTimeout(()=>resolve({ok:false,ignored:true}),2000))]);
    assert.equal(r.ok,true);assert.ok(r.value.snapshotId);
    assert.equal(listener({type:'agent:observe'},{id:'test',url:'https://example.test/',tab:{id:1}},()=>{}),undefined);
  }finally{fs.rmSync(out,{recursive:true,force:true});}
});
