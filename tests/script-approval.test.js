// run_script approval flow: real runtime + real browser-tools + script-tools over a fake chrome.
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const {createRuntime}=require('../extension/runtime.js');
const {createBrowserTools}=require('../extension/browser-tools.js');
const S=require('../extension/script-tools.js');
const {createTaskStore}=require('../extension/task-store.js');

const CODE='// read the title\n'+'const parts=[];\n'.repeat(500)+'return document.title;';
function fixture({api=true,plans=null,realStore=false,permission=null}={}){
  const page={url:'https://example.test/page',documentId:'d1'},executes=[],models=[],phases=[];let snapshots=0,seq=0;
  const data=new Map();
  const session={},area={async get(k){return structuredClone(k===null?session:{[k]:session[k]});},async set(v){Object.assign(session,structuredClone(v));},async remove(k){delete session[k];}};
  const store=realStore?createTaskStore({storage:{session:area}}):{async get(id){return structuredClone(data.get(id)||null);},async set(id,t){data.set(id,structuredClone(t));},async remove(id){data.delete(id);},async list(){return [...data.values()].map(t=>structuredClone(t));},async getMemory(){return [];},async setMemory(){},async removeMemory(){}};
  const chrome={
    tabs:{async get(id){return {id,url:page.url,status:'complete'};},async query(){return [{id:1,url:page.url}];},
      async sendMessage(id,m){
        if(m.type==='agent:observe')return {ok:true,value:{snapshotId:'s'+(++snapshots),documentId:page.documentId,url:page.url,readyState:'complete',page:{text:'Page',elements:[],regions:[]}}};
        if(m.type==='agent:document')return {ok:true,value:{documentId:page.documentId,url:page.url}};
        if(m.type==='agent:clear-pointer')return {ok:true};
        throw new Error('unexpected '+m.type);
      }},
    permissions:{async contains(q){return q?.permissions?.includes('userScripts')&&permission?permission.granted:true;}},
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
    scriptAccess:()=>S.status(chrome)};
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

test('unavailable scripts are hidden and pause with instructions',async()=>{
  const off=fixture({api:false}),t=await paused(off);
  assert.equal(off.models[0].capabilities.scripts,false);
  assert.equal(t.status,'paused');assert.equal(t.reason,'access');assert.match(t.events.at(-1).text,/允许用户脚本/);assert.equal(off.executes.length,0);
});

test('only the trusted side panel can send task:script-approval',async()=>{
  let listener,deps;const calls=[],revokes=[];
  const runtime={async recover(){},async resolve(id){return id;},async scriptApproval(id,p){calls.push([id,p]);return {ok:true};},async revokeScriptApproval(id,p){revokes.push([id,p]);return {ok:true};}};
  const chrome={runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,onMessage:{addListener(fn){listener=fn;}}},
    permissions:{onRemoved:{addListener(){}}},storage:{onChanged:{addListener(){}}},sidePanel:{async setPanelBehavior(){}},scripting:{async getRegisteredContentScripts(){return [];}},
    alarms:{async create(){},async clear(){},onAlarm:{addListener(){}}},tabs:{onUpdated:{addListener(){}},onRemoved:{addListener(){}}},action:{onClicked:{addListener(){}}}};
  vm.runInNewContext(fs.readFileSync('extension/background.js','utf8'),{chrome,URL,setTimeout,clearTimeout,importScripts(){},
    PageAgentSiteMemory:{createSiteMemory(){return {};}},PageAgentHistoryStore:{createHistoryStore(){return {async list(){return [];},async get(){return null;},async save(){},async remove(){},async interrupt(){}};},snapshot:v=>v},PageAgentBackend:{createService(){return {async init(){}};}},
    PageAgentTaskStore:{createTaskStore(){return {async migrate(){}};}},PageAgentBrowserTools:{createBrowserTools(){return {};}},
    PageAgentRuntime:{createRuntime(d){deps=d;return runtime;}}});
  await new Promise(r=>setImmediate(r));
  const send=(m,s)=>new Promise(r=>listener(m,s,r));
  const message={type:'task:script-approval',tabId:1,taskId:'t',requestId:'r',allow:true};
  for(const sender of [{id:'other',url:'chrome-extension://test/sidepanel.html',frameId:0},{id:'test',url:'chrome-extension://test/sidepanel.html',frameId:1},{id:'test',url:'chrome-extension://test/options.html',frameId:0},{id:'test',url:'https://example.test/',frameId:0,tab:{id:1}}])
    assert.equal((await send(message,sender)).ok,false);
  assert.equal(calls.length,0);
  assert.equal((await send(message,{id:'test',url:'chrome-extension://test/sidepanel.html',frameId:0})).ok,true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[[1,{taskId:'t',requestId:'r',allow:true,scope:'once'}]]);
  // Strict shape: scope is once|task, a task-wide grant must approve, ids are strings.
  const panel={id:'test',url:'chrome-extension://test/sidepanel.html',frameId:0};
  for(const bad of [{scope:'always'},{scope:'task',allow:false},{scope:''},{scope:null},{allow:'yes'},{requestId:1},{taskId:{}}])
    assert.equal((await send({...message,...bad},panel)).ok,false);
  assert.equal(calls.length,1);
  assert.equal((await send({...message,scope:'task'},panel)).ok,true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))),[1,{taskId:'t',requestId:'r',allow:true,scope:'task'}]);
  // Revoke: trusted side panel only, taskId required.
  const revoke={type:'task:script-revoke',tabId:1,taskId:'t'};
  assert.equal((await send(revoke,{id:'test',url:'https://example.test/',frameId:0,tab:{id:1}})).ok,false);
  assert.equal((await send({...revoke,taskId:7},panel)).ok,false);
  assert.equal((await send(revoke,panel)).ok,true);assert.deepEqual(JSON.parse(JSON.stringify(revokes)),[[1,{taskId:"t"}]]);
});

