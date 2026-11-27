const {test}=require('node:test');
const assert=require('node:assert/strict');
const C=require('../extension/core.js');
const P=require('../extension/prompts.js');
const {createRuntime}=require('../extension/runtime.js');

const refs=[{action:'site_memory_read',id:'flow'},{action:'global_memory_read',id:'tone'},{action:'site_skill_read',id:'save'}];
function fixture(plans){
  const data=new Map(),inputs=[],reads=[],writes=[];let seq=0,turn=0,executions=0;
  const store={async get(id){return structuredClone(data.get(id)||null);},async set(id,t){data.set(id,structuredClone(t));},async remove(id){data.delete(id);},async list(){return [...data.values()].map(t=>structuredClone(t));}};
  const memory=(scope,note)=>({async read(origin){reads.push({scope,origin});return {version:1,notes:[note]};},async change(){writes.push(scope);throw new Error('read-only test');}});
  const siteMemory=memory('site',{id:'flow',text:'Verified site procedure'}),globalMemory=memory('global',{id:'tone',text:'Explicit reply preference'}),siteSkills=memory('skill',{id:'save',description:'Save a form',text:'1. Use Save and verify.'});
  const tools={async tab(id){return {id,url:'https://example.test/form',status:'complete'};},async observe(){return {url:'https://example.test/form',documentId:'doc',snapshotId:'snap',page:{text:'Form',elements:[]}};},async execute(){executions++;throw new Error('No page action expected');}};
  const runtime=createRuntime({store,tools,siteMemory,globalMemory,siteSkills,schedule:()=>{},cancelSchedule:async()=>{},uuid:()=>String(++seq),preferences:async()=>({maxSteps:20}),model:async text=>{inputs.push(JSON.parse(text));return {text:JSON.stringify(plans[Math.min(turn++,plans.length-1)])};}});
  return {runtime,inputs,reads,writes,siteMemory,globalMemory,siteSkills,executions:()=>executions};
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
  assert.ok(batch.reads.every(r=>r.origin===(r.scope==='global'?null:'https://example.test')));
});
