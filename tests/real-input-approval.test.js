// chrome.debugger approval: page screenshots, click_point and trusted click/hover pause for the user's side-panel
// decision (once / this task / deny) before anything is attached. Runtime over fake tools that record every use.
const {test}=require('node:test');const assert=require('node:assert/strict');
const {createRuntime}=require('../extension/runtime.js');
const {createTaskStore}=require('../extension/task-store.js');

function fixture(replies,{realStore=false}={}){
  const page={url:'https://a.test/',documentId:'d1'},state={on:true},shots=[],executed=[],models=[],data=new Map(),saved=new Set();let seq=0;
  const session={},area={async get(k){return structuredClone(k===null?session:{[k]:session[k]});},async set(v){Object.assign(session,structuredClone(v));},async remove(k){delete session[k];}};
  const store=realStore?createTaskStore({storage:{session:area}}):{async get(id){return structuredClone(data.get(id)||null);},async set(id,t){data.set(id,structuredClone(t));},async remove(id){data.delete(id);},async list(){return [...data.values()].map(t=>structuredClone(t));}};
  const images={mode:async()=>'supported',async recognize(){return 'TEXT';},async saveShot(){const id='shot_'+String(++seq).padStart(8,'0');saved.add(id);return id;},
    async dropShots(taskId,keep){for(const id of [...saved])if(!keep.includes(id))saved.delete(id);},async present(ids){return ids.filter(id=>saved.has(id));},async remove(){},async prune(){}};
  const tools={async tab(id){return {id,url:page.url,status:'complete'};},async hasOriginAccess(){return true;},
    async observe(){return {url:page.url,documentId:page.documentId,snapshotId:'s'+(++seq),readyState:'complete',page:{text:'page',elements:[{id:'t0',key:'k0',label:'Board',tag:'button'}],regions:[]}};},
    async screenshot(tabId,shot,policy){shots.push({shot,policy});return {data:'SlBFRw==',masked:0,width:800,height:600,view:{area:{left:0,top:0,width:800,height:600},viewport:{width:800,height:600},scroll:{x:0,y:0}}};},
    async execute(tabId,pending,policy){executed.push({pending:structuredClone(pending),policy});return {version:2,operationId:pending.operationId,documentId:pending.documentId,status:'unknown',dispatch:'sent',scope:'dispatch',code:'PAGE_CHANGED',evidence:[],recovery:'observe',message:'sent'};},
    async realInputEnabled(){return state.on;},async releaseInput(){return true;},async clearPointer(){}};
  const make=()=>createRuntime({store,tools,images,schedule(){},cancelSchedule:async()=>{},uuid:()=>'u'+(++seq),preferences:async()=>({maxSteps:50,contextTokens:32768}),
    model:async(text,signal,capabilities)=>{models.push(capabilities);return {text:JSON.stringify(replies.shift()||{reply:'ok',action:'done'})};}});
  return {page,state,shots,executed,models,store,make,runtime:make()};
}
const look=(id='viewport')=>({reply:'look',action:'view_image',id}),click=(action='click')=>({reply:'press',action,id:'t0',trusted:true}),tap={reply:'tap',action:'click_point',value:{x:100,y:50}};
const last=t=>t.results.at(-1);
const decide=(f,t,allow,scope='once')=>f.runtime.inputApproval(1,{taskId:t.taskId,requestId:t.inputRequest.id,allow,scope});
async function paused(f,goal='Work'){await f.runtime.start(1,goal);await f.runtime.tick(1);return f.runtime.get(1);}