const RUN=(n)=>({reply:'Script '+n,action:'run_script',value:{code:'return '+n+';',world:'USER_SCRIPT'}});
const runs=f=>f.executes.map(e=>e.js[0].code.match(/return (\d+);/)?.[1]);

test('allow once: the next script pauses for approval again',async()=>{
  const f=fixture({plans:[RUN(1),RUN(2)]}),t=await paused(f);
  await f.runtime.scriptApproval(1,{...decision(t,true),scope:'once'});
  await f.runtime.tick(1);await f.runtime.tick(1);
  const second=await f.runtime.get(1);
  assert.deepEqual(runs(f),['1']);assert.equal(second.reason,'script_approval');assert.equal(second.scriptRequest.code,'return 2;');assert.ok(!second.scriptApproval);
});

test('allow for this task: later same-origin scripts run once each without a pause, full code kept in history',async()=>{
  const f=fixture({plans:[RUN(1),RUN(2),RUN(3)]}),t=await paused(f);
  await assert.rejects(()=>f.runtime.scriptApproval(1,{...decision(t,false),scope:'task'}),/无效/);
  await assert.rejects(()=>f.runtime.scriptApproval(1,{...decision(t,true),scope:'always'}),/无效/);
  const granted=await f.runtime.scriptApproval(1,{...decision(t,true),scope:'task'});
  assert.equal(granted.scriptApproval.scope,'task');assert.equal(granted.scriptApproval.origin,'https://example.test');assert.equal(granted.scriptApproval.tabId,1);
  for(let i=0;i<6;i++)await f.runtime.tick(1);
  assert.deepEqual(runs(f),['1','2','3']);assert.deepEqual(f.phases,['executing','executing','executing']);
  const after=await f.runtime.get(1);
  assert.equal(after.status,'completed');assert.equal(after.scriptRequest,null);
  assert.deepEqual(after.results.filter(r=>r.action==='run_script').map(r=>[r.request.value.code,r.outcome.code]),[['return 1;','SCRIPT_RESULT'],['return 2;','SCRIPT_RESULT'],['return 3;','SCRIPT_RESULT']]);
  assert.equal(f.models.length,4);
});

test('task approval never replays an uncertain run and still checks the document',async()=>{
  const f=fixture({plans:[RUN(1),RUN(2)]}),t=await paused(f);
  await f.runtime.scriptApproval(1,{...decision(t,true),scope:'task'});await f.runtime.tick(1);
  // Second script: the document changes between observation and dispatch -> STALE, not executed.
  const send=f.chrome.tabs.sendMessage;let observed=0;
  f.chrome.tabs.sendMessage=async(id,m)=>{const r=await send(id,m);if(m.type==='agent:observe'&&++observed===1)f.page.documentId='d9';return r;};
  await f.runtime.tick(1);
  assert.deepEqual(runs(f),['1']);const stale=await f.runtime.get(1);assert.equal(stale.results.at(-1).outcome.code,'STALE');assert.equal(stale.results.at(-1).outcome.dispatch,'not_sent');
  // A run interrupted after the executing checkpoint pauses as uncertain instead of re-running.
  const g=fixture({plans:[RUN(1),RUN(2)]}),u=await paused(g);
  await g.runtime.scriptApproval(1,{...decision(u,true),scope:'task'});await g.runtime.tick(1);
  const record=await g.store.get(1);record.phase='executing';record.pending={tabId:1,plan:RUN(2),url:g.page.url,documentId:'d1'};record.check=null;await g.store.set(1,record);
  await g.runtime.tick(1);
  assert.deepEqual(runs(g),['1']);const uncertain=await g.runtime.get(1);assert.equal(uncertain.reason,'uncertain');assert.ok(uncertain.scriptApproval);
});

