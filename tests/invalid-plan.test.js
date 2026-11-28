const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createRuntime}=require('../extension/runtime.js');
const C=require('../extension/core.js');

// Model replies are consumed in order; the last one repeats.
function fixture(replies,{goalMode=true,checked}={}){
 const data=new Map(),executed=[];let seq=0,calls=0;
 const store={async get(id){return structuredClone(data.get(id)||null);},async set(id,t){data.set(id,structuredClone(t));},async remove(id){data.delete(id);},async list(){return [...data.values()].map(t=>structuredClone(t));},async getMemory(){return [];},async setMemory(){},async removeMemory(){}};
 const element={id:'t0',key:'k0',label:'周末可送',tag:'input',type:'checkbox',...(checked===undefined?{}:{checked})};
 const tools={async tab(id){return {id,url:'https://example.test/1',status:'complete'};},
  async observe(){return {url:'https://example.test/1',documentId:'doc',snapshotId:'s',page:{text:'Hello World!',elements:[element],regions:[{id:'r0',key:'rk',label:'结果',text:'Hello World!',visible:true}],coverage:{elementsComplete:true,regionsComplete:true}}};},
  async execute(id,p){executed.push(p);return {version:2,status:'success',dispatch:'sent',scope:'ui',code:'CONDITIONS_MATCH',recovery:'none',message:'Matched'};}};
 const model=async()=>({text:JSON.stringify(replies[Math.min(calls++,replies.length-1)])});
 const runtime=createRuntime({store,tools,model,summarize:async()=>({text:'{}'}),schedule:()=>{},cancelSchedule:async()=>{},uuid:()=>String(++seq),preferences:async()=>({maxSteps:50,contextTokens:32768})});
 return {runtime,executed,goalMode,calls:()=>calls};
}
const pageWide={reply:'已出现 Hello World!',action:'done',expected:[{kind:'text_present',value:'Hello World!'}]};
const regionScoped={reply:'已出现 Hello World!',action:'done',expected:[{kind:'text_present',id:'r0',value:'Hello World!'}]};

test('a malformed expected on done goes back to the model as INVALID_PLAN instead of failing the task',async()=>{
 const f=fixture([pageWide,regionScoped]);
 await f.runtime.submit(1,'等待加载',{goalMode:true});await f.runtime.tick(1);
 let t=await f.runtime.get(1);
 assert.equal(t.status,'running');assert.equal(t.phase,'observe');
 const bad=t.results.at(-1);
 assert.equal(bad.action,'invalid_plan');assert.equal(bad.outcome.code,'INVALID_PLAN');assert.equal(bad.outcome.recovery,'replan');assert.equal(bad.outcome.dispatch,'not_sent');
 assert.match(bad.outcome.message,/验证条件需要目标.*收到 expected=.*text_present/);
 assert.deepEqual(bad.request.expected,pageWide.expected,'the rejected plan is kept for diagnosis');
 await f.runtime.tick(1);t=await f.runtime.get(1);
 assert.equal(t.status,'completed');assert.equal(f.executed.length,0);
});

test('INVALID_PLAN is bounded: the third consecutive malformed plan pauses, never fails',async()=>{
 for(const goalMode of [true,false]){
  const f=fixture([pageWide],{goalMode});
  await f.runtime.submit(1,'等待加载',{goalMode});
  for(let i=0;i<3;i++)await f.runtime.tick(1);
  const t=await f.runtime.get(1);
  assert.equal(t.status,'paused');assert.equal(t.reason,'model');assert.match(t.events.at(-1).text,/连续 3 次/);
  assert.equal(f.calls(),3);assert.equal(f.executed.length,0);
 }
});

test('an expected target missing from the snapshot is returned to the model and nothing is clicked',async()=>{
 const f=fixture([{reply:'保存',action:'click',id:'t0',expected:[{kind:'element_visible',id:'t9'}]},{reply:'保存',action:'click',id:'t0'}]);
 await f.runtime.submit(1,'保存',{goalMode:true});await f.runtime.tick(1);
 let t=await f.runtime.get(1);
 assert.equal(t.status,'running');assert.equal(t.results.at(-1).outcome.code,'INVALID_PLAN');assert.equal(t.results.at(-1).action,'click');assert.equal(f.executed.length,0);
 await f.runtime.tick(1);assert.equal(f.executed.length,1);
});

test('boolean checks written as "true"/"false" strings are accepted as booleans; other strings still fail',async()=>{
 const snap={nodes:new Map([['t0',true]])};
 const plan=C.agentPlan(JSON.stringify({reply:'ok',action:'done',expected:[{kind:'checked_equals',id:'t0',value:'true'},{kind:'expanded_equals',id:'t0',value:' False '}]}),snap);
 assert.deepEqual(plan.expected.map(c=>c.value),[true,false]);
 const sub=C.agentPlan(JSON.stringify({reply:'ok',action:'observe',subgoals:[{id:'a',title:'勾选',status:'completed',checks:[{kind:'checked_equals',id:'t0',value:'TRUE'}]}]}),snap);
 assert.equal(sub.subgoals[0].checks[0].value,true);
 assert.throws(()=>C.agentPlan(JSON.stringify({reply:'ok',action:'done',expected:[{kind:'checked_equals',id:'t0',value:'是'}]}),snap),/验证勾选值无效/);
 const f=fixture([{reply:'已勾选',action:'done',expected:[{kind:'checked_equals',id:'t0',value:'true'}]}],{checked:true});
 await f.runtime.submit(1,'勾选周末可送',{goalMode:true});await f.runtime.tick(1);
 assert.equal((await f.runtime.get(1)).status,'completed');
});
