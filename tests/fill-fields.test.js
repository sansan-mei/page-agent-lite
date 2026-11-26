const {test}=require('node:test');
const assert=require('node:assert/strict');
const C=require('../extension/core.js');
const {createRuntime}=require('../extension/runtime.js');

// Every observation renumbers ids (like the real snapshot), so queued steps must be found again by key.
function fixture({plans,fields=['name','email','agree'],execute,preferences}={}){
  const data=new Map(),executed=[],models=[];let seq=0,observed=0,turn=0,visible=fields;
  const store={async get(id){return structuredClone(data.get(id)||null);},async set(id,t){data.set(id,structuredClone(t));},async remove(id){data.delete(id);},async list(){return [...data.values()].map(t=>structuredClone(t));}};
  const tools={
    async tab(id){return {id,url:'https://form.test/a',status:'complete'};},
    async observe(){observed++;return {url:'https://form.test/a',documentId:'doc',snapshotId:'s'+observed,page:{text:'Form',elements:visible.map((key,i)=>({id:'t'+(observed*10+i),key,label:key,tag:'input'}))}};},
    async execute(id,pending){executed.push({action:pending.plan.action,id:pending.plan.id,value:pending.plan.value,snapshotId:pending.snapshotId});
      return execute?execute(pending,executed.length):{version:2,status:'success',dispatch:'sent',scope:'ui',code:'CONDITIONS_MATCH',recovery:'none',message:'Matched'};}
  };
  const runtime=createRuntime({store,tools,schedule:()=>{},cancelSchedule:async()=>{},uuid:()=>String(++seq),preferences:preferences||(async()=>({maxSteps:50})),
    model:async text=>{const input=JSON.parse(text);models.push(input);const plan=plans[Math.min(turn++,plans.length-1)];return {text:JSON.stringify(typeof plan==='function'?plan(input):plan)};}});
  return {runtime,executed,models,hide(keys){visible=fields.filter(k=>!keys.includes(k));}};
}
const idOf=(input,key)=>input.page.elements.find(e=>e.key===key).id;
const batch=input=>({reply:'填写表单',action:'fill_fields',value:[{action:'fill',id:idOf(input,'name'),value:'Ada'},{action:'fill',id:idOf(input,'email'),value:'ada@x.test'},{action:'check',id:idOf(input,'agree'),value:true}]});
const ticks=async(f,n)=>{for(let i=0;i<n;i++)await f.runtime.tick(1);};

test('fill_fields runs every step through the normal action path with one model request',async()=>{
  const f=fixture({plans:[batch,{reply:'完成',action:'done'}]});
  await f.runtime.start(1,'Fill the form');await ticks(f,4);
  const task=await f.runtime.get(1);
  assert.deepEqual(f.executed.map(e=>[e.action,e.value]),[['fill','Ada'],['fill','ada@x.test'],['check',true]]);
  assert.equal(new Set(f.executed.map(e=>e.snapshotId)).size,3,'each step uses its own fresh snapshot');
  assert.deepEqual(f.executed.map(e=>e.id),['t10','t21','t32'],'later steps are re-found by key in renumbered snapshots');
  assert.equal(f.models.length,2);assert.equal(task.steps,2);assert.equal(task.status,'completed');assert.equal(task.batch,null);
  const summary=f.models[1].results.find(r=>r.action==='fill_fields');assert.equal(summary.outcome.code,'BATCH_DONE');
  assert.equal(task.metrics.actions,3);assert.ok(task.events.some(e=>e.text==='填写表单（3/3）'));
});

test('a missing target stops the batch, reports the steps not run and hands back to the model',async()=>{
  const f=fixture({plans:[batch,{reply:'等待',action:'pause',pauseReason:'user'}]});
  await f.runtime.start(1,'Fill the form');await f.runtime.tick(1);
  f.hide(['email']);await ticks(f,2);
  assert.equal(f.executed.length,1);
  const stop=f.models[1].results.find(r=>r.action==='fill_fields');
  assert.equal(stop.outcome.code,'BATCH_STOPPED');assert.equal(stop.outcome.dispatch,'not_sent');assert.match(stop.outcome.message,/第 1\/3 步后停止（找不到第 2 步的目标字段）；未执行 2 项：email、agree/);
});

test('a failed step stops the batch without running later fields',async()=>{
  const f=fixture({plans:[batch,{reply:'等待',action:'pause',pauseReason:'user'}],
    execute:()=>{throw Object.assign(new Error('目标已变化'),{code:'STALE'});}});
  await f.runtime.start(1,'Fill the form');await ticks(f,4);
  assert.equal(f.executed.length,1);
  assert.match(f.models.at(-1).results.find(r=>r.action==='fill_fields').outcome.message,/第 1 步未成功/);
});

test('new user input cancels the rest of the batch',async()=>{
  const f=fixture({plans:[batch,{reply:'完成',action:'done'}]});
  await f.runtime.start(1,'Fill the form');await f.runtime.tick(1);
  await f.runtime.submit(1,'先别填邮箱');await f.runtime.tick(1);
  assert.equal(f.executed.length,1);assert.equal(f.models.length,2);
  assert.match(f.models[1].results.find(r=>r.action==='fill_fields').outcome.message,/任务收到新的指令或被打断/);
});

test('queued steps are not stopped by the round budget, the next model request is',async()=>{
  const f=fixture({plans:[batch,{reply:'完成',action:'done'}],preferences:async()=>({maxSteps:1})});
  await f.runtime.start(1,'Fill the form');await ticks(f,4);
  const task=await f.runtime.get(1);
  assert.equal(f.executed.length,3);assert.equal(f.models.length,1);assert.equal(task.status,'paused');assert.equal(task.reason,'budget');
});

test('agentPlan accepts only 2-8 distinct field steps',()=>{
  const snap={nodes:new Map([['t0',true],['t1',true]])};
  const plan=value=>JSON.stringify({reply:'r',action:'fill_fields',value});
  assert.equal(C.agentPlan(plan([{action:'fill',id:'t0',value:'a'},{action:'select',id:'t1',value:'b'}]),snap).value.length,2);
  for(const value of [[{action:'fill',id:'t0',value:'a'}],[{action:'fill',id:'t0',value:'a'},{action:'click',id:'t1',value:''}],
    [{action:'fill',id:'t0',value:'a'},{action:'fill',id:'t0',value:'b'}],[{action:'fill',id:'t0',value:'a'},{action:'fill',id:'t9',value:'b'}],
    [{action:'fill',id:'t0',value:'a'},{action:'check',id:'t1',value:'yes'}],[{action:'fill',id:'t0',value:'a',expected:[]},{action:'fill',id:'t1',value:'b'}]])
    assert.throws(()=>C.agentPlan(plan(value),snap));
  assert.throws(()=>C.agentPlan(JSON.stringify({reply:'r',action:'fill_fields',id:'t0',value:[{action:'fill',id:'t0',value:'a'},{action:'fill',id:'t1',value:'b'}]}),snap),/不带 id/);
});
