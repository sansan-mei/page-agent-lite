const {test}=require('node:test');const assert=require('node:assert/strict');
const {createRuntime}=require('../extension/runtime.js');
// Real runtime with an in-memory store; tools record debugger releases.
function fixture({model,tools={}}={}){
 const data=new Map(),released=[],executed=[];let seq=0;
 const store={async get(id){return structuredClone(data.get(id)||null);},async set(id,t){data.set(id,structuredClone(t));},async remove(id){data.delete(id);},async list(){return [...data.values()].map(t=>structuredClone(t));}};
 const base={async tab(id){return {id,url:'https://example.test/1',status:'complete'};},
  async observe(){return {url:'https://example.test/1',documentId:'d1',snapshotId:'s'+(++seq),page:{text:'',elements:[{id:'t0',key:'node1',label:'Go',tag:'button'}],regions:[]}};},
  async execute(id,pending,policy){executed.push({pending,policy});return {version:2,status:'unknown',dispatch:'sent',scope:'dispatch',code:'NO_CHANGE',recovery:'observe',message:'x'};},
  async releaseInput(id){released.push(id);return true;},...tools};
 const runtime=createRuntime({store,tools:base,summarize:async()=>({text:'{}'}),schedule(){},cancelSchedule:async()=>{},uuid:()=>'u'+(++seq),preferences:async()=>({maxSteps:50,contextTokens:32768}),model:model||(async()=>({text:'{"reply":"完成","action":"done"}'}))});
 return {data,store,runtime,released,executed};
}

test('debugger session is released when the task completes, stops, is taken over, ends or is cleared',async()=>{
 let f=fixture();await f.runtime.start(1,'Work');await f.runtime.tick(1);
 assert.equal((await f.runtime.get(1)).status,'completed');assert.deepEqual(f.released,[1]);
 for(const command of ['stop','takeover','finish','remove']){
  f=fixture({model:async()=>({text:'{"reply":"Click","action":"click","id":"t0"}'})});
  await f.runtime.start(1,'Work');await f.runtime.tick(1);
  assert.equal((await f.store.get(1)).status,'running');assert.deepEqual(f.released,[],'a running task keeps its session');
  await f.runtime[command](1);assert.ok(f.released.includes(1),command+' releases the debugger');
 }
});

test('worker recovery releases sessions of tasks that are no longer running',async()=>{
 const f=fixture();await f.runtime.start(1,'Work');await f.runtime.start(2,'Other');
 const t=await f.store.get(2);t.status='paused';t.reason='user_takeover';await f.store.set(2,t);
 await f.runtime.recover();assert.deepEqual(f.released,[2]);
});
