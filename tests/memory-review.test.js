const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createRuntime}=require('../extension/runtime.js');
const P=require('../extension/prompts.js');

// Versioned note store with the same CAS contract as site-memory.js.
function memory(){
  const data=new Map();
  return {data,async read(key){return structuredClone(data.get(key??'global')||{version:0,notes:[]});},
    async change(key,p){
      if(p.signal?.aborted)throw new Error('cancelled');
      const old=await this.read(key);if(old.version!==p.expectedVersion)throw Object.assign(new Error('长期记忆已更新，请刷新后重试'),{code:'MEMORY_CONFLICT'});
      const notes=old.notes.filter(n=>p.action==='clear'?false:n.id!==p.id);if(p.action==='write')notes.push({id:p.id,text:p.text,source:p.source});
      const next={version:old.version+1,notes};data.set(key??'global',next);return structuredClone(next);
    }};
}
function fixture({plans=[{reply:'Click',action:'click',id:'t0'},{reply:'完成',action:'done'}],review,preferences,siteMemory=memory(),globalMemory=memory()}={}){
  const data=new Map(),calls=[];let seq=0,turn=0;
  const store={async get(id){return structuredClone(data.get(id)||null);},async set(id,t){data.set(id,structuredClone(t));},async remove(id){data.delete(id);},async list(){return [...data.values()].map(t=>structuredClone(t));}};
  const tools={async tab(id){return {id,url:'https://example.test/1',status:'complete'};},async observe(){return {url:'https://example.test/1',snapshotId:'s',page:{text:'Q',elements:[{id:'t0',label:'Save',tag:'button'}]}};},
    async execute(){return {version:2,status:'success',dispatch:'sent',scope:'ui',code:'CONDITIONS_MATCH',recovery:'none',message:'Matched'};}};
  const runtime=createRuntime({store,tools,siteMemory,globalMemory,schedule:()=>{},cancelSchedule:async()=>{},uuid:()=>String(++seq),
    preferences:preferences||(async()=>({maxSteps:50})),model:async()=>({text:JSON.stringify(plans[Math.min(turn++,plans.length-1)])}),
    review:review&&(async(text,signal)=>{calls.push(JSON.parse(text));return review(text,signal);})});
  return {runtime,calls,siteMemory,globalMemory};
}
const run=async f=>{await f.runtime.start(1,'Save the form');for(let i=0;i<4&&(await f.runtime.get(1)).status!=='completed';i++)await f.runtime.tick(1);};
const answer=notes=>async()=>({text:JSON.stringify({notes})});

test('a completed task with page work gets one review request that saves site and global notes',async()=>{
  const f=fixture({review:answer([{scope:'site',action:'write',id:'save_flow',text:'Save button is at the bottom; verified once.'},{scope:'global',action:'write',id:'tone',text:'User prefers short replies (explicit).'}])});
  await run(f);
  const task=await f.runtime.get(1);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].goal,'Save the form');assert.equal(f.calls[0].origin,'https://example.test');
  assert.ok(f.calls[0].results.some(r=>r.action==='click'));assert.deepEqual(f.calls[0].siteNotes,[]);
  assert.equal(task.status,'completed');assert.equal(task.reviewState,'done');assert.equal(task.steps,3);
  assert.match(task.events.at(-1).text,/任务复盘：记住网站笔记 save_flow、记住全局笔记 tone/);
  assert.equal((await f.siteMemory.read('https://example.test')).notes[0].source,'model');
  assert.equal((await f.globalMemory.read(null)).notes[0].id,'tone');
  await f.runtime.tick(1);assert.equal(f.calls.length,1);
});

test('an empty review answer stays silent and pure answers without page work are not reviewed',async()=>{
  const quiet=fixture({review:answer([])});await run(quiet);
  assert.equal(quiet.calls.length,1);assert.doesNotMatch((await quiet.runtime.get(1)).events.at(-1).text,/复盘/);
  const chat=fixture({plans:[{reply:'答案',action:'done'}],review:answer([])});await run(chat);
  assert.equal(chat.calls.length,0);assert.equal((await chat.runtime.get(1)).reviewState,null);
});

test('a user correction makes even a no-action task reviewable',async()=>{
  const f=fixture({plans:[{reply:'答案',action:'done'}],review:answer([])});await run(f);
  await f.runtime.submit(1,'以后都用英文回答');await f.runtime.tick(1);
  assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].instructions,['以后都用英文回答']);
});

