const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const flush=()=>new Promise(r=>setImmediate(r));
async function fixture(registered=[],storeExtra={},runtimeExtra={},historyExtra={}){
 let listener,removed,permissionRemoved,updated,sessionChanged;const calls=[];
 const runtime={async getGlobalMemory(){return {scope:'global',version:0,notes:[]};},async editGlobalMemory(p){calls.push(['global-change',p]);return {version:1};},async recover(){},async get(id){calls.push(['get',id]);return {taskId:'t'};},async submit(id,goal){calls.push(['submit',id,goal]);return {taskId:'new'};},async finish(id){calls.push(['finish',id]);return {status:'ended'};},async stop(id){calls.push(['stop',id]);},async remove(){calls.push(['remove']);},async memberClosed(id){calls.push(['member-closed',id]);},async changeOrigins(id,p){calls.push(['scope-change',id,p]);return {status:'paused'};},async reviewPermissions(){calls.push(['review-permissions']);},async navigationChanged(id){calls.push(['navigation-changed',id]);},async tick(){},...runtimeExtra};
 const chrome={runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,onMessage:{addListener(fn){listener=fn;}},async openOptionsPage(){calls.push(['options']);}},
 permissions:{onRemoved:{addListener(fn){permissionRemoved=fn;}}},storage:{local:{async get(){return {};}},onChanged:{addListener(fn){sessionChanged=fn;}}},sidePanel:{async setPanelBehavior(){}},
 scripting:{async getRegisteredContentScripts(){return registered;},async unregisterContentScripts({ids}){calls.push(['unregister',...ids]);},async executeScript(){calls.push(['inject']);}},
 alarms:{async create(){},async clear(){},onAlarm:{addListener(){}}},
 tabs:{onUpdated:{addListener(fn){updated=fn;}},onRemoved:{addListener(fn){removed=fn;}}},action:{onClicked:{addListener(){}}}};
 vm.runInNewContext(fs.readFileSync('extension/background.js','utf8'),{chrome,URL,setTimeout,clearTimeout,importScripts(){},
  PageAgentCore:{},PageAgentSiteMemory:{createSiteMemory(){return {};}},PageAgentBackend:{createService(){return {async init(){},async handle(){return 'service';}};}},
  PageAgentHistoryStore:{createHistoryStore(){return {async list(){calls.push(['history-list']);return [{taskId:'saved'}];},async get(id){calls.push(['history-get',id]);return id==='saved'?{taskId:'saved'}:null;},async save(view){calls.push(['history-save',view.taskId]);},async remove(id){calls.push(['history-remove',id]);},async interrupt(ids){calls.push(['history-interrupt',[...ids]]);},...historyExtra};},snapshot:view=>({...view,snapshot:true})},
  PageAgentTaskStore:{createTaskStore(){return {async migrate(){},async conversation(){return null;},...storeExtra};}},
  PageAgentBrowserTools:{createBrowserTools(){return {async inject(){calls.push(['tools.inject']);}};}},
  PageAgentRuntime:{createRuntime(){return runtime;}}});await flush();
 return {calls,removed,permissionRemoved,updated,sessionChanged:(...args)=>sessionChanged(...args),send:(m,s)=>new Promise(r=>listener(m,s,r))};
}
const panel={id:'test',url:'chrome-extension://test/sidepanel.html',frameId:0};
test('live panel receives cross-origin logs without changing runtime context',async()=>{
 const task={taskId:'t',origin:'https://new.test',results:[],events:[{time:2,text:'new site'}]};
 const old={action:'observe',time:1,result:'old site'};
 const f=await fixture([],{async conversation(){return {...task,results:[old]};}},{async get(){return task;}});
 const response=await f.send({type:'task:get',tabId:1},panel);
 assert.equal(response.ok,true);
 assert.equal(response.value.results.length,0);
 assert.equal(response.value.displayLog.results[0].result,'old site');
 assert.equal(task.displayLog,undefined);
 assert.equal(task.results.length,0);
});
test('only trusted sidepanel owns runtime commands; content cannot create/read/stop tasks',async()=>{
 const f=await fixture();
 for(const sender of [{...panel,id:'other'},{...panel,frameId:1},{id:'test',url:'https://example.test',frameId:0,tab:{id:1}}]){
  assert.equal((await f.send({type:'task:site-memory-change',tabId:1,action:'clear',expectedVersion:0},sender)).ok,false);
  assert.equal((await f.send({type:'task:site-memory',tabId:1},sender)).ok,false);
  assert.equal((await f.send({type:'task:get',tabId:1},sender)).ok,false);
  assert.equal((await f.send({type:'task:history',tabId:1},sender)).ok,false);
  assert.equal((await f.send({type:'task:history-get',tabId:1,taskId:'old'},sender)).ok,false);
  assert.equal((await f.send({type:'task:start',tabId:1,goal:'x'},sender)).ok,false);
  assert.equal((await f.send({type:'task:connect',tabId:1},sender)).ok,false);
 }
 assert.equal((await f.send({type:'task:get',tabId:1},panel)).value.taskId,'t');
 assert.equal((await f.send({type:'task:start',tabId:1,goal:'x'},panel)).ok,true);
 assert.ok(f.calls.some(x=>x[0]==='submit'&&x[1]===1));
 assert.equal((await f.send({type:'task:submit',tabId:1,goal:'补充'},panel)).ok,true);
 assert.equal((await f.send({type:'task:finish',tabId:1},panel)).value.status,'ended');
 assert.equal((await f.send({type:'task:connect',tabId:1},panel)).ok,true);
 assert.equal((await f.send({type:'task:get',tabId:'1'},panel)).ok,false);
 assert.equal((await f.send({type:'model',task:'agent',text:'x'},{id:'test',url:'https://example.test',frameId:0,tab:{id:1}})).ok,false);
});

