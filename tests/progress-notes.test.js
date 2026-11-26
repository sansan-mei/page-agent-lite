const {test}=require('node:test');
const assert=require('node:assert/strict');
const C=require('../extension/core.js');
const P=require('../extension/prompts.js');
const {createRuntime}=require('../extension/runtime.js');

// Same-origin pagination: each page shows only its own rows, like the Douban/HN/cnblogs field runs.
function fixture(plans){
  const data=new Map(),inputs=[];let seq=0,turn=0,url='https://list.test/?page=1';
  const store={async get(id){return structuredClone(data.get(id)||null);},async set(id,t){data.set(id,structuredClone(t));},async remove(id){data.delete(id);},async list(){return [...data.values()].map(t=>structuredClone(t));}};
  const tools={
    async tab(id){return {id,url,status:'complete'};},
    async observe(){return {url,documentId:url,snapshotId:'s'+url,page:{text:url.endsWith('1')?'Row A 9.7':'Row B 9.1',elements:[{id:'t0',key:'next',label:'Next',tag:'a'}]}};},
    async execute(){url=url.endsWith('1')?'https://list.test/?page=2':'https://list.test/?page=1';return {version:2,status:'success',dispatch:'sent',scope:'ui',code:'CONDITIONS_MATCH',recovery:'none',message:'Matched'};}
  };
  const runtime=createRuntime({store,tools,schedule:()=>{},cancelSchedule:async()=>{},uuid:()=>String(++seq),preferences:async()=>({maxSteps:50}),
    model:async text=>{inputs.push(JSON.parse(text));return {text:JSON.stringify(plans[Math.min(turn++,plans.length-1)])};}});
  return {runtime,inputs};
}

test('progress written when leaving a page is returned on the next page, with the page it was written on',async()=>{
  const f=fixture([{reply:'第1页读完，去第2页',action:'click',id:'t0',progress:'第1页: Row A 9.7。待读: 第2页'},{reply:'完成',action:'done'}]);
  await f.runtime.start(1,'List rows >= 9.5 on pages 1 and 2');
  for(let i=0;i<3&&(await f.runtime.get(1)).status!=='completed';i++)await f.runtime.tick(1);
  assert.equal(f.inputs[0].progress,null);
  const second=f.inputs[1];
  assert.deepEqual(second.progress,{text:'第1页: Row A 9.7。待读: 第2页',url:'https://list.test/?page=1'});
  assert.equal(JSON.stringify(second).includes('Row A'),true,'only through progress, the page text is page 2');
  assert.equal(second.page.text,'Row B 9.1');
});

test('a later progress replaces the earlier one; omitting it keeps the last value',async()=>{
  const f=fixture([{reply:'a',action:'click',id:'t0',progress:'p1'},{reply:'b',action:'click',id:'t0'},{reply:'c',action:'click',id:'t0',progress:'p1+p2 done'},{reply:'完成',action:'done'}]);
  await f.runtime.start(1,'Collect');
  for(let i=0;i<8&&(await f.runtime.get(1)).status!=='completed';i++)await f.runtime.tick(1);
  assert.deepEqual(f.inputs.map(i=>i.progress?.text??null),[null,'p1','p1','p1+p2 done']);
});

test('agentPlan accepts progress on any action as nonempty text up to 3000 characters',()=>{
  const snap={nodes:new Map([['t0',true]])};
  assert.equal(C.agentPlan(JSON.stringify({reply:'r',action:'click',id:'t0',progress:'x'}),snap).progress,'x');
  assert.equal(C.agentPlan(JSON.stringify({reply:'r',action:'done',progress:'y'}),snap).progress,'y');
  for(const progress of ['','  ','x'.repeat(3001),3])assert.throws(()=>C.agentPlan(JSON.stringify({reply:'r',action:'click',id:'t0',progress}),snap));
});

test('the tool schema and the system prompt both expose progress',()=>{
  for(const tool of P.agentTools())assert.ok(tool.function.parameters.properties.progress,tool.function.name);
  assert.match(P.agentSystem('中文','native'),/progress \(optional on any action/);
});