test('the review is skipped when the round budget is exhausted',async()=>{
  const f=fixture({preferences:async()=>({maxSteps:2}),review:answer([])});await run(f);
  assert.equal(f.calls.length,0);assert.equal((await f.runtime.get(1)).reviewState,null);
});

test('new input during the review cancels it and nothing is written',async()=>{
  let release,signalSeen;const gate=new Promise(r=>{release=r;});
  const f=fixture({plans:[{reply:'Click',action:'click',id:'t0'},{reply:'完成',action:'done'},{reply:'Click',action:'click',id:'t0'}],
    review:async(text,signal)=>{signalSeen=signal;await gate;return {text:JSON.stringify({notes:[{scope:'site',action:'write',id:'late',text:'should not be saved'}]})};}});
  await f.runtime.start(1,'Save the form');await f.runtime.tick(1);
  const ticking=f.runtime.tick(1);
  while(!signalSeen)await new Promise(r=>setImmediate(r));
  await f.runtime.submit(1,'再保存一次');assert.equal(signalSeen.aborted,true);release();await ticking;
  assert.equal((await f.siteMemory.read('https://example.test')).notes.length,0);
  const task=await f.runtime.get(1);assert.equal(task.status,'running');assert.equal(task.reviewState,null);
});

test('invalid review output or a version conflict is reported without touching the task result',async()=>{
  const bad=fixture({review:async()=>({text:'not json'})});await run(bad);
  let task=await bad.runtime.get(1);assert.equal(task.status,'completed');assert.match(task.events.at(-1).text,/任务复盘未完成：复盘结果格式无效/);
  const siteMemory=memory();
  const raced=fixture({siteMemory,review:async()=>{await siteMemory.change('https://example.test',{action:'write',id:'user',text:'user edit',expectedVersion:0});return {text:JSON.stringify({notes:[{scope:'site',action:'write',id:'flow',text:'x'}]})};}});
  await run(raced);task=await raced.runtime.get(1);
  assert.match(task.events.at(-1).text,/任务复盘未完成：长期记忆已更新/);assert.deepEqual((await siteMemory.read('https://example.test')).notes.map(n=>n.id),['user']);
});

test('parseReview accepts only bounded note operations',()=>{
  assert.deepEqual(P.parseReview('{"notes":[]}'),{notes:[]});
  assert.deepEqual(P.parseReview('{}'),{notes:[]});
  assert.deepEqual(P.parseReview('{"notes":[{"scope":"site","action":"delete","id":"old","text":"ignored"}]}'),{notes:[{scope:'site',action:'delete',id:'old'}]});
  for(const bad of ['[]','{"notes":[],"extra":1}','{"notes":[{"scope":"tab","action":"write","id":"a","text":"b"}]}','{"notes":[{"scope":"site","action":"write","id":"bad id","text":"b"}]}',
    '{"notes":[{"scope":"site","action":"write","id":"a","text":""}]}','{"notes":[{"scope":"site","action":"write","id":"a","text":"b"},{"scope":"site","action":"delete","id":"a"}]}',
    JSON.stringify({notes:Array.from({length:5},(_,i)=>({scope:'site',action:'delete',id:'n'+i}))})])assert.throws(()=>P.parseReview(bad),/复盘结果格式无效/);
  assert.throws(()=>P.parseReview('{"notes":[{"scope":"site","action":"delete","id":"a"}]}',{site:false,global:true}),/没有网站长期记忆/);
});

test('review input keeps recent results, omits page text and caps note bodies',()=>{
  const long='x'.repeat(7000);
  const input=JSON.parse(P.reviewInput({origin:'https://a.test',goal:'g',instructions:[{text:'fix',time:1}],results:[{action:'observe',result:'PAGE TEXT'},{action:'fill',request:{reply:'r',value:'secret value'},outcome:{status:'success',code:'CONDITIONS_MATCH'}}]},
    {version:1,notes:[{id:'a',text:long},{id:'b',text:long},{id:'c',text:'short'}]},null));
  assert.deepEqual(input.instructions,['fix']);assert.ok(!JSON.stringify(input).includes('PAGE TEXT'));assert.ok(!JSON.stringify(input).includes('secret value'));
  assert.equal(input.siteNotes[1].text.length,7000);assert.equal(input.siteNotes.at(-1).text,'short');
  const big=JSON.parse(P.reviewInput({origin:'https://a.test',goal:'g'},{version:1,notes:[{id:'a',text:long},{id:'b',text:long},{id:'c',text:long}]},null));
  assert.deepEqual(big.siteNotes[2],{id:'c',text:null,omitted:true});assert.equal(big.globalNotes,null);
});