test('local dependency load failure keeps actionable diagnostics reachable without starting runtime',async()=>{
 let listener;const chrome={runtime:{id:'test',onMessage:{addListener(fn){listener=fn;}}},
 action:{onClicked:{addListener(){}},async setBadgeText(){},async setTitle(){}},sidePanel:{async open(){}}};
 vm.runInNewContext(fs.readFileSync('extension/background.js','utf8'),{
  chrome,importScripts(){throw new Error("Failed to load 'chrome-extension://test/core.js'");}
 });
 let result;listener({type:'task:get'},{id:'test'},r=>result=r);
 assert.equal(result.ok,false);assert.match(result.error,/core\.js/);assert.match(result.error,/重新加载/);
 let called=false;listener({type:'task:get'},{id:'other'},()=>called=true);assert.equal(called,false);
});

test('options page cannot open retired article tools or control task execution',async()=>{
 const f=await fixture(),sender={...panel,url:'chrome-extension://test/options.html'};
 assert.equal((await f.send({type:'task:article',tabId:1},sender)).ok,false);
 for(const type of ['task:get','task:submit','task:approve','task:stop','task:clear','task:connect'])assert.equal((await f.send({type,tabId:1,goal:'x'},sender)).ok,false);
 assert.equal((await f.send({type:'task:article',tabId:1},{...sender,frameId:1})).ok,false);
});

test('startup unregisters only legacy article injections without clearing local records',async()=>{
 const f=await fixture([{id:'pa-old'},{id:'another-feature'}]);
 assert.deepEqual(f.calls.find(c=>c[0]==='unregister'),['unregister','pa-old']);
 assert.equal((await f.send({type:'task:get',tabId:1},panel)).ok,true);
});


