const {test}=require('node:test');
const assert=require('node:assert/strict');
const C=require('../extension/core.js');
const P=require('../extension/prompts.js');
const {createRuntime}=require('../extension/runtime.js');

const refs=[{action:'site_memory_read',id:'flow'},{action:'global_memory_read',id:'tone'},{action:'skill_read',id:'save'}];
function fixture(plans){
  const data=new Map(),inputs=[],reads=[],writes=[];let seq=0,turn=0,executions=0;
  const store={async get(id){return structuredClone(data.get(id)||null);},async set(id,t){data.set(id,structuredClone(t));},async remove(id){data.delete(id);},async list(){return [...data.values()].map(t=>structuredClone(t));}};
  const memory=(scope,note)=>({async read(origin){reads.push({scope,origin});return {version:1,notes:[note]};},async change(){writes.push(scope);throw new Error('read-only test');}});
  const siteMemory=memory('site',{id:'flow',text:'Verified site procedure'}),globalMemory=memory('global',{id:'tone',text:'Explicit reply preference'}),skills=memory('skill',{id:'save',description:'Save a form',text:'1. Use Save and verify.'});
  const tools={async tab(id){return {id,url:'https://example.test/form',status:'complete'};},async observe(){return {url:'https://example.test/form',documentId:'doc',snapshotId:'snap',page:{text:'Form',elements:[]}};},async execute(){executions++;throw new Error('No page action expected');}};
  const runtime=createRuntime({store,tools,siteMemory,globalMemory,skills,schedule:()=>{},cancelSchedule:async()=>{},uuid:()=>String(++seq),preferences:async()=>({maxSteps:20}),model:async text=>{inputs.push(JSON.parse(text));return {text:JSON.stringify(plans[Math.min(turn++,plans.length-1)])};}});
  return {runtime,inputs,reads,writes,siteMemory,globalMemory,skills,executions:()=>executions};
}
async function run(f){await f.runtime.start(1,'Read the reference notes');for(let i=0;i<8&&(await f.runtime.get(1)).status==='running';i++)await f.runtime.tick(1);return f.runtime.get(1);}
const done={reply:'Read all requested references',action:'done'};

test('batch reference reads preserve individual results and reduce three read rounds to one',async()=>{
  const single=fixture(refs.map(r=>({reply:'Read',...r})).concat(done));
  const batch=fixture([{reply:'Read relevant references together',action:'read_references',value:refs},done]);
  const before=await run(single),after=await run(batch);
  assert.equal(before.status,'completed');assert.equal(after.status,'completed');
  assert.equal(before.steps,4);assert.equal(after.steps,2);
  const results=t=>t.results.filter(r=>refs.some(ref=>ref.action===r.action)).map(r=>({action:r.action,result:r.result}));
  assert.deepEqual(results(after),results(before));
  assert.equal(batch.inputs[1].results.length,3);
  assert.deepEqual(batch.writes,[]);assert.equal(batch.executions(),0);
  assert.ok(batch.reads.every(r=>r.origin===(r.scope==='site'?'https://example.test':null)),'skills and global notes are read without an origin');
});

test('batch validator rejects mutations, nested batches, extra fields, duplicates and unbounded reads',()=>{
  const parse=(value,extra={})=>C.agentPlan(JSON.stringify({reply:'Read',action:'read_references',value,...extra}),{nodes:new Map()});
  assert.deepEqual(parse(refs).value,refs);
  for(const bad of [null,[],[refs[0]],Array(9).fill(refs[0]),[refs[0],refs[0]],
    [refs[0],{action:'site_memory_write',id:'x'}],[refs[0],{action:'click',id:'t0'}],
    [refs[0],{action:'read_references',id:'x'}],[refs[0],{action:'site_memory_read',id:'bad id'}],
    [refs[0],{...refs[1],origin:'https://other.test'}],[refs[0],{...refs[1],value:'extra'}]])assert.throws(()=>parse(bad));
  assert.throws(()=>parse(refs,{id:'x'}));assert.throws(()=>parse(refs,{expected:[]}));
});

test('native and JSON prompts expose the same bounded read-only batch',()=>{
  const tool=P.agentTools().find(t=>t.function.name==='read_references');
  assert.ok(tool);assert.equal(tool.function.parameters.properties.value.maxItems,8);
  assert.equal(tool.function.parameters.properties.value.items.additionalProperties,false);
  assert.deepEqual(tool.function.parameters.properties.value.items.properties.action.enum,refs.map(r=>C.agentPublicAction(r.action).action));
  for(const protocol of ['native','json'])assert.match(P.agentSystem('English',protocol),/do not batch reads whose selection depends on an earlier result/i);
});

test('a missing reference returns its own error without dropping the other results',async()=>{
  const f=fixture([{reply:'Read',action:'read_references',value:[{action:'site_memory_read',id:'missing'},refs[1]]},done]);
  const t=await run(f);assert.equal(t.status,'completed');
  assert.match(t.results[0].result.error,/没有此长期记忆/);assert.equal(t.results[1].result.note.id,'tone');
});

test('stopping during a read drops its late result and never starts remaining references',async()=>{
  const f=fixture([{reply:'Read',action:'read_references',value:refs},done]);
  const original=f.siteMemory.read;let calls=0,entered,release;
  const started=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
  f.siteMemory.read=async origin=>{if(++calls===3){entered();await gate;}return original(origin);};
  await f.runtime.start(1,'Read references');const ticking=f.runtime.tick(1);
  await started;const stopping=f.runtime.stop(1);await new Promise(r=>setImmediate(r));release();await stopping;await ticking;
  const t=await f.runtime.get(1);assert.equal(t.status,'stopped');assert.equal(t.results.length,0);
  assert.equal(f.reads.filter(r=>r.scope==='skill').length,1,'only the initial skill index was read');
  assert.equal(f.executions(),0);
});

test('user global-memory edits invalidate batched read bodies just like individual reads',async()=>{
  const f=fixture([{reply:'Read',action:'read_references',value:refs},done]);
  await f.runtime.start(1,'Read references');await f.runtime.tick(1);
  assert.ok((await f.runtime.get(1)).results.some(r=>r.action==='global_memory_read'));
  await assert.rejects(()=>f.runtime.editGlobalMemory({action:'clear'}),/read-only test/);
  const t=await f.runtime.get(1);assert.equal(t.status,'paused');assert.equal(t.reason,'global_memory_changed');
  assert.ok(!t.results.some(r=>r.action==='global_memory_read'));
});
