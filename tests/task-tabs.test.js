const {test}=require('node:test');const assert=require('node:assert/strict');
const {createTaskStore}=require('../extension/task-store.js');const {createRuntime}=require('../extension/runtime.js');const C=require('../extension/core.js');

function area(hooks={}){
 const data={};
 return {data,session:{async get(k){return structuredClone(k===null?data:{[k]:data[k]});},async set(v){if(hooks.set)hooks.set(v,data);Object.assign(data,structuredClone(v));},async remove(k){delete data[k];}}};
}
// Real store + runtime; tabs are a mutable fake browser. Every observation/action records its tabId.
function fixture(options={}){
 const {data,session}=area(options.hooks);const store=createTaskStore({storage:{session}});let seq=0,nextTab=50;
 const tabs={1:{id:1,url:'https://a.test/1',title:'A one',windowId:1},2:{id:2,url:'https://b.test/x',title:'B page',windowId:1},4:{id:4,url:'https://a.test/4',title:'A four',windowId:1},...options.tabs};
 const observed=[],executed=[],opened=[],closed=[],inputs=[],scheduled=[];
 const plans=[...(options.plans||[])];
 const tools={
  async tab(id){if(!tabs[id])throw Object.assign(new Error('目标标签页已关闭'),{code:'TAB_CLOSED'});return {...tabs[id],status:'complete'};},
  async listTabs(){return Object.values(tabs);},async existingTabIds(){return Object.keys(tabs).map(Number);},
  async hasOriginAccess(origin){return options.access?options.access(origin):true;},
  async observe(id){observed.push(id);return {url:tabs[id].url,documentId:'d'+id,snapshotId:'s'+id,page:{text:'Page '+id+(options.secret&&tabs[id].url.startsWith('https://a.test')?' '+options.secret:''),elements:[{id:'t0',tag:'button',label:'Go '+id}]}};},
  async execute(id,p){executed.push([id,p.plan.action]);return {version:2,status:'success',dispatch:'sent',scope:'ui',code:'CONDITIONS_MATCH',recovery:'none'};},
  async openTab(url,{openerTabId}){opened.push([url,openerTabId]);if(options.openFails)throw new Error('lost');const id=nextTab++;tabs[id]={id,url,title:'New',windowId:1};return {id};},
  async closeTab(id){closed.push(id);delete tabs[id];},
  async clearPointer(){}
 };
 const deps={store,tools,summarize:async()=>({text:'{}'}),schedule:(id,delay)=>scheduled.push(id),cancelSchedule:async()=>{},uuid:()=>'u'+(++seq),preferences:async()=>({maxSteps:50,contextTokens:32768}),
  model:async(text,signal)=>{inputs.push(text);const next=plans.shift();if(typeof next==='function')return next(signal);return {text:JSON.stringify(next||{reply:'完成',action:'done'})};},...options.deps};
 return {data,store,tools,tabs,observed,executed,opened,closed,inputs,scheduled,plans,deps,runtime:createRuntime(deps)};
}
const joinTab=async(f,host,tabId)=>{const t=await f.store.get(host);return f.runtime.changeMembers(host,{taskId:t.taskId,expectedMembersRevision:t.membersRevision,action:'join',memberTabId:tabId});};

test('tab tools are static registry entries with strict tabRef/URL validation',()=>{
 for(const name of ['tab_switch','tab_open','tab_close'])assert.ok(C.agentTool(name),name);
 assert.equal(C.agentTool('tab_open').route,'browser');assert.equal(C.agentTool('tab_switch').target,'none');
 const snap={nodes:new Map()};
 assert.equal(C.agentPlan('{"reply":"r","action":"tab_switch","id":"tab2"}',snap).id,'tab2');
 for(const raw of ['{"reply":"r","action":"tab_switch","id":"7"}','{"reply":"r","action":"tab_switch"}','{"reply":"r","action":"tab_close","id":"tab1","value":"x"}','{"reply":"r","action":"tab_open","value":"javascript:alert(1)"}','{"reply":"r","action":"tab_open","value":"https://u:p@c.test/"}','{"reply":"r","action":"tab_open","value":"https://c.test/","id":"tab1"}'])
  assert.throws(()=>C.agentPlan(raw,snap),raw);
 assert.equal(C.agentPlan('{"reply":"r","action":"tab_open","value":"https://c.test/p"}',snap).value,'https://c.test/p');
});