test('global memory management works without a target tab only for trusted extension pages',async()=>{
 const f=await fixture();for(const sender of [panel,{...panel,url:'chrome-extension://test/options.html'}]){
 assert.equal((await f.send({type:'task:global-memory'},sender)).value.scope,'global');assert.equal((await f.send({type:'task:global-memory-change',action:'clear',expectedVersion:0},sender)).ok,true);
 }
 for(const sender of [{...panel,frameId:1},{...panel,url:panel.url+'?x'}, {id:'test',url:'https://example.test',frameId:0,tab:{id:1}}])for(const type of ['task:global-memory','task:global-memory-change'])assert.equal((await f.send({type},sender)).ok,false);
});


test('browser tab close routes to member lifecycle without clearing task history',async()=>{
 const f=await fixture();f.removed(7);await flush();assert.deepEqual(f.calls,[['member-closed',7]]);
});


test('only trusted sidepanel can change task origins and unrecognized mutation fields are dropped',async()=>{
 const f=await fixture(),message={type:'task:scope-change',tabId:1,taskId:'scope',expectedRevision:2,action:'add',origin:'https://two.test',allowedOrigins:['https://evil.test'],token:'fake'};
 for(const sender of [{...panel,url:'https://page.test',tab:{id:1}},{...panel,url:'chrome-extension://test/options.html'},{...panel,frameId:1}])assert.equal((await f.send(message,sender)).ok,false);
 assert.equal((await f.send(message,panel)).ok,true);const call=f.calls.find(c=>c[0]==='scope-change');assert.equal(call[1],1);assert.equal(JSON.stringify(call[2]),JSON.stringify({taskId:'scope',expectedRevision:2,origin:'https://two.test',action:'add'}));
});


test('browser host revocation triggers task permission review without granting task scope',async()=>{
 const f=await fixture();f.permissionRemoved({origins:['https://one.test/*']});await flush();assert.deepEqual(f.calls,[['review-permissions']]);
});


test('browser URL changes cancel through the runtime before scheduling a new observation',async()=>{
 const f=await fixture();f.updated(7,{url:'https://new.test/page',status:'complete'});await flush();assert.deepEqual(f.calls,[['navigation-changed',7]]);
});
test('commands from a member tab act on its task executing tab; submit is decided by the runtime and never injects',async()=>{
 const f=await fixture([],{},{async resolve(id){calls.push(['resolve',id]);return id===2?1:id;}});const calls=f.calls;
 for(const type of ['task:get','task:stop','task:finish']){calls.length=0;assert.equal((await f.send({type,tabId:2},panel)).ok,true);assert.deepEqual(calls.at(-1)[1],1,type);}
 calls.length=0;assert.equal((await f.send({type:'task:submit',tabId:2,goal:'x'},panel)).ok,true);assert.deepEqual(calls,[['submit',2,'x']]);
 calls.length=0;await f.send({type:'task:history',tabId:2},panel);assert.equal(calls.some(x=>x[0]==='resolve'),false);
 assert.equal(calls.some(x=>x[0]==='tools.inject'),false);
});

