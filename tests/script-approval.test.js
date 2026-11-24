// run_script approval flow: real runtime + real browser-tools + script-tools over a fake chrome.
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const {createRuntime}=require('../extension/runtime.js');
const {createBrowserTools}=require('../extension/browser-tools.js');
const S=require('../extension/script-tools.js');

const CODE='// read the title\n'+'const parts=[];\n'.repeat(500)+'return document.title;';
function fixture({autoApproveScripts=false,api=true,plans=null}={}){
  const page={url:'https://example.test/page',documentId:'d1'},executes=[],models=[],phases=[];let snapshots=0,seq=0;
  const data=new Map();
  const store={async get(id){return structuredClone(data.get(id)||null);},async set(id,t){data.set(id,structuredClone(t));},async remove(id){data.delete(id);},async list(){return [...data.values()].map(t=>structuredClone(t));},async getMemory(){return [];},async setMemory(){},async removeMemory(){}};
  const chrome={
    tabs:{async get(id){return {id,url:page.url,status:'complete'};},async query(){return [{id:1,url:page.url}];},
      async sendMessage(id,m){
        if(m.type==='agent:observe')return {ok:true,value:{snapshotId:'s'+(++snapshots),documentId:page.documentId,url:page.url,readyState:'complete',page:{text:'Page',elements:[],regions:[]}}};
        if(m.type==='agent:document')return {ok:true,value:{documentId:page.documentId,url:page.url}};
        if(m.type==='agent:clear-pointer')return {ok:true};
        throw new Error('unexpected '+m.type);
      }},
    permissions:{async contains(){return true;}},
    scripting:{async executeScript(){}}
  };
  Object.defineProperty(chrome,'userScripts',{get(){return api?{getScripts:async()=>[],configureWorld:async()=>{},async execute(i){
    // The executing checkpoint must already be stored when the side effect is emitted.
    phases.push((await store.get(1)).phase);executes.push(i);return [{result:{__palValue:'"Title"'}}];
  }}:undefined;}});
  const queue=plans||[{reply:'Read the title with a script',action:'run_script',value:{code:CODE,world:'MAIN'}}];
  const deps={store,tools:createBrowserTools(chrome),schedule(){},cancelSchedule:async()=>{},uuid:()=>'u'+(++seq),
    preferences:async()=>({maxSteps:50,contextTokens:32768}),
    model:async(text,signal,capabilities)=>{models.push({input:JSON.parse(text),capabilities});return {text:JSON.stringify(queue.shift()||{reply:'Done',action:'done'})};},
    scriptAccess:()=>S.status(chrome),autoApproveScripts};
  return {page,executes,models,phases,store,chrome,runtime:createRuntime(deps)};
}
async function paused(f){await f.runtime.start(1,'Get the title');await f.runtime.tick(1);return f.runtime.get(1);}
const decision=(t,allow)=>({taskId:t.taskId,requestId:t.scriptRequest.id,allow});
const last=t=>t.results.at(-1);

test('store build: model run_script pauses with the full code and executes nothing',async()=>{
  const f=fixture(),t=await paused(f);
  assert.equal(f.models[0].capabilities.scripts,true);
  assert.equal(t.status,'paused');assert.equal(t.reason,'script_approval');assert.equal(t.phase,'observe');assert.equal(t.pending,null);
  assert.equal(t.scriptRequest.code,CODE);assert.equal(t.scriptRequest.world,'MAIN');assert.equal(t.scriptRequest.url,'https://example.test/page');
  assert.equal(t.scriptRequest.documentId,'d1');assert.equal(t.scriptRequest.snapshotId,'s1');assert.equal(t.scriptRequest.origin,'https://example.test');
  assert.equal(f.executes.length,0);
  await f.runtime.tick(1);assert.equal(f.executes.length,0);assert.equal(f.models.length,1);
  await assert.rejects(()=>f.runtime.resume(1),/批准或拒绝/);
});

test('approve runs exactly the approved code once, after the executing checkpoint',async()=>{
  const f=fixture(),t=await paused(f);
  await assert.rejects(()=>f.runtime.scriptApproval(1,{...decision(t,true),requestId:'other'}),/过期/);
  await assert.rejects(()=>f.runtime.scriptApproval(1,{...decision(t,true),taskId:'other'}),/过期/);
  await assert.rejects(()=>f.runtime.scriptApproval(1,{...decision(t,'yes')}),/过期/);
  const approved=await f.runtime.scriptApproval(1,decision(t,true));
  assert.notEqual(approved.token,t.token);assert.equal(approved.status,'running');assert.equal(approved.phase,'approved');assert.equal(approved.scriptRequest,null);
  await assert.rejects(()=>f.runtime.scriptApproval(1,decision(t,true)),/过期/);
  await f.runtime.tick(1);
  assert.equal(f.executes.length,1);assert.deepEqual(f.phases,['executing']);
  assert.ok(f.executes[0].js[0].code.includes(CODE));assert.equal(f.executes[0].world,'MAIN');assert.deepEqual(f.executes[0].target,{tabId:1,frameIds:[0]});
  const after=await f.runtime.get(1);assert.equal(last(after).outcome.code,'SCRIPT_RESULT');assert.equal(last(after).outcome.observed.result,'"Title"');
  await f.runtime.tick(1);await f.runtime.tick(1);
  assert.equal(f.executes.length,1);assert.equal((await f.runtime.get(1)).status,'completed');
  assert.equal(f.models[1].input.results.at(-1).outcome.code,'SCRIPT_RESULT');
});