test('tab_switch moves execution to a joined member: token and scopeRevision rotate, budget is kept, later work targets the new tab',async()=>{
 const f=fixture({plans:[{reply:'Switch',action:'tab_switch',id:'tab1'},{reply:'Click',action:'click',id:'t0'}]});
 await f.runtime.start(1,'Work');await joinTab(f,1,4);const before=await f.store.get(1);
 await f.runtime.tick(1);
 assert.equal(await f.store.get(1),null);const task=await f.store.get(4);
 assert.equal(task.taskId,before.taskId);assert.equal(task.tabId,4);assert.equal(task.activeTabId,4);assert.equal(task.initialTabId,1);
 assert.notEqual(task.token,before.token);assert.ok(task.scopeRevision>before.scopeRevision);assert.equal(task.steps,1);assert.equal(task.status,'running');
 assert.equal(task.results.at(-1).outcome.code,'TAB_SWITCHED');assert.deepEqual(await f.store.owner(1),{taskId:task.taskId,taskTabId:4,role:'member'});
 assert.deepEqual(f.data.taskRegistry.tabOwners[4],undefined);assert.ok(f.scheduled.includes(4),'moved task is rescheduled on its new tab');
 assert.match(f.inputs[0],/"tabs":\[\{"tabRef":"tab0","kind":"initial","active":true/);
 await f.runtime.tick(4);
 assert.deepEqual(f.observed,[1,4]);assert.deepEqual(f.executed,[[4,'click']]);
 assert.match(f.inputs[1],/"tabRef":"tab1","kind":"user_joined","active":true/);
 assert.equal((await f.runtime.members(4,task.taskId)).members.find(m=>m.active).tabRef,'tab1');
});

test('non-member, active and closed tabRefs are rejected without changing the binding',async()=>{
 const f=fixture({plans:[{reply:'s',action:'tab_switch',id:'tab9'},{reply:'s',action:'tab_switch',id:'tab0'},{reply:'s',action:'tab_switch',id:'tab1'}]});
 await f.runtime.start(1,'Work');await joinTab(f,1,4);const before=await f.store.get(1);
 await f.runtime.tick(1);let task=await f.store.get(1);assert.equal(task.results.at(-1).outcome.code,'TAB_NOT_MEMBER');assert.equal(task.results.at(-1).outcome.dispatch,'not_sent');
 await f.runtime.tick(1);task=await f.store.get(1);assert.equal(task.results.at(-1).outcome.code,'TAB_ALREADY_ACTIVE');
 delete f.tabs[4];await f.runtime.tick(1);task=await f.store.get(1);assert.equal(task.results.at(-1).outcome.code,'TAB_CLOSED');
 assert.equal(task.scopeRevision,before.scopeRevision);assert.equal(task.status,'running');assert.equal(f.data.taskRegistry.bindings[1].taskId,before.taskId);
 // A tab that is not in the directory (tab 2 here) is never reachable, even if the model guesses its id.
 assert.equal(f.observed.includes(2),false);
});

test('a stale reply from before a switch is discarded and never executes on either tab',async()=>{
 let resolve;const f=fixture({plans:[()=>new Promise(r=>resolve=r)]});
 await f.runtime.start(1,'Work');await joinTab(f,1,4);
 const old=f.runtime.tick(1);while(!resolve)await new Promise(r=>setImmediate(r));
 // A restarted worker (fresh runtime on the same store) switches the task meanwhile.
 f.plans.push({reply:'Switch',action:'tab_switch',id:'tab1'});
 const second=createRuntime(f.deps);await second.tick(1);assert.equal((await f.store.get(4)).tabId,4);
 resolve({text:JSON.stringify({reply:'Late',action:'click',id:'t0'})});await old;
 assert.deepEqual(f.executed,[]);const task=await f.store.get(4);assert.equal(task.results.filter(r=>r.action==='click').length,0);assert.equal(task.status,'running');
});

test('closing the active member while others remain pauses on another member and records the unknown action without replay',async()=>{
 const f=fixture({plans:[{reply:'Switch',action:'tab_switch',id:'tab1'}]});
 await f.runtime.start(1,'Work');await joinTab(f,1,4);await f.runtime.tick(1);
 let task=await f.store.get(4);
 task.phase='executing';task.check={kind:'action',operationId:'op',dispatch:'unknown',expected:[{kind:'element_absent',id:'t0'}],deadline:Date.now()+5000,action:'click',request:{action:'click',id:'t0'},url:'https://a.test/4',documentId:'d4',key:'k'};await f.store.set(4,task);
 delete f.tabs[4];await f.runtime.memberClosed(4);
 task=await f.store.get(1);assert.equal(task.tabId,1);assert.equal(task.status,'paused');assert.equal(task.reason,'active_tab_closed');
 assert.equal(task.check,null);assert.equal(task.pending,null);assert.deepEqual(task.members.map(m=>m.tabRef),['tab0']);
 assert.equal(task.results.at(-1).outcome.code,'TAB_CLOSED');assert.equal(task.results.at(-1).outcome.status,'unknown');assert.equal(task.uncertainClicks.at(-1).key,'k');
 assert.deepEqual(f.data.taskRegistry.tabOwners,{});assert.equal(f.data.taskRegistry.bindings[4],undefined);
 await f.runtime.resume(1);await f.runtime.tick(1);assert.deepEqual(f.executed,[]);
 // Closing the last member keeps the existing ended/member_closed behaviour.
 delete f.tabs[1];await f.runtime.memberClosed(1);assert.equal(await f.store.get(1),null);
 const archived=f.data[Object.keys(f.data).find(k=>k.startsWith('conversation:1:'))];assert.equal(archived.reason,'member_closed');
});

test('switching to another origin reuses origin isolation: old site content stays out, missing permission pauses before reading',async()=>{
 const secret='SECRET-A-MARKER';
 const f=fixture({secret,plans:[{reply:'Note',action:'observe'},{reply:'Switch',action:'tab_switch',id:'tab1'},{reply:'Look',action:'done'}]});
 await f.runtime.start(1,'Work');await joinTab(f,1,2);await f.runtime.tick(1);await f.runtime.tick(1);
 let task=await f.store.get(2);assert.equal(task.origin,'https://a.test');
 await f.runtime.tick(2);task=await f.store.get(2);
 assert.equal(task.origin,'https://b.test');assert.deepEqual(task.allowedOrigins,['https://a.test','https://b.test']);
 await f.runtime.tick(2);assert.equal(f.inputs.length,3);assert.equal(f.inputs[2].includes(secret),false);assert.equal(f.inputs[2].includes('Page 1'),false);
 assert.ok(Object.keys(f.data).some(k=>k.startsWith('conversation-origin:2:')&&k.endsWith(encodeURIComponent('https://a.test'))));

 const denied=fixture({access:origin=>origin!=='https://b.test',plans:[{reply:'Switch',action:'tab_switch',id:'tab1'}]});
 await denied.runtime.start(1,'Work');await joinTab(denied,1,2);await denied.runtime.tick(1);await denied.runtime.tick(2);
 const paused=await denied.store.get(2);assert.equal(paused.reason,'permission_denied');assert.equal(paused.origin,'https://a.test');assert.equal(denied.observed.includes(2),false);
});

test('tab_open creates exactly one background tab, registers the browser-returned id as task_created and switches to it',async()=>{
 const f=fixture({plans:[{reply:'Open',action:'tab_open',value:'https://c.test/page'},{reply:'Back',action:'tab_switch',id:'tab0'},{reply:'Close',action:'tab_close',id:'tab1'}]});
 await f.runtime.start(1,'Work');await f.runtime.tick(1);
 assert.deepEqual(f.opened,[['https://c.test/page',1]]);
 let task=await f.store.get(50);assert.equal(task.tabId,50);assert.deepEqual(task.members.map(m=>[m.tabId,m.tabRef,m.kind]),[[1,'tab0','initial'],[50,'tab1','task_created']]);
 assert.equal(task.results.at(-1).outcome.code,'TAB_OPENED');assert.equal(task.phase,'observe');assert.equal(task.pending,null);
 await f.runtime.tick(50);task=await f.store.get(50);assert.equal(task.origin,'https://c.test');assert.equal(f.observed.includes(50),false,'origin switch happens before the new tab is read');
 await f.runtime.tick(50);assert.ok(f.observed.includes(50));task=await f.store.get(1);assert.equal(task.tabId,1);
 await f.runtime.tick(1);assert.equal((await f.store.get(1)).origin,'https://a.test','returning to tab0 switches origin back before any model call');
 await f.runtime.tick(1);assert.deepEqual(f.closed,[50]);task=await f.store.get(1);
 assert.equal(task.results.at(-1).outcome.code,'TAB_CLOSED_BY_TASK');assert.deepEqual(task.members.map(m=>m.tabRef),['tab0']);assert.deepEqual(f.data.taskRegistry.tabOwners,{});assert.equal(f.opened.length,1);
});

test('tab_open without host permission pauses before creating; a lost receipt or worker restart pauses and never reopens',async()=>{
 const denied=fixture({access:origin=>origin==='https://a.test',plans:[{reply:'Open',action:'tab_open',value:'https://c.test/'}]});
 await denied.runtime.start(1,'Work');await denied.runtime.tick(1);let task=await denied.store.get(1);
 assert.equal(task.reason,'browser_target');assert.equal(task.browserTarget,'https://c.test/');assert.deepEqual(denied.opened,[]);

 const lost=fixture({openFails:true,plans:[{reply:'Open',action:'tab_open',value:'https://c.test/'}]});
 await lost.runtime.start(1,'Work');await lost.runtime.tick(1);task=await lost.store.get(1);
 assert.equal(task.status,'paused');assert.equal(task.reason,'uncertain');assert.equal(task.results.at(-1).outcome.code,'TAB_OPEN_UNKNOWN');assert.equal(task.members.length,1);assert.equal(lost.opened.length,1);

 const restart=fixture({plans:[{reply:'Open',action:'tab_open',value:'https://c.test/'}]});
 await restart.runtime.start(1,'Work');task=await restart.store.get(1);
 task.phase='executing';task.pending={plan:{action:'tab_open',value:'https://c.test/'},operationId:'op',label:'tab_open'};await restart.store.set(1,task);
 await createRuntime(restart.deps).tick(1);task=await restart.store.get(1);
 assert.equal(task.reason,'uncertain');assert.deepEqual(restart.opened,[]);assert.equal(task.members.length,1);
});

test('tab_close only closes non-active task_created members; user tabs and the executing tab are refused',async()=>{
 const f=fixture({plans:[{reply:'Close',action:'tab_close',id:'tab1'},{reply:'Close',action:'tab_close',id:'tab0'}]});
 await f.runtime.start(1,'Work');await joinTab(f,1,4);
 await f.runtime.tick(1);let task=await f.store.get(1);assert.equal(task.results.at(-1).outcome.code,'TAB_NOT_CLOSABLE');
 await f.runtime.tick(1);task=await f.store.get(1);assert.equal(task.results.at(-1).outcome.code,'TAB_NOT_CLOSABLE');
 assert.deepEqual(f.closed,[]);assert.equal(task.members.length,2);
 // A task-created tab the user navigated to an unrelated site is kept.
 const g=fixture({plans:[{reply:'Open',action:'tab_open',value:'https://a.test/new'},{reply:'Close active',action:'tab_close',id:'tab1'},{reply:'Back',action:'tab_switch',id:'tab0'},{reply:'Close',action:'tab_close',id:'tab1'}]});
 await g.runtime.start(1,'Work');await g.runtime.tick(1);await g.runtime.tick(50);
 task=await g.store.get(50);assert.equal(task.results.at(-1).outcome.code,'TAB_ACTIVE');
 await g.runtime.tick(50);assert.equal((await g.store.get(1)).tabId,1);
 g.tabs[50].url='https://elsewhere.test/';await g.runtime.tick(1);task=await g.store.get(1);
 assert.equal(task.results.at(-1).outcome.code,'TAB_NOT_CLOSABLE');assert.deepEqual(g.closed,[]);assert.equal(task.members.length,2);
});

test('member-tab side panel: supplements reach the running task; after it ends the tab is released for a new task',async()=>{
 const f=fixture({plans:[{reply:'Switch',action:'tab_switch',id:'tab1'}]});
 await f.runtime.start(1,'Work');await joinTab(f,1,4);await f.runtime.tick(1);
 assert.equal(await f.runtime.resolve(1),4);assert.equal(await f.runtime.resolve(2),2);
 const supplemented=await f.runtime.submit(1,'More detail');assert.equal(supplemented.tabId,4);assert.equal(supplemented.instructions.at(-1).text,'More detail');
 await f.runtime.finish(4);
 const fresh=await f.runtime.submit(1,'New job');assert.equal(fresh.tabId,1);assert.notEqual(fresh.taskId,supplemented.taskId);
 assert.equal((await f.store.get(4)).members.some(m=>m.tabId===1),false);assert.equal((await f.store.get(1)).goal,'New job');
});

test('an interrupted tab switch reconciles to exactly one binding and pauses',async()=>{
 for(const stage of ['root','commit']){
  let fail=false;
  const f=fixture({hooks:{set(v){if(!fail)return;if(stage==='root'&&Object.keys(v).some(k=>k.startsWith('taskRoot:'))||stage==='commit'&&v.taskRegistry&&!v.taskRegistry.pending)throw Error('interrupted');}}});
  await f.runtime.start(1,'Work');await joinTab(f,1,4);const before=await f.store.get(1);fail=true;
  await assert.rejects(()=>f.store.switchTab(1,{taskId:before.taskId,expectedRevision:before.scopeRevision,expectedToken:before.token,toTabId:4,token:'next',updatedAt:5}),/interrupted/);fail=false;
  await assert.rejects(()=>f.store.get(1),e=>e.code==='TASK_SCOPE_INCONSISTENT');
  await f.store.migrate();
  const bound=Object.entries(f.data.taskRegistry.bindings).filter(([,b])=>b.taskId===before.taskId).map(([id])=>Number(id));
  assert.deepEqual(bound,[stage==='root'?1:4],stage);const task=await f.store.get(bound[0]);
  assert.equal(task.status,'paused');assert.equal(task.reason,'scope_reconciled');assert.equal(f.data.taskRegistry.pending,undefined);
  const other=bound[0]===1?4:1;assert.equal(f.data.taskRegistry.tabOwners[other].taskId,before.taskId,stage);assert.equal(f.data.taskRegistry.tabOwners[bound[0]],undefined,stage);
 }
});