test('revoke, ending the task and permission removal clear the task approval',async()=>{
  // Revoke: the next script pauses again; stale task ids are refused.
  let f=fixture({plans:[RUN(1),RUN(2)]}),t=await paused(f);
  await f.runtime.scriptApproval(1,{...decision(t,true),scope:'task'});await f.runtime.tick(1);
  await assert.rejects(()=>f.runtime.revokeScriptApproval(1,{taskId:'other'}),/任务已变化/);
  const revoked=await f.runtime.revokeScriptApproval(1,{taskId:t.taskId});assert.equal(revoked.scriptApproval,null);
  await f.runtime.tick(1);assert.deepEqual(runs(f),['1']);assert.equal((await f.runtime.get(1)).reason,'script_approval');
  // Stop, takeover and supplemental instructions keep it; ending the task clears it.
  f=fixture({plans:[RUN(1),RUN(2)]});t=await paused(f);
  await f.runtime.scriptApproval(1,{...decision(t,true),scope:'task'});await f.runtime.tick(1);
  await f.runtime.stop(1);assert.ok((await f.runtime.get(1)).scriptApproval);
  await f.runtime.takeover(1);assert.ok((await f.runtime.get(1)).scriptApproval);
  await f.runtime.submit(1,'Continue please');assert.ok((await f.runtime.get(1)).scriptApproval);
  await f.runtime.finish(1);assert.equal((await f.runtime.get(1)).scriptApproval,null);
  // userScripts permission removed: reviewPermissions drops every task approval.
  const permission={granted:true};f=fixture({plans:[RUN(1),RUN(2)],permission});t=await paused(f);
  await f.runtime.scriptApproval(1,{...decision(t,true),scope:'task'});await f.runtime.tick(1);
  await f.runtime.reviewPermissions();assert.ok((await f.runtime.get(1)).scriptApproval);
  permission.granted=false;await f.runtime.reviewPermissions();assert.equal((await f.runtime.get(1)).scriptApproval,null);
});

test('task approval is bound to the origin: another origin pauses again, returning does not restore it',async()=>{
  const f=fixture({plans:[RUN(1),RUN(2),RUN(3)],realStore:true}),t=await paused(f);
  await f.runtime.scriptApproval(1,{...decision(t,true),scope:'task'});await f.runtime.tick(1);
  assert.deepEqual(runs(f),['1']);
  f.page.url='https://other.test/page';f.page.documentId='d2';
  await f.runtime.tick(1);
  let moved=await f.runtime.get(1);assert.equal(moved.origin,'https://other.test');assert.ok(!moved.scriptApproval);
  await f.runtime.tick(1);moved=await f.runtime.get(1);
  assert.deepEqual(runs(f),['1']);assert.equal(moved.reason,'script_approval');assert.equal(moved.scriptRequest.code,'return 2;');
  // A grant recorded for another origin or tab is never used and is dropped at the next script.
  const g=fixture({plans:[RUN(1)]});await g.runtime.start(1,'Get the title');
  const record=await g.store.get(1);record.scriptApproval={scope:'task',origin:'https://other.test',tabId:1,grantedAt:1};await g.store.set(1,record);
  await g.runtime.tick(1);let after=await g.runtime.get(1);
  assert.equal(g.executes.length,0);assert.equal(after.reason,'script_approval');assert.equal(after.scriptApproval,null);
  const h=fixture({plans:[RUN(1)]});await h.runtime.start(1,'Get the title');
  const other=await h.store.get(1);other.scriptApproval={scope:'task',origin:'https://example.test',tabId:2,grantedAt:1};await h.store.set(1,other);
  await h.runtime.tick(1);after=await h.runtime.get(1);
  assert.equal(h.executes.length,0);assert.equal(after.reason,'script_approval');
});