test('reject records SCRIPT_REJECTED (not_sent) and the task keeps running',async()=>{
  const f=fixture(),t=await paused(f);
  const rejected=await f.runtime.scriptApproval(1,decision(t,false));
  assert.equal(rejected.status,'running');assert.equal(rejected.reason,null);
  assert.equal(last(rejected).outcome.code,'SCRIPT_REJECTED');assert.equal(last(rejected).outcome.dispatch,'not_sent');
  await f.runtime.tick(1);
  assert.equal(f.executes.length,0);assert.equal(f.models.length,2);
  assert.equal(f.models[1].input.results.at(-1).outcome.code,'SCRIPT_REJECTED');
});

test('approval on a changed URL or document never executes and reports STALE',async()=>{
  let f=fixture(),t=await paused(f);
  f.page.url='https://example.test/other';
  const stale=await f.runtime.scriptApproval(1,decision(t,true));
  assert.equal(last(stale).outcome.code,'STALE');assert.equal(last(stale).outcome.dispatch,'not_sent');assert.equal(stale.phase,'observe');
  await f.runtime.tick(1);assert.equal(f.executes.length,0);
  // Same URL, new document (reload): the content-script probe answers with another id.
  f=fixture();t=await paused(f);
  await f.runtime.scriptApproval(1,decision(t,true));f.page.documentId='d2';
  await f.runtime.tick(1);
  assert.equal(f.executes.length,0);const after=await f.runtime.get(1);
  assert.equal(last(after).outcome.code,'STALE');assert.equal(last(after).outcome.dispatch,'not_sent');assert.equal(after.status,'running');
});

test('stop, takeover, supplemental instructions and navigation discard a pending approval',async()=>{
  for(const discard of [
    f=>f.runtime.stop(1),
    f=>f.runtime.takeover(1),
    f=>f.runtime.submit(1,'Use the normal tools instead'),
    f=>{f.page.url='https://example.test/next';return f.runtime.navigationChanged(1,f.page.url);}
  ]){
    const f=fixture(),t=await paused(f);
    await discard(f);
    const after=await f.runtime.get(1);
    assert.equal(after.scriptRequest,null);assert.ok(after.results.some(r=>r.outcome?.code==='SCRIPT_DISCARDED'&&r.outcome.dispatch==='not_sent'));
    await assert.rejects(()=>f.runtime.scriptApproval(1,decision(t,true)),/过期/);
    await f.runtime.tick(1);assert.equal(f.executes.length,0);
  }
});

test('developer flag executes without a pause; unavailable scripts are hidden and pause with instructions',async()=>{
  const dev=fixture({autoApproveScripts:true});await dev.runtime.start(1,'Get the title');await dev.runtime.tick(1);
  assert.equal(dev.executes.length,1);assert.equal((await dev.runtime.get(1)).scriptRequest,undefined);
  const off=fixture({api:false}),t=await paused(off);
  assert.equal(off.models[0].capabilities.scripts,false);
  assert.equal(t.status,'paused');assert.equal(t.reason,'access');assert.match(t.events.at(-1).text,/允许用户脚本/);assert.equal(off.executes.length,0);
});

test('only the trusted side panel can send task:script-approval',async()=>{
  let listener,deps;const calls=[];
  const runtime={async recover(){},async resolve(id){return id;},async scriptApproval(id,p){calls.push([id,p]);return {ok:true};}};
  const chrome={runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,onMessage:{addListener(fn){listener=fn;}}},
    permissions:{onRemoved:{addListener(){}}},sidePanel:{async setPanelBehavior(){}},scripting:{async getRegisteredContentScripts(){return [];}},
    alarms:{async create(){},async clear(){},onAlarm:{addListener(){}}},tabs:{onUpdated:{addListener(){}},onRemoved:{addListener(){}}},action:{onClicked:{addListener(){}}}};
  vm.runInNewContext(fs.readFileSync('extension/background.js','utf8'),{chrome,URL,setTimeout,clearTimeout,importScripts(){},
    PageAgentSiteMemory:{createSiteMemory(){return {};}},PageAgentBackend:{createService(){return {async init(){}};}},
    PageAgentTaskStore:{createTaskStore(){return {async migrate(){}};}},PageAgentBrowserTools:{createBrowserTools(){return {};}},
    PageAgentRuntime:{createRuntime(d){deps=d;return runtime;}}});
  await new Promise(r=>setImmediate(r));
  assert.equal(deps.autoApproveScripts,false);
  const send=(m,s)=>new Promise(r=>listener(m,s,r));
  const message={type:'task:script-approval',tabId:1,taskId:'t',requestId:'r',allow:true};
  for(const sender of [{id:'other',url:'chrome-extension://test/sidepanel.html',frameId:0},{id:'test',url:'chrome-extension://test/sidepanel.html',frameId:1},{id:'test',url:'chrome-extension://test/options.html',frameId:0},{id:'test',url:'https://example.test/',frameId:0,tab:{id:1}}])
    assert.equal((await send(message,sender)).ok,false);
  assert.equal(calls.length,0);
  assert.equal((await send(message,{id:'test',url:'chrome-extension://test/sidepanel.html',frameId:0})).ok,true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[[1,{taskId:'t',requestId:'r',allow:true}]]);
});
