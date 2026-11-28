// Read-only loops: screenshots, scripts and reads that keep returning the same answer with no page action in between.
const {test}=require('node:test');const assert=require('node:assert/strict');
const {createRuntime}=require('../extension/runtime.js');
const T=require('../extension/tool-protocol.js');
const {preapprove}=require('./real-input-helper.js');

function fixture(plan,{goalMode=false}={}){
  const data=new Map(),models=[],executed=[];let seq=0,n=0;const stored=new Set();
  const store={async get(id){return structuredClone(data.get(id)||null);},async set(id,t){data.set(id,structuredClone(t));},async remove(id){data.delete(id);},async list(){return [...data.values()].map(t=>structuredClone(t));}};
  const images={mode:async()=>'supported',async claim(){return [];},async recognize(){return '';},
    async saveShot(){const id='shot_'+String(++n).padStart(8,'0');stored.add(id);return id;},
    async dropShots(taskId,keep){for(const id of [...stored])if(!keep.includes(id))stored.delete(id);},
    async present(ids){return ids.filter(id=>stored.has(id));},async remove(){},async prune(){}};
  const tools={async tab(id){return {id,url:'https://game.test/',status:'complete'};},
    async observe(){return {url:'https://game.test/',documentId:'d1',snapshotId:'s'+(++seq),page:{text:'Level 9',elements:[{id:'t1',key:'k1',tag:'div'},{id:'t2',key:'k2',tag:'div'},{id:'t3',key:'k3',label:'Verify',tag:'button'}]}};},
    async screenshot(){return {data:'SlBFRw==',masked:0,width:800,height:600};},
    async execute(id,p){executed.push(p.plan.action);
      if(p.plan.action==='run_script')return T.result({status:'success',dispatch:'sent',scope:'dispatch',code:'SCRIPT_RESULT',recovery:'observe',observed:{result:'[]',truncated:false,world:'USER_SCRIPT'},message:'脚本已执行'});
      return T.result({status:'success',dispatch:'sent',scope:'ui',code:'TARGET_VISUAL_CHANGED',recovery:'observe',message:'外观已变化'});},
    async realInputEnabled(){return true;},async releaseInput(){return true;}};
  let turn=0;
  const runtime=preapprove(createRuntime({store,tools,images,schedule:()=>{},cancelSchedule:async()=>{},uuid:()=>'id'+(++seq),preferences:async()=>({maxSteps:100}),
    scriptAccess:async()=>({permission:true,api:true,available:true}),
    model:async(text)=>{models.push(JSON.parse(text));return {text:JSON.stringify(plan(turn++))};}}),store);
  const start=async()=>{await runtime.submit(1,'Play the game',{goalMode});const t=await store.get(1);t.scriptApproval={scope:'task',origin:t.origin,tabId:1,grantedAt:0};await store.set(1,t);};
  const run=async max=>{for(let i=0;i<max&&['running','waiting_page'].includes((await store.get(1)).status);i++)await runtime.tick(1);return store.get(1);};
  return {runtime,store,models,executed,start,run};
}
const SHOT={reply:'Look at the grid',action:'view_image',id:'viewport'};
const SCRIPT={reply:'Read tile positions',action:'run_script',value:{code:'return [...document.querySelectorAll("[role=button]")].map(e=>e.id);',world:'USER_SCRIPT'}};
const hints=t=>t.results.filter(r=>r.outcome?.code==='NO_NEW_INFORMATION');

test('view_image and run_script alternating with the same answer: one hint to the model, then a no_progress pause',async()=>{
  const f=fixture(i=>i%2?SCRIPT:SHOT);await f.start();
  const t=await f.run(30);
  assert.equal(t.status,'paused');assert.equal(t.reason,'no_progress');
  assert.match(t.events.at(-1).text,/只读操作.*重复.*已暂停/);
  assert.equal(hints(t).length,1,'the hint is given once per streak');
  assert.ok(f.models.some(m=>JSON.stringify(m.results).includes('NO_NEW_INFORMATION')),'the model sees the hint');
  assert.ok(f.models.length<=10,'stopped long before the round budget: '+f.models.length);
  assert.ok(f.executed.every(a=>a==='run_script'),'nothing but the scripts was dispatched');
});

test('goal mode allows more repeats before pausing',async()=>{
  const plain=fixture(i=>i%2?SCRIPT:SHOT);await plain.start();await plain.run(30);
  const goal=fixture(i=>i%2?SCRIPT:SHOT,{goalMode:true});await goal.start();
  const t=await goal.run(30);
  assert.equal(t.reason,'no_progress');assert.ok(goal.models.length>plain.models.length);
});

test('a page action between screenshots is progress: click, look, click, look never pauses',async()=>{
  const f=fixture(i=>i>=24?{reply:'Done',action:'done'}:i%2?SHOT:{reply:'Pick a tile',action:'click',id:i%4===0?'t1':'t2'});await f.start();
  const t=await f.run(40);
  assert.notEqual(t.reason,'no_progress');assert.equal(hints(t).length,0);
  assert.equal(f.executed.filter(a=>a==='click').length,12);
});

test('different answers are new information; continue after the pause starts a fresh count',async()=>{
  let k=0;
  const f=fixture(i=>i<12?{reply:'Read',action:'observe',value:{elementOffset:0,query:'tile '+(k++)}}:i%2?SCRIPT:SHOT);await f.start();
  await f.run(12);
  let t=await f.store.get(1);assert.equal(t.status,'running');assert.equal(hints(t).length,0,'distinct reads do not count');
  t=await f.run(30);assert.equal(t.reason,'no_progress');
  const before=f.models.length;
  await f.runtime.resume(1);await f.runtime.tick(1);
  t=await f.store.get(1);assert.equal(t.status,'running','continue is not paused again by the old streak');assert.equal(f.models.length,before+1);
});
