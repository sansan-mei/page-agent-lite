const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const flush=()=>new Promise(r=>setImmediate(r));
async function fixture(registered=[],storeExtra={}){
 let listener,removed,permissionRemoved,updated;const calls=[];
 const runtime={async getGlobalMemory(){return {scope:'global',version:0,notes:[]};},async editGlobalMemory(p){calls.push(['global-change',p]);return {version:1};},async recover(){},async get(id){calls.push(['get',id]);return {taskId:'t'};},async submit(id,goal){calls.push(['submit',id,goal]);return {taskId:'new'};},async finish(id){calls.push(['finish',id]);return {status:'ended'};},async stop(id){calls.push(['stop',id]);},async remove(){calls.push(['remove']);},async memberClosed(id){calls.push(['member-closed',id]);},async changeOrigins(id,p){calls.push(['scope-change',id,p]);return {status:'paused'};},async reviewPermissions(){calls.push(['review-permissions']);},async navigationChanged(id){calls.push(['navigation-changed',id]);},async tick(){}};
 const chrome={runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,onMessage:{addListener(fn){listener=fn;}},async openOptionsPage(){calls.push(['options']);}},
 permissions:{onRemoved:{addListener(fn){permissionRemoved=fn;}}},storage:{local:{async get(){return {};}}},sidePanel:{async setPanelBehavior(){}},
 scripting:{async getRegisteredContentScripts(){return registered;},async unregisterContentScripts({ids}){calls.push(['unregister',...ids]);},async executeScript(){calls.push(['inject']);}},
 alarms:{async create(){},async clear(){},onAlarm:{addListener(){}}},
 tabs:{onUpdated:{addListener(fn){updated=fn;}},onRemoved:{addListener(fn){removed=fn;}}},action:{onClicked:{addListener(){}}}};
 vm.runInNewContext(fs.readFileSync('extension/background.js','utf8'),{chrome,URL,setTimeout,clearTimeout,importScripts(){},
  PageAgentCore:{},PageAgentSiteMemory:{createSiteMemory(){return {};}},PageAgentBackend:{createService(){return {async init(){},async handle(){return 'service';}};}},
  PageAgentTaskStore:{createTaskStore(){return {async migrate(){},...storeExtra};}},
  PageAgentBrowserTools:{createBrowserTools(){return {async inject(){calls.push(['tools.inject']);}};}},
  PageAgentRuntime:{createRuntime(){return runtime;}}});await flush();
 return {calls,removed,permissionRemoved,updated,send:(m,s)=>new Promise(r=>listener(m,s,r))};
}
const panel={id:'test',url:'chrome-extension://test/sidepanel.html',frameId:0};
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
test('a tab joined to another task cannot start or receive a task and is never injected',async()=>{
 const f=await fixture([],{async owner(id){return id===2?{taskId:'a',taskTabId:1,role:'member'}:null;}});
 for(const type of ['task:start','task:submit']){const reply=await f.send({type,tabId:2,goal:'x'},panel);assert.equal(reply.ok,false);assert.match(reply.error,/其他任务/);}
 assert.equal(f.calls.some(x=>x[0]==='tools.inject'||x[0]==='submit'),false);
 assert.equal((await f.send({type:'task:submit',tabId:1,goal:'x'},panel)).ok,true);assert.ok(f.calls.some(x=>x[0]==='tools.inject'));
});
