const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createRuntime}=require('../extension/runtime.js');
const flush=()=>new Promise(r=>setImmediate(r));

// One page URL for every "page": a form POST that re-renders the same address (xauat 题库 3 → 4 页).
function fixture({goalMode=true,replies}={}){
 const data=new Map(),executed=[];let seq=0,calls=0,release=null,page=3;
 const store={async get(id){return structuredClone(data.get(id)||null);},async set(id,t){data.set(id,structuredClone(t));},async remove(id){data.delete(id);},async list(){return [...data.values()].map(t=>structuredClone(t));},async getMemory(){return [];},async setMemory(){},async removeMemory(){}};
 const url='https://exam.test/redir.php?cmd=dati&mode=test';
 const tools={async tab(id){return {id,url,status:'complete'};},
  async observe(){return {url,documentId:'doc'+page,snapshotId:'s'+page,page:{text:'第'+page+'页',elements:[{id:'t0',key:'next',label:'下一页',tag:'input',type:'submit'}],regions:[]}};},
  // The click submits the form; the content script never answers because the document is replaced.
  execute(id,p){executed.push(p);return new Promise(r=>{release=r;});}};
 const list=replies||[{reply:'第3页已选完，继续第4页。',action:'click',id:'t0'},{reply:'第4页',action:'done'}];
 const model=async()=>({text:JSON.stringify(list[Math.min(calls++,list.length-1)])});
 const deps={store,tools,model,summarize:async()=>({text:'{}'}),schedule:()=>{},cancelSchedule:async()=>{},uuid:()=>String(++seq),preferences:async()=>({maxSteps:50,contextTokens:32768})};
 return {deps,runtime:createRuntime(deps),executed,store,url,goalMode,nextPage(){page++;},release:()=>release?.({version:2,status:'unknown',dispatch:'unknown',code:'NAVIGATION',recovery:'observe'}),calls:()=>calls};
}

test('a same-URL form POST during a click ends it as DOCUMENT_CHANGED and the task continues on the new page',async()=>{
 for(const goalMode of [true,false]){
  const f=fixture({goalMode});
  await f.runtime.submit(1,'做完10页后交卷',{goalMode});
  const clicking=f.runtime.tick(1);
  for(let i=0;i<20&&!f.executed.length;i++)await flush();
  assert.equal(f.executed.length,1);
  assert.equal((await f.runtime.get(1)).phase,'executing');
  // chrome.tabs.onUpdated {status:'loading'} without a new URL, then the new document.
  f.nextPage();await f.runtime.navigationChanged(1,undefined);
  f.release();await clicking;
  let t=await f.runtime.get(1);
  assert.equal(t.phase,'observe');assert.notEqual(t.reason,'uncertain');assert.equal(t.status,'running');
  assert.equal(t.results.at(-1).outcome.code,'DOCUMENT_CHANGED');assert.equal(t.results.at(-1).action,'click');
  await f.runtime.tick(1);t=await f.runtime.get(1);
  assert.equal(f.calls(),2,'the next turn asks the model on the new page');assert.equal(f.executed.length,1,'the click is never replayed');
  assert.equal(t.status,'completed');
 }
});

test('an action interrupted in executing is re-read in goal mode and still pauses outside it',async()=>{
 for(const goalMode of [true,false]){
  const f=fixture({goalMode,replies:[{reply:'第4页',action:'done'}]});
  await f.runtime.submit(1,'做题',{goalMode});
  let t=await f.store.get(1);
  t.phase='executing';t.pending={plan:{reply:'下一页',action:'click',id:'t0'},url:f.url,documentId:'doc3',targetKey:'next',label:'下一页',operationId:'op1'};
  await f.store.set(1,t);
  const restarted=createRuntime(f.deps);await restarted.tick(1);
  t=await restarted.get(1);
  if(goalMode){
   assert.equal(t.status,'running');assert.equal(t.phase,'observe');assert.equal(t.recoveryCount,1);
   assert.equal(t.results.at(-1).outcome.code,'INTERRUPTED');assert.equal(t.results.at(-1).outcome.status,'unknown');
   await restarted.tick(1);t=await restarted.get(1);
   assert.equal(t.status,'completed');assert.equal(f.executed.length,0,'nothing replayed');
  }else{
   assert.equal(t.status,'paused');assert.equal(t.reason,'uncertain');assert.equal(f.executed.length,0);
  }
 }
});

test('goal-mode re-reads after interruption are bounded by the recovery cap',async()=>{
 const f=fixture({goalMode:true});
 await f.runtime.submit(1,'做题',{goalMode:true});
 let t=await f.store.get(1);t.recoveryCount=5;t.phase='executing';t.pending={plan:{reply:'下一页',action:'click',id:'t0'},url:f.url,documentId:'doc3',operationId:'op1'};await f.store.set(1,t);
 await createRuntime(f.deps).tick(1);
 t=await f.store.get(1);assert.equal(t.status,'paused');assert.equal(t.reason,'uncertain');
});