test('screenshots, trusted click/hover and click_point pause for approval before anything is captured or sent',async()=>{
  for(const [plan,kind,label] of [[look(),'shot',null],[look('t0'),'shot','Board'],[click(),'click','Board'],[click('hover'),'hover','Board']]){
    const f=fixture([plan]),t=await paused(f);
    assert.equal(t.status,'paused');assert.equal(t.reason,'real_input_approval');assert.equal(t.inputRequest.kind,kind);assert.equal(t.inputRequest.label,label);
    assert.equal(t.inputRequest.origin,'https://a.test');assert.equal(t.pending,null);assert.equal(f.shots.length+f.executed.length,0,kind+': nothing attached');
    await assert.rejects(()=>f.runtime.resume(1),/允许或拒绝/);
  }
  // click_point: the approved screenshot is taken once, then the point waits for its own approval.
  const f=fixture([look(),tap]);let t=await paused(f);
  await decide(f,t,true);await f.runtime.tick(1);
  assert.equal(f.shots.length,1);assert.equal(f.shots[0].policy.inputApproval,'action');assert.equal(last(await f.runtime.get(1)).outcome.code,'IMAGE_NEXT_TURN');
  await f.runtime.tick(1);t=await f.runtime.get(1);
  assert.equal(t.reason,'real_input_approval');assert.equal(t.inputRequest.kind,'point');assert.equal(t.inputRequest.x,100);assert.equal(t.inputRequest.y,50);
  assert.equal(t.lastView,null,'the screenshot is used up');assert.equal(f.executed.length,0);
  await decide(f,t,true);await f.runtime.tick(1);
  assert.equal(f.executed.length,1);assert.equal(f.executed[0].pending.plan.action,'click_point');assert.deepEqual(f.executed[0].pending.point,{x:100,y:50});
});

test('deny returns REAL_INPUT_DENIED to the model and never attaches',async()=>{
  for(const plan of [click(),look()]){
    const f=fixture([plan]);let t=await paused(f);
    await decide(f,t,false);t=await f.runtime.get(1);
    assert.equal(t.status,'running');assert.equal(t.inputRequest,null);assert.equal(t.inputApproval,undefined);
    assert.equal(last(t).action,plan.action);assert.equal(last(t).outcome.code,'REAL_INPUT_DENIED');assert.equal(last(t).outcome.dispatch,'not_sent');
    await f.runtime.tick(1);assert.equal(f.shots.length+f.executed.length,0);
    await assert.rejects(()=>decide(f,{...t,inputRequest:{id:'u1'}},true),/过期/);
  }
  await assert.rejects(()=>fixture([]).runtime.inputApproval(1,{taskId:'x',requestId:'y',allow:false,scope:'task'}),/无效/);
});

test('approve once runs exactly that action once; the next use asks again',async()=>{
  const f=fixture([click(),click()]);let t=await paused(f);
  await decide(f,t,true);t=await f.runtime.get(1);assert.equal(t.phase,'approved');assert.equal(t.inputApproval,undefined);
  await f.runtime.tick(1);
  assert.equal(f.executed.length,1);assert.equal(f.executed[0].pending.plan.trusted,true);assert.equal(f.executed[0].policy.inputApproval,'action');
  await f.runtime.tick(1);t=await f.runtime.get(1);
  assert.equal(t.reason,'real_input_approval');assert.equal(f.executed.length,1,'second use waits for a new approval');
});

test('task approval: later uses on the same tab and origin skip the card until revoked; other grants are dropped',async()=>{
  const f=fixture([click(),look(),click('hover'),click()]);let t=await paused(f);
  await decide(f,t,true,'task');t=await f.runtime.get(1);
  assert.deepEqual(t.inputApproval,{scope:'task',origin:'https://a.test',tabId:1,grantedAt:t.inputApproval.grantedAt});
  await f.runtime.tick(1);assert.equal(f.executed.length,1);
  await f.runtime.tick(1);assert.equal(f.shots.length,1,'screenshot without a card');assert.equal((await f.runtime.get(1)).status,'running');
  await f.runtime.tick(1);assert.equal(f.executed.length,2,'hover without a card');
  await f.runtime.revokeInputApproval(1,{taskId:t.taskId});
  await f.runtime.tick(1);t=await f.runtime.get(1);
  assert.equal(t.reason,'real_input_approval');assert.equal(f.executed.length,2);
  // stop / takeover keep the grant like scripts; finish ends it.
  const g=fixture([click()]);t=await paused(g);await g.runtime.inputApproval(1,{taskId:t.taskId,requestId:t.inputRequest.id,allow:true,scope:'task'});
  await g.runtime.stop(1);assert.ok((await g.runtime.get(1)).inputApproval);
  await g.runtime.finish(1);assert.equal((await g.runtime.get(1)).inputApproval,null);
  for(const grant of [{scope:'task',origin:'https://other.test',tabId:1,grantedAt:1},{scope:'task',origin:'https://a.test',tabId:2,grantedAt:1}]){
    const h=fixture([click()]);await h.runtime.start(1,'Work');const r=await h.store.get(1);r.inputApproval=grant;await h.store.set(1,r);
    await h.runtime.tick(1);t=await h.runtime.get(1);
    assert.equal(h.executed.length,0);assert.equal(t.reason,'real_input_approval');assert.equal(t.inputApproval,null);
  }
});

