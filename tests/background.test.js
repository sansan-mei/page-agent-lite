const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const flush=()=>new Promise(r=>setImmediate(r));
async function fixture(){
 let listener;const calls=[];
 const runtime={async recover(){},async get(id){calls.push(['get',id]);return {taskId:'t'};},async submit(id,goal){calls.push(['submit',id,goal]);return {taskId:'new'};},async finish(id){calls.push(['finish',id]);return {status:'ended'};},async stop(id){calls.push(['stop',id]);},async remove(){},async tick(){}};
 const chrome={runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,onMessage:{addListener(fn){listener=fn;}},async openOptionsPage(){calls.push(['options']);}},
 storage:{local:{async get(){return {};}}},sidePanel:{async setPanelBehavior(){}},
 scripting:{async getRegisteredContentScripts(){return [];},async executeScript(){calls.push(['inject']);}},
 alarms:{async create(){},async clear(){},onAlarm:{addListener(){}}},
 tabs:{onUpdated:{addListener(){}},onRemoved:{addListener(){}}},action:{onClicked:{addListener(){}}}};
 vm.runInNewContext(fs.readFileSync('extension/background.js','utf8'),{chrome,URL,setTimeout,clearTimeout,importScripts(){},
  PageAgentCore:{},PageAgentSiteMemory:{createSiteMemory(){return {};}},PageAgentBackend:{createService(){return {async init(){},async handle(){return 'service';}};}},
  PageAgentTaskStore:{createTaskStore(){return {async migrate(){}};}},
  PageAgentBrowserTools:{createBrowserTools(){return {async inject(){calls.push(['tools.inject']);}};}},
  PageAgentRuntime:{createRuntime(){return runtime;}}});await flush();
 return {calls,send:(m,s)=>new Promise(r=>listener(m,s,r))};
}
const panel={id:'test',url:'chrome-extension://test/sidepanel.html',frameId:0};
test('only trusted sidepanel owns runtime commands; content cannot create/read/stop tasks',async()=>{
 const f=await fixture();
 for(const sender of [{...panel,id:'other'},{...panel,frameId:1},{id:'test',url:'https://example.test',frameId:0,tab:{id:1}}]){
  assert.equal((await f.send({type:'task:site-memory-change',tabId:1,action:'clear',expectedVersion:0},sender)).ok,false);
  assert.equal((await f.send({type:'task:site-memory',tabId:1},sender)).ok,false);
  assert.equal((await f.send({type:'task:get',tabId:1},sender)).ok,false);
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
