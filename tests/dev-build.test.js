const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const vm=require('node:vm');
const root=path.join(__dirname,'..');
const {build}=require('../scripts/build-dev.cjs');

function withBuild(fn){
  const out=fs.mkdtempSync(path.join(os.tmpdir(),'pal-dev-'));
  try{build(out);return fn(out);}finally{fs.rmSync(out,{recursive:true,force:true});}
}
// Evaluate the service worker entry with a stub importScripts to see which globals it sets.
function workerGlobals(dir,entry){
  const loaded=[],context=vm.createContext({});context.globalThis=context;
  context.importScripts=(...files)=>{for(const file of files){loaded.push(file);if(file==='dev-flags.js')vm.runInContext(fs.readFileSync(path.join(dir,file),'utf8'),context);}};
  vm.runInContext(fs.readFileSync(path.join(dir,entry),'utf8'),context);
  return {loaded,flags:context.PageAgentDevFlags};
}

test('store manifest asks for userScripts only as an optional permission; dev build requires it',()=>withBuild(out=>{
  const store=JSON.parse(fs.readFileSync(path.join(root,'extension/manifest.json'),'utf8'));
  const dev=JSON.parse(fs.readFileSync(path.join(out,'manifest.json'),'utf8'));
  assert.ok(!store.permissions.includes('userScripts'));assert.deepEqual(store.optional_permissions,['userScripts']);
  assert.equal(store.background.service_worker,'background.js');
  assert.ok(dev.permissions.includes('userScripts'));assert.equal(dev.optional_permissions,undefined);
  assert.equal(dev.background.service_worker,'background-dev.js');
  assert.equal(dev.name,store.name);assert.equal(dev.version,store.version);assert.equal(dev.version_name,undefined);
  for(const locale of ['zh_CN','en']){
    const read=dir=>JSON.parse(fs.readFileSync(path.join(dir,'_locales',locale,'messages.json'),'utf8')).extName.message;
    assert.equal(read(out),read(path.join(root,'extension'))+' (Dev)',locale);assert.doesNotMatch(read(path.join(root,'extension')),/Dev/);
  }
}));

test('only the dev build carries the auto-approve flag; the store package never contains dev files',()=>withBuild(out=>{
  const storeFiles=fs.readdirSync(path.join(root,'extension'),{recursive:true}).map(String);
  for(const file of ['dev-flags.js','background-dev.js','dev-tools.js'])assert.ok(!storeFiles.some(f=>path.basename(f)===file),file);
  assert.ok(!storeFiles.some(f=>/\.js$/.test(f)&&/PageAgentDevFlags\s*=/.test(fs.readFileSync(path.join(root,'extension',f),'utf8'))),'no extension/ file defines the dev flag');
  assert.ok(fs.existsSync(path.join(out,'dev-flags.js')));
  const dev=workerGlobals(out,'background-dev.js');
  assert.deepEqual(dev.loaded,['dev-flags.js','background.js']);assert.equal(dev.flags.autoApproveScripts,true);assert.ok(Object.isFrozen(dev.flags));
  // The store worker loads script-tools.js (run_script exists) but no flag, so every run needs approval.
  const background=fs.readFileSync(path.join(root,'extension/background.js'),'utf8');
  assert.match(background,/importScripts\('tool-protocol\.js','conditions\.js','script-tools\.js','core\.js'/);
  assert.match(background,/autoApproveScripts:globalThis\.PageAgentDevFlags\?\.autoApproveScripts===true/);
  assert.doesNotMatch(background,/importScripts\([^)]*dev-flags/);
}));

test('store and dev builds register the same run_script tool; content scripts never load it',()=>withBuild(out=>{
  const load=(files,dir)=>{const context=vm.createContext({console,URL,setTimeout,clearTimeout,structuredClone});context.globalThis=context;for(const file of files)vm.runInContext(fs.readFileSync(path.join(dir,file),'utf8'),context,{filename:file});return context;};
  const worker=['tool-protocol.js','conditions.js','script-tools.js','core.js','prompts.js'];
  for(const dir of [path.join(root,'extension'),out]){
    const ctx=load(worker,dir);
    assert.equal(ctx.PageAgentCore.agentTool('run_script').route,'browser');assert.ok(Object.isFrozen(ctx.PageAgentCore.agentTool('run_script')));
    assert.doesNotMatch(ctx.PageAgentPrompts.agentSystem('简体中文'),/run_script/);
    assert.match(ctx.PageAgentPrompts.agentSystem('简体中文','json',{scripts:true}),/OPTIONAL TOOL run_script/);
  }
  // browser-tools injects these files into pages: script-tools.js is not among them.
  const injected=fs.readFileSync(path.join(root,'extension/browser-tools.js'),'utf8').match(/files:\[([^\]]+)\]/)[1];
  assert.doesNotMatch(injected,/script-tools/);
  const page=load(['tool-protocol.js','conditions.js','core.js'],path.join(root,'extension'));
  assert.equal(page.PageAgentCore.agentTool('run_script'),null);
  assert.throws(()=>page.PageAgentCore.agentExecute({action:'run_script',value:'1'},{nodes:new Map()},{}),e=>e.code==='UNSUPPORTED_ACTION');
}));

test('dev build content script answers its own service worker (background-dev.js)',async()=>{
  const out=fs.mkdtempSync(path.join(os.tmpdir(),'pal-dev-'));
  try{
    build(out);
    const manifest=JSON.parse(fs.readFileSync(path.join(out,'manifest.json'),'utf8'));
    const {parseHTML}=require('linkedom');const {document}=parseHTML('<html><body><p>Hello</p><input type="text"></body></html>');
    let listener;const chrome={runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,getManifest:()=>manifest,onMessage:{addListener(fn){listener=fn;}},async sendMessage(){}}};
    const context=vm.createContext({console,URL,setTimeout,clearTimeout,structuredClone});context.globalThis=context;
    for(const file of ['tool-protocol.js','conditions.js','core.js'])vm.runInContext(fs.readFileSync(path.join(out,file),'utf8'),context,{filename:file});
    vm.runInNewContext(fs.readFileSync(path.join(out,'content.js'),'utf8'),{PageAgentCore:context.PageAgentCore,PageAgentConditions:context.PageAgentConditions,PageAgentProtocol:context.PageAgentProtocol,chrome,document,location:{href:'https://example.test/'},crypto,setTimeout});
    // An ignored message never calls respond; fail fast instead of hanging the suite.
    const ask=(message,sender)=>Promise.race([new Promise(resolve=>listener(message,sender,resolve)),new Promise(resolve=>setTimeout(()=>resolve({ok:false,ignored:true}),2000))]);
    const worker={id:'test',url:'chrome-extension://test/background-dev.js'};
    const r=await ask({type:'agent:observe'},worker);
    assert.equal(r.ok,true);assert.ok(r.value.snapshotId);
    const probe=await ask({type:'agent:document'},worker);
    assert.equal(probe.value.documentId,r.value.documentId);assert.equal(probe.value.url,'https://example.test/');
    assert.equal(listener({type:'agent:observe'},{id:'test',url:'https://example.test/',tab:{id:1}},()=>{}),undefined);
  }finally{fs.rmSync(out,{recursive:true,force:true});}
});