test('an origin change ends the task approval',async()=>{
  const f=fixture([click(),click()],{realStore:true});let t=await paused(f);
  await decide(f,t,true,'task');await f.runtime.tick(1);assert.equal(f.executed.length,1);
  f.page.url='https://b.test/';f.page.documentId='d2';
  await f.runtime.tick(1);t=await f.runtime.get(1);assert.equal(t.origin,'https://b.test');assert.ok(!t.inputApproval);
  await f.runtime.tick(1);t=await f.runtime.get(1);
  assert.equal(t.reason,'real_input_approval');assert.equal(f.executed.length,1);
});

test('the settings switch off overrides every approval',async()=>{
  const f=fixture([click(),look()]);let t=await paused(f);
  await decide(f,t,true,'task');await f.runtime.tick(1);assert.equal(f.executed.length,1);
  f.state.on=false;await f.runtime.tick(1);t=await f.runtime.get(1);
  assert.equal(t.inputApproval,null,'grant dropped');assert.equal(last(t).outcome.code,'REAL_INPUT_DISABLED');assert.equal(f.shots.length,0);
  // An approved, not yet dispatched screenshot is refused too.
  const g=fixture([look()]);t=await paused(g);await decide(g,t,true);g.state.on=false;await g.runtime.tick(1);
  assert.equal(last(await g.runtime.get(1)).outcome.code,'REAL_INPUT_DISABLED');assert.equal(g.shots.length,0);
  // Turning the switch off in settings (background → reviewApprovals) drops grants of idle tasks.
  const h=fixture([click()]);t=await paused(h);await decide(h,t,true,'task');await h.runtime.stop(1);
  await h.runtime.reviewApprovals();assert.ok((await h.runtime.get(1)).inputApproval);
  h.state.on=false;await h.runtime.reviewApprovals();assert.equal((await h.runtime.get(1)).inputApproval,null);
});

test('a pending approval survives a worker restart without running; stop, takeover and navigation discard it',async()=>{
  const f=fixture([click()]);let t=await paused(f);
  const restarted=f.make();await restarted.recover();await restarted.tick(1);await restarted.tick(1);
  t=await restarted.get(1);assert.equal(t.reason,'real_input_approval');assert.ok(t.inputRequest);assert.equal(f.executed.length,0);
  await restarted.inputApproval(1,{taskId:t.taskId,requestId:t.inputRequest.id,allow:true,scope:'once'});await restarted.tick(1);
  assert.equal(f.executed.length,1,'runs only after the approval, once');
  for(const end of ['stop','takeover']){
    const g=fixture([click()]);t=await paused(g);await g.runtime[end](1);
    const after=await g.runtime.get(1);assert.equal(after.inputRequest,null);assert.equal(last(after).outcome.code,'REAL_INPUT_DISCARDED');
    await assert.rejects(()=>decide(g,t,true),/过期/);await g.runtime.tick(1);assert.equal(g.executed.length,0);
  }
  const n=fixture([click()]);t=await paused(n);await n.runtime.navigationChanged(1,'https://a.test/next');
  const moved=await n.runtime.get(1);assert.equal(moved.reason,'input_stale');assert.equal(last(moved).outcome.code,'REAL_INPUT_DISCARDED');
  // Approved but the page changed before dispatch: nothing is sent.
  const s=fixture([click()]);t=await paused(s);await decide(s,t,true);s.page.url='https://a.test/other';await s.runtime.tick(1);assert.equal(s.executed.length,0);
});

test('a plain click carries the task grant to browser-tools only for the unreachable fallback; no card',async()=>{
  const f=fixture([{reply:'press',action:'click',id:'t0'},click(),{reply:'press',action:'click',id:'t0'}]);
  await f.runtime.start(1,'Work');await f.runtime.tick(1);
  assert.equal(f.executed.length,1);assert.equal(f.executed[0].policy.inputApproval,null);assert.equal((await f.runtime.get(1)).status,'running');
  await f.runtime.tick(1);let t=await f.runtime.get(1);await decide(f,t,true,'task');await f.runtime.tick(1);
  await f.runtime.tick(1);
  assert.equal(f.executed.length,3);assert.equal(f.executed[2].policy.inputApproval,'task');assert.equal(f.executed[2].pending.inputKind,undefined);
});