test('history uses the persistent store, rejects deleting live conversations and never resaves deleted ones',async()=>{
 const sessions={live:{taskId:'live',status:'running'},x:{taskId:'x',status:'ended'},done:{taskId:'done',status:'completed'}};
 const f=await fixture([],{async conversation(id){return sessions[id]||null;},async conversationIds(){return ['live'];},
  async getByTaskId(id){return id==='live'?{taskId:'live',tabId:3,status:'running'}:id==='done'?{taskId:'done',tabId:4,status:'completed'}:null;},
  async deleteConversation(id){f.calls.push(['delete',id]);delete sessions[id];}});
 await new Promise(r=>setTimeout(r,20));
 assert.ok(f.calls.some(c=>c[0]==='history-save'&&c[1]==='live'));assert.ok(f.calls.some(c=>c[0]==='history-interrupt'&&c[1][0]==='live'));
 assert.deepEqual((await f.send({type:'task:history',tabId:1},panel)).value,[{taskId:'saved'}]);
 assert.equal((await f.send({type:'task:history-get',tabId:1,taskId:'saved'},panel)).value.taskId,'saved');
 assert.equal((await f.send({type:'task:history-get',tabId:1,taskId:'live'},panel)).value.snapshot,true);
 assert.equal((await f.send({type:'task:history-get',tabId:1,taskId:'missing'},panel)).ok,false);
 assert.equal((await f.send({type:'task:history-get',tabId:1,taskId:'../x'},panel)).ok,false);
 assert.equal((await f.send({type:'task:history-delete',tabId:1,taskId:'saved'},{...panel,url:'chrome-extension://test/options.html'})).ok,false);
 assert.equal((await f.send({type:'task:history-delete',tabId:1,taskId:'live'},panel)).ok,false);
 assert.equal(f.calls.some(c=>c[0]==='history-remove'&&c[1]==='live'),false);
 assert.equal((await f.send({type:'task:history-delete',tabId:1,taskId:'done'},panel)).ok,true);
 assert.ok(f.calls.some(c=>c[0]==='remove'));assert.ok(f.calls.some(c=>c[0]==='delete'&&c[1]==='done'));assert.ok(f.calls.some(c=>c[0]==='history-remove'&&c[1]==='done'));
 sessions.done={taskId:'done',status:'stopped'};
 f.sessionChanged({'taskRoot:x':{newValue:{taskId:'x'}},'conversation:4:done':{newValue:{taskId:'done'}},taskRegistry:{newValue:{taskId:'x'}}},'session');
 f.sessionChanged({'taskRoot:live':{newValue:{taskId:'live'}}},'local');
 const before=f.calls.filter(c=>c[0]==='history-save').length;
 await new Promise(r=>setTimeout(r,700));
 const saves=f.calls.filter(c=>c[0]==='history-save').slice(before).map(c=>c[1]);
 assert.deepEqual(saves,['x']);
 await f.send({type:'task:clear',tabId:1},panel);assert.ok(f.calls.some(c=>c[0]==='history-remove'&&c[1]==='t'));
});

test('real-input approval messages reach the runtime only from the side panel with a strict shape; switching it off reviews grants',async()=>{
 const f=await fixture([],{},{async inputApproval(id,p){f.calls.push(['input',id,p]);return {};},async revokeInputApproval(id,p){f.calls.push(['input-revoke',id,p]);return {};},async reviewApprovals(){f.calls.push(['review-approvals']);}});
 const ok=await f.send({type:'task:input-approval',tabId:3,taskId:'t',requestId:'r',allow:true,scope:'task'},panel);
 assert.equal(ok.ok,true);assert.deepEqual(JSON.parse(JSON.stringify(f.calls.at(-1))),['input',3,{taskId:'t',requestId:'r',allow:true,scope:'task'}]);
 for(const bad of [{allow:'yes'},{allow:false,scope:'task'},{scope:'always',allow:true},{requestId:1,allow:true}]){
  const r=await f.send({type:'task:input-approval',tabId:3,taskId:'t',requestId:'r',...bad},panel);assert.equal(r.ok,false,JSON.stringify(bad));
 }
 assert.equal((await f.send({type:'task:input-approval',tabId:3,taskId:'t',requestId:'r',allow:true},{id:'test',url:'https://evil.test/',frameId:0,tab:{id:3}})).ok,false);
 assert.equal((await f.send({type:'task:input-revoke',tabId:3,taskId:'t'},panel)).ok,true);assert.deepEqual(JSON.parse(JSON.stringify(f.calls.at(-1))),['input-revoke',3,{taskId:'t'}]);
 f.calls.length=0;f.sessionChanged({debuggerEnabled:{oldValue:false,newValue:true}},'local');await flush();assert.deepEqual(f.calls,[]);
 f.sessionChanged({debuggerEnabled:{oldValue:true,newValue:false}},'local');await flush();assert.deepEqual(f.calls,[['review-approvals']]);
});
