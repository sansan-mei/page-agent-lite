const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createRuntime}=require('../extension/runtime.js');

function fixture(overrides={}){
 const data=new Map(),memories=new Map(),scheduled=[],executed=[];let seq=0,observed=0;
 const store={async get(id){return structuredClone(data.get(id)||null);},async set(id,t){data.set(id,structuredClone(t));},async remove(id){data.delete(id);},async list(){return [...data.values()].map(t=>structuredClone(t));},async getMemory(id,origin){return structuredClone(memories.get(id+origin)||[]);},async setMemory(id,origin,notes){memories.set(id+origin,structuredClone(notes));},async removeMemory(id){for(const key of memories.keys())if(key.startsWith(String(id)))memories.delete(key);}};
 const tools={async tab(id){return {id,url:'https://example.test/1',status:'complete'};},async observe(){observed++;return {url:'https://example.test/1',snapshotId:'snap'+observed,page:{text:'Question',elements:[{id:'t0',label:'Answer',tag:'input'}]}};},async execute(id,p){executed.push(p);return {version:2,status:'success',dispatch:'sent',scope:'ui',code:'CONDITIONS_MATCH',recovery:'none',message:'Matched'};},...overrides.tools};
 const deps={store,tools,summarize:async()=>({text:JSON.stringify({completed:['已核实的字段状态'],remaining:[],facts:[],failed:[],uncertain:[]})}),schedule:(id,delay)=>scheduled.push({id,delay}),cancelSchedule:async()=>{},uuid:()=>String(++seq),preferences:async()=>({maxSteps:50,contextTokens:32768}),model:async()=>({text:'{"reply":"完成","action":"done"}'}),...overrides,tools};
 return {data,store,tools,deps,scheduled,executed,runtime:createRuntime(deps)};
}

test('click and fill execute even when legacy task preferences disable automation',async()=>{
 for(const plan of [{reply:'Click',action:'click',id:'t0'},{reply:'Fill',action:'fill',id:'t0',value:'4'}]){
  const f=fixture({preferences:async()=>({maxSteps:50,autoFill:false,autoClick:false}),model:async()=>({text:JSON.stringify(plan)})});
  await f.runtime.start(1,'Work');await f.runtime.tick(1);
  assert.equal(f.executed.length,1);assert.equal((await f.runtime.get(1)).status,'running');
 }
});

test('resuming a legacy confirmation discards the old action and replans automatically',async()=>{
 const f=fixture({model:async()=>({text:'{"reply":"New click","action":"click","id":"t0"}'})});
 await f.runtime.start(1,'Work');const old=await f.runtime.get(1);
 old.status='waiting_confirmation';old.phase='confirm';old.pending={plan:{action:'click',id:'old-target'}};await f.store.set(1,old);
 await f.runtime.resume(1);assert.equal((await f.runtime.get(1)).pending,null);
 await f.runtime.tick(1);assert.equal(f.executed.length,1);assert.equal(f.executed[0].plan.id,'t0');
});

test('runtime automatically fills and clicks within one cumulative budget',async()=>{
 let calls=0;const f=fixture({model:async()=>({text:JSON.stringify(++calls===1?{reply:'Fill',action:'fill',id:'t0',value:'4'}:calls===2?{reply:'Click',action:'click',id:'t0'}:{reply:'Done',action:'done'})})});
 await f.runtime.start(1,'Work');await f.runtime.tick(1);await f.runtime.tick(1);
 assert.equal(f.executed.length,2);assert.equal((await f.runtime.get(1)).status,'running');
 await f.runtime.tick(1);const state=await f.runtime.get(1);assert.equal(state.status,'completed');assert.equal(state.steps,3);
});

test('stop aborts model and late results cannot write or execute, including after replacement',async()=>{
 let resolve,signal;const f=fixture({model:async(text,s)=>{signal=s;return new Promise(r=>resolve=r);}});
 await f.runtime.start(1,'旧目标');const tick=f.runtime.tick(1);
 while(!resolve)await new Promise(r=>setImmediate(r));
 await f.runtime.stop(1);assert.equal(signal.aborted,true);
 resolve({text:'{"reply":"填写","action":"fill","id":"t0","value":"bad"}'});await tick;
 assert.equal((await f.runtime.get(1)).status,'stopped');assert.equal(f.executed.length,0);
});

test('worker restart never replays ambiguous operations; thinking recovers with saved budget',async()=>{
 const f=fixture();await f.runtime.start(1,'任务');let t=await f.runtime.get(1);t.phase='executing';await f.store.set(1,t);
 const replacement=createRuntime(f.deps);await replacement.recover();await replacement.tick(1);
 assert.equal((await replacement.get(1)).reason,'uncertain');assert.equal(f.executed.length,0);
 t=await replacement.get(1);t.status='running';t.phase='thinking';t.steps=49;await f.store.set(1,t);
 await createRuntime(f.deps).tick(1);assert.equal((await f.runtime.get(1)).steps,50);
});

test('navigation invalidates legacy approval and cross-origin destination pauses task',async()=>{
 let url='https://example.test/1';const f=fixture({tools:{async tab(){return {url,status:'complete'};},async hasOriginAccess(origin){return origin==='https://example.test';}}});
 const t=await f.runtime.start(1,'Work');const old=await f.runtime.get(1);
 old.status='waiting_confirmation';old.phase='confirm';old.pending={url,plan:{action:'click',id:'old'}};await f.store.set(1,old);
 url='https://example.test/2';await f.runtime.approve(1,t.taskId);await f.runtime.tick(1);
 assert.equal(f.executed.length,0);assert.equal((await f.runtime.get(1)).phase,'observe');
 url='https://other.test/';await f.runtime.tick(1);assert.equal((await f.runtime.get(1)).reason,'permission_denied');
 await assert.rejects(()=>f.runtime.resume(1),/原站点/);
});

test('finite and unlimited budgets stay separate from bounded history',async()=>{
 const f=fixture({preferences:async()=>({maxSteps:0,autoFill:true}),model:async()=>({text:'{"reply":"填写","action":"fill","id":"t0","value":"4"}'})});
 await f.runtime.start(1,'长任务');for(let i=0;i<25;i++)await f.runtime.tick(1);
 let t=await f.runtime.get(1);assert.equal(t.steps,25);assert.equal(t.results.length,25);assert.equal(t.contextSummary,undefined);assert.equal(t.status,'running');
 t.prefs.maxSteps=25;await f.store.set(1,t);await f.runtime.tick(1);assert.equal((await f.runtime.get(1)).reason,'budget');
});

test('temporary API failures retry twice, unknown failures stop, no progress pauses',async()=>{
 const f=fixture({model:async()=>{throw new Error('API 网络连接失败');}});await f.runtime.start(1,'任务');
 await f.runtime.tick(1);await f.runtime.tick(1);await f.runtime.tick(1);assert.equal((await f.runtime.get(1)).status,'failed');
 const g=fixture({tools:{async execute(){return {version:2,status:'unknown',dispatch:'sent',scope:'dispatch',code:'NO_CHANGE',recovery:'observe',message:'Unchanged'};}},model:async()=>({text:'{"reply":"填写","action":"scroll","value":"down"}'})});
 await g.runtime.start(1,'任务');for(let i=0;i<3;i++)await g.runtime.tick(1);assert.equal((await g.runtime.get(1)).reason,'no_progress');
});

test('two tabs stay isolated, remove prevents late writes and removes task',async()=>{
 const f=fixture();await f.runtime.start(1,'一');await f.runtime.start(2,'二');await f.runtime.remove(1);
 assert.equal(await f.runtime.get(1),null);assert.equal((await f.runtime.get(2)).goal,'二');
});

test('stale target triggers fresh observation rather than repeating the action',async()=>{
 const f=fixture({tools:{async execute(){throw Object.assign(new Error('过期'),{code:'STALE'});}},model:async()=>({text:'{"reply":"填","action":"fill","id":"t0","value":"4"}'})});
 await f.runtime.start(1,'任务');await f.runtime.tick(1);assert.equal((await f.runtime.get(1)).phase,'observe');assert.equal((await f.runtime.get(1)).pending,null);
});

test('supplement interrupts old thinking, preserves task ID, goal, progress and passes new instructions',async()=>{
 let resolve,payload,signal;let calls=0;
 const f=fixture({model:async(text,s)=>{calls++;payload=JSON.parse(text);signal=s;if(calls===1)return new Promise(r=>resolve=r);return {text:'{"reply":"完成","action":"done"}'};}});
 const original=await f.runtime.submit(1,'处理作业');const tick=f.runtime.tick(1);
 while(!resolve)await new Promise(r=>setImmediate(r));
 const updated=await f.runtime.submit(1,'先处理第二题');assert.equal(signal.aborted,true);
 assert.equal(updated.taskId,original.taskId);assert.equal(updated.goal,'处理作业');assert.equal(updated.steps,1);
 resolve({text:'{"reply":"旧结果","action":"fill","id":"t0","value":"bad"}'});await tick;
 assert.equal(f.executed.length,0);await f.runtime.tick(1);
 assert.equal(payload.instructions[0].text,'先处理第二题');assert.equal((await f.runtime.get(1)).status,'completed');
 const followup=await f.runtime.submit(1,'新的工作');assert.equal(followup.taskId,original.taskId);assert.equal(followup.status,'running');assert.equal(followup.steps,0);assert.equal(followup.instructions.at(-1).text,'新的工作');
 await f.runtime.finish(1);const next=await f.runtime.submit(1,'另一项工作');assert.notEqual(next.taskId,original.taskId);assert.equal(next.goal,'另一项工作');assert.equal(next.steps,0);
});

test('a completed web task keeps the conversation: follow-ups see the previous answer until a new conversation',async()=>{
 let calls=0;const payloads=[];
 const f=fixture({model:async text=>{payloads.push(JSON.parse(text));return {text:JSON.stringify({reply:++calls===1?'ANSWER_ONE':'ANSWER_TWO',action:'done'})};}});
 const first=await f.runtime.submit(1,'Read the page');await f.runtime.tick(1);
 let t=await f.runtime.get(1);assert.equal(t.status,'completed');assert.equal(t.results.at(-1).result,'ANSWER_ONE');
 assert.equal((await f.runtime.setGoalMode(1,first.taskId,true)).goalMode,true);
 t=await f.runtime.submit(1,'And then?');assert.equal(t.taskId,first.taskId);assert.equal(t.goal,'Read the page');
 await f.runtime.tick(1);
 assert.ok(payloads[1].results.some(r=>r.result==='ANSWER_ONE'));assert.equal(payloads[1].instructions.at(-1).text,'And then?');assert.equal(payloads[1].goalMode,true);
 assert.equal((await f.runtime.get(1)).status,'completed');
 await f.runtime.finish(1);await assert.rejects(()=>f.runtime.setGoalMode(1,first.taskId,false),/任务已变化/);
 assert.notEqual((await f.runtime.submit(1,'Fresh')).taskId,first.taskId);
});

test('stopped, paused, failed and pending tasks all receive followups; explicit finish starts new identity',async()=>{
 const f=fixture();const original=await f.runtime.submit(1,'目标');
 for(const status of ['stopped','paused','failed','waiting_confirmation']){
  const t=await f.runtime.get(1);t.status=status;t.steps=4;t.pending={old:true};t.results=[{result:'已有进度'}];await f.store.set(1,t);
  const updated=await f.runtime.submit(1,'补充 '+status);
  assert.equal(updated.taskId,original.taskId);assert.equal(updated.steps,4);assert.equal(updated.pending,null);assert.equal(updated.results[0].result,'已有进度');
 }
 const ended=await f.runtime.finish(1);assert.equal(ended.status,'ended');
 await assert.rejects(()=>f.runtime.resume(1),/手动结束/);
 assert.notEqual((await f.runtime.submit(1,'下一项')).taskId,original.taskId);
});

test('concurrent submissions serialize into one task with chronological followups',async()=>{
 const f=fixture();const tasks=await Promise.all([f.runtime.submit(1,'原目标'),f.runtime.submit(1,'补充一'),f.runtime.submit(1,'补充二')]);
 assert.ok(tasks.every(t=>t.taskId===tasks[0].taskId));
 assert.deepEqual((await f.runtime.get(1)).instructions.map(x=>x.text),['补充一','补充二']);
});

test('failed field verification pauses instead of claiming answer was applied',async()=>{
 const f=fixture({tools:{async execute(){return {message:'字段未生效',verification:{verified:false,actual:false}};}},model:async()=>({text:'{"reply":"选择对","action":"check","id":"t0","value":true}'})});
 await f.runtime.start(1,'改为对');await f.runtime.tick(1);
 const t=await f.runtime.get(1);assert.equal(t.status,'paused');assert.equal(t.reason,'verification');assert.equal(t.results[0].verification.verified,false);
});

test('model reporting incomplete work pauses and preserves task identity for followups',async()=>{
 const f=fixture({model:async()=>({text:'{"reply":"仍有错题，请提供回顾页面","action":"pause","pauseReason":"user"}'})});
 const first=await f.runtime.submit(1,'订正所有错题');await f.runtime.tick(1);
 const task=await f.runtime.get(1);assert.equal(task.status,'paused');assert.equal(task.reason,'model');
 assert.equal((await f.runtime.submit(1,'已经打开回顾，继续')).taskId,first.taskId);
});

test('busy document waits then observes fresh state without replaying a pending action',async()=>{
 const f=fixture({tools:{async execute(){throw Object.assign(new Error('尚在操作'),{code:'PAGE_BUSY'});}},model:async()=>({text:'{"reply":"填写","action":"fill","id":"t0","value":"4"}'})});
 await f.runtime.submit(1,'任务');await f.runtime.tick(1);
 const task=await f.runtime.get(1);assert.equal(task.status,'waiting_page');assert.equal(task.pending,null);assert.equal(task.phase,'verifying');
});

test('delayed expected result waits without more model calls or another click, including worker recovery',async()=>{
 let clock=1000,matched=false,calls=0;
 const f=fixture({now:()=>clock,preferences:async()=>({maxSteps:50,autoFill:true,autoClick:true}),
  tools:{async execute(){return {version:2,status:'unknown',dispatch:'sent',scope:'dispatch',code:'PAGE_CHANGED',recovery:'wait'};},async verify(){return {version:2,status:matched?'success':'not_satisfied',dispatch:'not_sent',scope:'page',code:'CONDITIONS_UNMET',recovery:'wait'};}},
  model:async()=>{calls++;return {text:'{"reply":"保存","action":"click","id":"t0","expected":[{"kind":"url_changed"}],"timeoutMs":1000}'};}});
 await f.runtime.submit(1,'保存');await f.runtime.tick(1);const saved=await f.runtime.get(1);assert.equal(saved.check.deadline,2000);
 clock=1400;await f.runtime.tick(1);assert.equal(calls,1);
 const fresh=createRuntime(f.deps);await fresh.recover();clock=1800;matched=true;await fresh.tick(1);
 const t=await fresh.get(1);assert.equal(t.status,'running');assert.equal(t.check,null);assert.equal(t.steps,1);assert.equal(calls,1);
});

test('unmet completion is paused and cannot be labeled completed',async()=>{
 const f=fixture({tools:{async verify(){return {version:2,status:'not_satisfied',dispatch:'not_sent',scope:'page',code:'CONDITIONS_UNMET',recovery:'pause'};}},
  model:async()=>({text:'{"reply":"已保存","action":"done","expected":[{"kind":"field_equals","id":"t0","value":"Alice"}]}'})});
 await f.runtime.submit(1,'保存');await f.runtime.tick(1);
 const t=await f.runtime.get(1);assert.equal(t.status,'paused');assert.equal(t.lastOutcome.status,'not_satisfied');assert.equal(t.completionEvidence,undefined);
});

test('verified completion preserves its answer for the next turn without repeating the old conditions',async()=>{
 const payloads=[];
 const f=fixture({tools:{async verify(){return {version:2,status:'success',dispatch:'not_sent',scope:'page',code:'CONDITIONS_MATCH'};}},
  model:async text=>{payloads.push(JSON.parse(text));return {text:JSON.stringify(payloads.length===1?{reply:'VERIFIED_ANSWER',action:'done',expected:[{kind:'field_equals',id:'t0',value:'Alice'}]}:{reply:'FOLLOWUP_ANSWER',action:'done'})};}});
 await f.runtime.submit(1,'Save');await f.runtime.tick(1);
 const completed=await f.runtime.get(1);assert.equal(completed.completionEvidence,'verified');assert.equal(completed.results.at(-1).result,'VERIFIED_ANSWER');
 await f.runtime.submit(1,'Explain');await f.runtime.tick(1);
 assert.ok(payloads[1].results.some(r=>r.result==='VERIFIED_ANSWER'));
 const final=await f.runtime.get(1);assert.equal(final.taskId,completed.taskId);assert.equal(final.completionEvidence,'model_reported');assert.equal(final.steps,1);assert.equal(f.executed.length,0);
});

test('wait deadline survives restart and a loading page cannot extend it indefinitely',async()=>{
 let clock=0,loading=false;
 const f=fixture({now:()=>clock,tools:{async tab(){return {url:'https://example.test/1',status:loading?'loading':'complete'};},async verify(){return {version:2,status:'not_satisfied',dispatch:'not_sent',scope:'page',code:'CONDITIONS_UNMET'};}},
  model:async()=>({text:'{"reply":"等待","action":"wait","expected":[{"kind":"url_changed"}],"timeoutMs":1000}'})});
 await f.runtime.submit(1,'任务');await f.runtime.tick(1);assert.equal((await f.runtime.get(1)).check.deadline,1000);
 loading=true;clock=500;await createRuntime(f.deps).tick(1);assert.equal((await f.runtime.get(1)).check.deadline,1000);
 clock=1001;await createRuntime(f.deps).tick(1);assert.equal((await f.runtime.get(1)).status,'paused');assert.equal((await f.runtime.get(1)).reason,'timeout');
});

test('stop and followup invalidate persisted checks; stale recovery is bounded',async()=>{
 const f=fixture({tools:{async verify(){return {version:2,status:'unknown',code:'CONDITIONS_UNMET'};}},model:async()=>({text:'{"reply":"等待","action":"wait","expected":[{"kind":"url_changed"}]}'})});
 await f.runtime.submit(1,'等待');await f.runtime.tick(1);await f.runtime.stop(1);assert.equal((await f.runtime.get(1)).check,null);
 await f.runtime.submit(1,'补充');await f.runtime.tick(1);await f.runtime.submit(1,'再次补充');assert.equal((await f.runtime.get(1)).check,null);
 const g=fixture({tools:{async execute(){throw Object.assign(new Error('old'),{code:'STALE'});}},model:async()=>({text:'{"reply":"填","action":"fill","id":"t0","value":"4"}'})});
 await g.runtime.submit(1,'任务');for(let i=0;i<3;i++)await g.runtime.tick(1);assert.equal((await g.runtime.get(1)).reason,'recovery');
});

test('executing checkpoint recovery only verifies, never dispatches a saved action',async()=>{
 const f=fixture({tools:{async verify(){return {version:2,status:'success',code:'CONDITIONS_MATCH'};}}});
 await f.runtime.submit(1,'任务');const t=await f.runtime.get(1);t.phase='executing';t.check={operationId:'op',expected:[{kind:'url_changed',beforeURL:'https://example.test/old'}],deadline:Date.now()+10000,kind:'action'};await f.store.set(1,t);
 await createRuntime(f.deps).tick(1);assert.equal(f.executed.length,0);assert.equal((await f.runtime.get(1)).check,null);assert.equal((await f.runtime.get(1)).status,'running');
});



function oldHistory(){return Array.from({length:13},(_,i)=>({action:'click',label:'action-'+i,result:'历史结果 '+i+(i<7?'x'.repeat(25000):'')}));}
const summaryText=JSON.stringify({completed:['页面已打开（页面证据）'],remaining:['核实保存'],facts:['按用户最新纠正处理'],failed:['旧方法无效'],uncertain:['保存回执未知，不重复提交']});

test('compaction saves summary before trimming, preserves instructions and recent results across recovery',async()=>{
 let input,executionInput;
 const f=fixture({summarize:async text=>{input=JSON.parse(text);return {text:summaryText};},model:async text=>{executionInput=JSON.parse(text);return {text:'{"reply":"检查","action":"observe"}'};}});
 await f.runtime.start(1,'通用任务');await f.runtime.submit(1,'用户纠正不能丢');
 let t=await f.runtime.get(1);t.results=oldHistory();t.lastOutcome={version:2,status:'unknown',code:'REPLY_LOST'};await f.store.set(1,t);
 await f.runtime.tick(1);t=await f.runtime.get(1);
 assert.equal(input.olderResults.length,7);assert.deepEqual(t.results,oldHistory().slice(-6));assert.equal(t.contextSummary.through,7);assert.equal(t.steps,1);assert.equal(t.instructions[0].text,'用户纠正不能丢');assert.equal(f.executed.length,0);
 await createRuntime(f.deps).tick(1);
 assert.equal(executionInput.taskSummary.uncertain[0],'保存回执未知，不重复提交');assert.equal(executionInput.results.length,6);assert.equal(executionInput.lastOutcome.code,'REPLY_LOST');
 t=await f.runtime.get(1);t.results=oldHistory();await f.store.set(1,t);await f.runtime.tick(1);
 assert.equal(input.previousSummary.facts[0],'按用户最新纠正处理');assert.equal((await f.runtime.get(1)).contextSummary.through,14);
});

test('invalid or failed summary never discards history and can be retried',async()=>{
 for(const summarize of [async()=>({text:'{"action":"done"}'}),async()=>{throw new Error('API timeout');}]){
  const f=fixture({summarize});await f.runtime.start(1,'任务');let t=await f.runtime.get(1);t.results=oldHistory();await f.store.set(1,t);
  await f.runtime.tick(1);t=await f.runtime.get(1);assert.equal(t.reason,'context');assert.deepEqual(t.results,oldHistory());assert.equal(t.contextSummary,undefined);assert.equal(f.executed.length,0);
 }
});

test('stopping or adding instructions cancels late compaction without overwriting history',async()=>{
 for(const action of ['stop','submit']){
  let resolve,signal;const f=fixture({summarize:async(text,s)=>{signal=s;return new Promise(r=>resolve=r);}});
  await f.runtime.start(1,'任务');let t=await f.runtime.get(1);t.results=oldHistory();await f.store.set(1,t);
  const job=f.runtime.tick(1);while(!resolve)await new Promise(r=>setImmediate(r));
  if(action==='stop')await f.runtime.stop(1);else await f.runtime.submit(1,'新纠正');
  assert.equal(signal.aborted,true);resolve({text:summaryText});await job;t=await f.runtime.get(1);assert.deepEqual(t.results,oldHistory());assert.equal(t.contextSummary,undefined);
 }
});

test('configured input character limit bounds new tasks and supplements; default stays 2000',async()=>{
 const d=fixture();await assert.rejects(()=>d.runtime.start(1,'长'.repeat(2001)),/2000/);await assert.rejects(()=>d.runtime.submit(1,'长'.repeat(2001)),/2000/);
 await d.runtime.submit(1,'长'.repeat(2000));assert.equal((await d.runtime.get(1)).goal.length,2000);
 const f=fixture({preferences:async()=>({maxSteps:50,contextTokens:32768,inputChars:10000})});
 await assert.rejects(()=>f.runtime.submit(1,'长'.repeat(10001)),/10000/);assert.equal(await f.runtime.get(1),null);
 await f.runtime.submit(1,'长'.repeat(10000));assert.equal((await f.runtime.get(1)).goal.length,10000);
 for(let i=0;i<5;i++)await f.runtime.submit(1,'补'.repeat(10000));
 const t=await f.runtime.get(1);assert.equal(t.instructions.length,5);
 await assert.rejects(()=>f.runtime.submit(1,'补'.repeat(10000)),/上限/);assert.deepEqual((await f.runtime.get(1)).instructions,t.instructions);
});

test('supplemental instructions are retained or rejected explicitly rather than silently trimmed',async()=>{
 const f=fixture();await f.runtime.start(1,'任务');for(let i=0;i<15;i++)await f.runtime.submit(1,'纠正'+i);
 let t=await f.runtime.get(1);assert.equal(t.instructions.length,15);
 for(let i=0;i<5;i++)await f.runtime.submit(1,'长'.repeat(2000));
 t=await f.runtime.get(1);await assert.rejects(()=>f.runtime.submit(1,'长'.repeat(2000)),/上限/);assert.deepEqual((await f.runtime.get(1)).instructions,t.instructions);
});


test('usable DOM verifies navigation while subresources keep tab loading, without replay',async()=>{
 let clock=0,loading=false,url='https://example.test/1',calls=0;
 const f=fixture({now:()=>clock,preferences:async()=>({maxSteps:50,autoClick:true}),
  tools:{async tab(){return {url,status:loading?'loading':'complete'};},
   async observe(){return {url,readyState:'interactive',documentId:'doc',snapshotId:'snap',page:{elements:[{id:'t0',label:'Next'}]}};},
   async execute(){loading=true;url='https://example.test/2';return {navigation:true};}},
  model:async()=>{calls++;return {text:JSON.stringify({reply:'Next',action:'click',id:'t0',expected:[{kind:'url_changed'}],timeoutMs:1000})};}});
 await f.runtime.start(1,'Navigate');await f.runtime.tick(1);
 // Even the deadline tick must inspect available evidence before declaring failure.
 clock=1001;await createRuntime(f.deps).tick(1);
 const t=await f.runtime.get(1);assert.equal(t.status,'running');assert.equal(t.check,null);assert.equal(calls,1);assert.equal(t.metrics.actions,1);
 assert.deepEqual(t.lastOutcome.evidence[0].expected,{differentFrom:'https://example.test/1'});
});

test('old DOM during pending navigation cannot bypass loading timeout',async()=>{
 let clock=0;
 const f=fixture({now:()=>clock,tools:{async tab(){return {url:'https://example.test/1',pendingUrl:'https://example.test/2',status:'loading'};},
 async observe(){return {url:'https://example.test/1',readyState:'complete',page:{elements:[]}};}}});
 await f.runtime.start(1,'Wait');await f.runtime.tick(1);clock=30001;await f.runtime.tick(1);
 assert.equal((await f.runtime.get(1)).reason,'timeout');assert.equal((await f.runtime.get(1)).steps,0);
});


test('cached usage anchors pressure without counting cached tokens as free capacity, model changes invalidate anchor',async()=>{
 const P=require('../extension/prompts.js');const task={prefs:{contextTokens:32768,compressionThreshold:80}};
 const initial=P.pressure(task,'{}','one');task.contextUsage={promptTokens:26000,cachedTokens:25000,estimatedTokens:initial.estimatedTokens,modelIdentity:'one'};
 const anchored=P.pressure(task,'{}','one');assert.equal(anchored.tokens,26000);assert.equal(anchored.source,'api_plus_estimate');assert.ok(anchored.tokens>anchored.trigger);
 assert.equal(P.pressure(task,'{}','two').source,'estimate');
 let seen;const f=fixture({identity:async()=> 'one',model:async()=>({text:'{"reply":"read","action":"observe"}',usage:{promptTokens:26000,cachedTokens:25000},modelIdentity:'one'}),summarize:async text=>{seen=JSON.parse(text);return {text:summaryText};}});
 await f.runtime.start(1,'任务');let t=await f.runtime.get(1);t.results=Array.from({length:20},()=>({action:'observe',result:'small'}));await f.store.set(1,t);
 await f.runtime.tick(1);assert.equal((await f.runtime.get(1)).contextSummary,undefined);
 await f.runtime.tick(1);assert.ok(seen);assert.equal((await f.runtime.get(1)).contextUsage,null);
});

test('archive can be recovered in bounded pages and disappears with task clear',async()=>{
 const f=fixture({model:async()=>({text:'{"reply":"recover","action":"history_read","id":"h1","value":4000}'})});
 await f.runtime.start(1,'任务');let t=await f.runtime.get(1);t.results=oldHistory();await f.store.set(1,t);await f.runtime.tick(1);
 t=await f.runtime.get(1);assert.deepEqual(t.contextArchive[0].results,oldHistory().slice(0,7));
 await f.runtime.tick(1);t=await f.runtime.get(1);const read=t.results.at(-1).result;
 assert.equal(read.text.length,4000);assert.equal(read.nextOffset,8000);assert.equal(f.executed.length,0);
 await f.runtime.remove(1);assert.equal(await f.runtime.get(1),null);
});

test('stable task prefix survives appending results and volatile snapshot changes',()=>{
 const P=require('../extension/prompts.js');const t={goal:'task',results:[{action:'observe',result:'one'}],steps:1};
 const first=P.agentInput(t,{text:'old'});t.results.push({action:'observe',result:'two'});t.steps++;
 const second=P.agentInput(t,{text:'new'});const prefix=first.slice(0,first.indexOf('],"siteMemoryIndex"'));
 assert.ok(second.startsWith(prefix));
});

test('oversized protected context pauses without repeated summary requests',async()=>{
 let summaries=0;const f=fixture({tools:{async observe(){return {url:'https://example.test/1',page:{text:'中'.repeat(26000),elements:[]}};}},summarize:async()=>{summaries++;return {text:summaryText};}});
 await f.runtime.start(1,'任务');let t=await f.runtime.get(1);t.results=oldHistory();await f.store.set(1,t);
 await f.runtime.tick(1);await f.runtime.tick(1);assert.equal((await f.runtime.get(1)).reason,'context');assert.equal(summaries,1);assert.equal(f.executed.length,0);
});


function durableFixture(){
 const data=new Map();return {async read(origin){return structuredClone(data.get(origin)||{origin,version:0,notes:[]});},async change(origin,p){
  if(p.signal?.aborted)throw new Error('cancelled');const old=await this.read(origin);if(old.version!==p.expectedVersion)throw Object.assign(new Error('conflict'),{code:'MEMORY_CONFLICT'});
  const notes=old.notes.filter(n=>p.action==='clear'?false:n.id!==p.id);if(p.action==='write')notes.push({id:p.id,text:p.text,source:p.source,updatedAt:1});const next={origin,notes,version:old.version+1};data.set(origin,next);return structuredClone(next);
 }};
}

test('durable notes share exact origin across tabs and tasks, index omits bodies and read is explicit',async()=>{
 const siteMemory=durableFixture();let payload,calls=0;
 const f=fixture({siteMemory,model:async text=>{payload=JSON.parse(text);return {text:JSON.stringify(++calls===1?{reply:'save',action:'site_memory_write',id:'workflow',value:'verified site procedure'}:calls===2?{reply:'read',action:'site_memory_read',id:'workflow'}:{reply:'done',action:'done'})};}});
 await f.runtime.start(1,'任务');await f.runtime.tick(1);assert.equal((await f.runtime.getSiteMemory(1)).notes[0].text,'verified site procedure');
 await f.runtime.finish(1);await f.runtime.start(2,'another task');await f.runtime.tick(2);
 assert.deepEqual(payload.siteMemoryIndex,[{id:'workflow',updatedAt:1,source:'model'}]);assert.ok(!JSON.stringify(payload).includes('verified site procedure'));
 assert.equal((await f.runtime.get(2)).results.at(-1).result.note.text,'verified site procedure');
 await f.runtime.remove(1);assert.equal((await siteMemory.read('https://example.test')).notes.length,1);
 assert.equal((await siteMemory.read('https://sub.example.test')).notes.length,0);
});

test('manual durable edit invalidates all same-origin tasks and blocks late writes',async()=>{
 let resolve,signal;const siteMemory=durableFixture(),f=fixture({siteMemory,model:async(text,s)=>{signal=s;return new Promise(r=>resolve=r);}});
 await f.runtime.start(1,'任务');await f.runtime.start(2,'第二任务');const job=f.runtime.tick(1);while(!resolve)await new Promise(r=>setImmediate(r));
 const edited=await f.runtime.editSiteMemory(2,{origin:'https://example.test',action:'write',id:'workflow',text:'user correction',expectedVersion:0});assert.equal(edited.version,1);assert.equal(signal.aborted,true);
 resolve({text:'{"reply":"save","action":"site_memory_write","id":"workflow","value":"stale model"}'});await job;
 assert.equal((await f.runtime.get(1)).status,'paused');assert.equal((await f.runtime.get(2)).status,'paused');assert.equal((await siteMemory.read('https://example.test')).notes[0].text,'user correction');
});

test('concurrent durable update discards model actions planned against stale memory',async()=>{
 let resolve;const siteMemory=durableFixture(),f=fixture({siteMemory,preferences:async()=>({autoClick:true,maxSteps:50}),model:async()=>new Promise(r=>resolve=r)});
 await f.runtime.start(1,'任务');const job=f.runtime.tick(1);while(!resolve)await new Promise(r=>setImmediate(r));
 await siteMemory.change('https://example.test',{action:'clear',expectedVersion:0});resolve({text:'{"reply":"click","action":"click","id":"t0"}'});await job;
 assert.equal(f.executed.length,0);assert.equal((await f.runtime.get(1)).phase,'observe');
});


test('manual durable edits reject origin changes instead of writing another website',async()=>{
 const siteMemory=durableFixture(),f=fixture({siteMemory});
 await assert.rejects(()=>f.runtime.editSiteMemory(1,{origin:'https://other.test',action:'write',id:'note',text:'x',expectedVersion:0}),/网页已切换/);
 assert.equal((await siteMemory.read('https://example.test')).notes.length,0);
});


test('unknown click expectation rereads current dialog, never requires manual continue or replays original',async()=>{
 let clock=0,dialog=false,calls=0;const clicks=[];
 const f=fixture({now:()=>clock,preferences:async()=>({maxSteps:50,autoClick:true}),tools:{
 async observe(){return {url:'https://example.test/1',documentId:'doc',snapshotId:'snap',page:{elements:[{id:'t0',key:'open',label:'Submit'},{id:'t1',key:'confirm',label:'Confirm'}],regions:dialog?[{id:'r0',role:'dialog',label:'Confirm changes'}]:[]}};},
 async execute(id,p){clicks.push(p.plan.id);dialog=true;return {version:2,status:'unknown',dispatch:'sent',scope:'page',code:'CONDITIONS_UNMET'};},
 async verify(){return {version:2,status:'unknown',scope:'page',code:'CONDITIONS_UNMET',evidence:[{kind:'element_visible',matched:null,code:'TARGET_MISSING'}]};}},
 model:async text=>{calls++;const data=JSON.parse(text);return {text:JSON.stringify(calls===1?{reply:'Submit',action:'click',id:'t0',expected:[{kind:'element_visible',id:'t0'}],timeoutMs:100}: {reply:'Confirm',action:'click',id:'t1'})};}});
 await f.runtime.start(1,'Submit');await f.runtime.tick(1);clock=101;await createRuntime(f.deps).tick(1);
 let t=await f.runtime.get(1);assert.equal(t.status,'running');assert.equal(t.lastOutcome.recovery,'replan');assert.equal(t.lastOutcome.status,'unknown');
 await f.runtime.tick(1);assert.deepEqual(clicks,['t0','t1']);assert.equal(calls,2);
});

test('replanning cannot repeat uncertain click on original document, even after worker restart',async()=>{
 let clock=0,count=0;const f=fixture({now:()=>clock,preferences:async()=>({maxSteps:50,autoClick:true}),tools:{
 async observe(){return {url:'https://example.test/1',documentId:'doc',page:{elements:[{id:'t0',key:'save',label:'Save'}]}};},
 async execute(){count++;return {version:2,status:'unknown',dispatch:'sent',code:'CONDITIONS_UNMET'};},
 async verify(){return {version:2,status:'unknown',code:'CONDITIONS_UNMET'};}},
 model:async()=>({text:JSON.stringify({reply:'Save',action:'click',id:'t0',expected:[{kind:'element_visible',id:'t0'}],timeoutMs:100})})});
 await f.runtime.start(1,'Save');await f.runtime.tick(1);clock=101;await f.runtime.tick(1);await createRuntime(f.deps).tick(1);
 assert.equal(count,1);assert.equal((await f.runtime.get(1)).reason,'uncertain');
});

test('correction review persists across unrelated steps, clears only after a successful note write',async()=>{
 const siteMemory=durableFixture();let calls=0,payload;
 const f=fixture({siteMemory,model:async text=>{payload=JSON.parse(text);return {text:JSON.stringify(++calls===1?{reply:'Inspect',action:'observe'}:{reply:'Save correction',action:'site_memory_write',id:'workflow',value:'User correction: inspect confirmation before expecting navigation; not yet verified.'})};}});
 await f.runtime.start(1,'Work');await f.runtime.submit(1,'Remember to inspect the confirmation');await f.runtime.tick(1);
 assert.equal(payload.memoryReview.pending,true);assert.equal((await f.runtime.get(1)).memoryReview.pending,true);
 await f.runtime.tick(1);assert.equal((await f.runtime.get(1)).memoryReview,null);
 assert.match((await siteMemory.read('https://example.test')).notes[0].text,/User correction/);
});


test('blocked click replans with current page evidence, bounded retries never claim dispatch',async()=>{
 const T=require('../extension/tool-protocol.js');let attempts=0;
 const f=fixture({preferences:async()=>({maxSteps:50,autoClick:true}),tools:{async execute(){attempts++;const error=Object.assign(new Error('Covered'),{code:'TARGET_BLOCKED'});error.result=T.failure(error);throw error;}},model:async()=>({text:JSON.stringify({reply:'Save',action:'click',id:'t0'})})});
 await f.runtime.start(1,'Save');const id=(await f.runtime.get(1)).taskId;
 await f.runtime.tick(1);assert.equal((await f.runtime.get(1)).phase,'observe');assert.equal((await f.runtime.get(1)).lastOutcome.dispatch,'not_sent');
 await f.runtime.tick(1);await f.runtime.tick(1);
 const task=await f.runtime.get(1);assert.equal(task.status,'paused');assert.equal(task.reason,'recovery');assert.equal(task.taskId,id);assert.equal(attempts,3);
});


test('tool requests survive success and errors with canonical dispatch outcomes',async()=>{
 const plan={reply:'Fill',action:'fill',id:'t0',value:'4'};
 for(const fails of [false,true]){
  const f=fixture({model:async()=>({text:JSON.stringify(plan)}),...(fails?{tools:{async execute(){throw Object.assign(new Error('Covered'),{code:'TARGET_BLOCKED'});}}}:{})});
  await f.runtime.start(1,'Work');await f.runtime.tick(1);
  const t=await f.runtime.get(1),record=t.results.at(-1);
  assert.deepEqual(record.request,plan);assert.equal(typeof record.time,'number');
  assert.equal(record.outcome.code,fails?'TARGET_BLOCKED':'CONDITIONS_MATCH');
  if(fails)assert.equal(record.outcome.dispatch,'not_sent');
 }
});

test('tool request checkpoint is visible while executing and stop drops late return',async()=>{
 let resolve;const f=fixture({model:async()=>({text:'{"reply":"Click","action":"click","id":"t0"}'}),tools:{async execute(){return new Promise(r=>resolve=r);}}});
 await f.runtime.start(1,'Work');const job=f.runtime.tick(1);while(!resolve)await new Promise(r=>setImmediate(r));
 const running=await f.runtime.get(1);assert.equal(running.pending.plan.action,'click');assert.equal(typeof running.pending.time,'number');
 await f.runtime.stop(1);const stopped=await f.runtime.get(1);resolve({status:'success'});await job;
 assert.deepEqual(await f.runtime.get(1),stopped);assert.equal(stopped.results.length,0);
});


test('explicit verification records its actual request with returned evidence',async()=>{
 const plan={reply:'Verify',action:'verify',expected:[{kind:'url_equals',value:'https://example.test/1'}]};
 const f=fixture({model:async()=>({text:JSON.stringify(plan)})});await f.runtime.start(1,'Work');await f.runtime.tick(1);
 const record=(await f.runtime.get(1)).results.at(-1);assert.deepEqual(record.request,plan);assert.equal(record.outcome.status,'success');assert.equal(typeof record.time,'number');
});

test('blocked model pauses get three replans but essential user decisions pause immediately',async()=>{
 const f=fixture({model:async()=>({text:JSON.stringify({action:'pause',reply:'入口尚未找到'})})});await f.runtime.start(1,'查找');
 for(let i=0;i<3;i++){await f.runtime.tick(1);assert.equal(f.data.get(1).status,'running');}
 await f.runtime.tick(1);assert.equal(f.data.get(1).status,'paused');assert.equal(f.data.get(1).helpAttempts,3);
 const g=fixture({model:async()=>({text:JSON.stringify({action:'pause',pauseReason:'user',reply:'需要提供账号信息'})})});await g.runtime.start(1,'查找');await g.runtime.tick(1);assert.equal(g.data.get(1).status,'paused');
});
test('choice submissions reject stale questions and origins, resume with selected labels only',async()=>{
 const f=fixture({model:async()=>({text:JSON.stringify({action:'pause',reply:'选择输出内容',choices:['摘要','明细','建议']})})});await f.runtime.start(1,'整理');await f.runtime.tick(1);
 const t=f.data.get(1),q=t.question;assert.equal(t.reason,'question');
 await assert.rejects(()=>f.runtime.choose(1,t.taskId,'old',[0]));await assert.rejects(()=>f.runtime.choose(1,t.taskId,q.id,[5]));await assert.rejects(()=>f.runtime.choose(1,t.taskId,q.id,[0,0]));
 await f.runtime.choose(1,t.taskId,q.id,[0,2]);assert.equal(f.data.get(1).status,'running');assert.match(f.data.get(1).instructions.at(-1).text,/摘要；建议/);assert.equal(f.executed.length,0);
 await assert.rejects(()=>f.runtime.choose(1,t.taskId,q.id,[1]));
});
test('important click records notice without waiting for approval',async()=>{
 const f=fixture({model:async()=>({text:JSON.stringify({action:'click',id:'t0',reply:'继续',notice:'即将提交表单'})})});await f.runtime.start(1,'处理');await f.runtime.tick(1);
 assert.equal(f.executed.length,1);assert.equal(f.data.get(1).notice,'即将提交表单');assert.notEqual(f.data.get(1).status,'waiting_confirmation');
});


test('pure delay survives worker recovery, then observes fresh page before next action',async()=>{
 let clock=1000,calls=0,reads=0;
 const f=fixture({now:()=>clock,tools:{async observe(){reads++;return {url:'https://example.test/1',snapshotId:'s'+reads,page:{elements:[{id:'t0',label:'Next',tag:'button'}]}};},async verify(){throw new Error('Delay must not verify page conditions');}},model:async()=>({text:JSON.stringify(++calls===1?{reply:'等待15秒',action:'wait',timeoutMs:15000}:{reply:'下一步',action:'click',id:'t0'})})});
 await f.runtime.start(1,'重复切换');await f.runtime.tick(1);
 assert.equal((await f.runtime.get(1)).check.deadline,16000);
 const fresh=createRuntime(f.deps);await fresh.recover();clock=15000;await fresh.tick(1);
 assert.equal((await fresh.get(1)).check.deadline,16000);assert.equal(calls,1);assert.equal(reads,1);
 clock=17000;await fresh.tick(1);
 let t=await fresh.get(1);assert.equal(t.status,'running');assert.equal(t.check,null);assert.equal(t.steps,1);
 assert.equal(t.results.at(-1).outcome.code,'DELAY_ELAPSED');assert.equal(f.executed.length,0);
 await fresh.tick(1);assert.equal(reads,2);assert.equal(calls,2);assert.equal(f.executed.length,1);
});

test('stop and supplemental instructions invalidate pure delay without late continuation',async()=>{
 for(const action of ['stop','supplement']){
  let clock=0,calls=0;
  const f=fixture({now:()=>clock,model:async()=>{calls++;return {text:JSON.stringify({reply:'等待',action:'wait',timeoutMs:15000})};}});
  await f.runtime.start(1,'等待');await f.runtime.tick(1);
  if(action==='stop')await f.runtime.stop(1);else await f.runtime.submit(1,'改为先检查');
  assert.equal((await f.runtime.get(1)).check,null);
  clock=20000;
  if(action==='stop'){await createRuntime(f.deps).tick(1);assert.equal(calls,1);assert.equal((await f.runtime.get(1)).status,'stopped');}
  assert.equal(f.executed.length,0);assert.equal((await f.runtime.get(1)).results.some(r=>r.outcome?.code==='DELAY_ELAPSED'),false);
 }
});

test('pure delay respects origin boundary even after its deadline',async()=>{
 let clock=0,url='https://example.test/1';
 const f=fixture({now:()=>clock,tools:{async tab(){return {url,status:'complete'};}},model:async()=>({text:JSON.stringify({reply:'等待',action:'wait',timeoutMs:1000})})});
 await f.runtime.start(1,'等待');await f.runtime.tick(1);url='https://other.test/';clock=2000;
 await createRuntime(f.deps).tick(1);assert.equal((await f.runtime.get(1)).reason,'origin_verification');assert.equal(f.executed.length,0);
});

test('delay requires a bounded duration and verify still requires conditions',()=>{
 const C=require('../extension/core.js'),snap={nodes:new Map()};
 for(const plan of [{action:'wait'},{action:'wait',timeoutMs:0},{action:'wait',timeoutMs:30001},{action:'wait',timeoutMs:'15000'},{action:'verify'}])assert.throws(()=>C.agentPlan(JSON.stringify({reply:'等待',...plan}),snap));
 assert.equal(C.agentPlan(JSON.stringify({reply:'等待',action:'wait',timeoutMs:15000}),snap).timeoutMs,15000);
});


test('global notes are shared across origins with explicit reads and independent site notes',async()=>{
 const globalMemory=durableFixture(),siteMemory=durableFixture();let payload,calls=0;
 const f=fixture({globalMemory,siteMemory,tools:{async tab(id){return {url:id===1?'https://example.test/1':'https://other.test/1',status:'complete'};},async observe(id){return {url:id===1?'https://example.test/1':'https://other.test/1',snapshotId:'s',page:{text:'page',elements:[]}};}},model:async text=>{payload=JSON.parse(text);return {text:JSON.stringify(++calls===1?{reply:'save',action:'global_memory_write',id:'format',value:'User preference: Chinese tables'}:{reply:'read',action:'global_memory_read',id:'format'})};}});
 await f.runtime.start(1,'remember');await f.runtime.tick(1);await f.runtime.start(2,'recall');await f.runtime.tick(2);
 assert.deepEqual(payload.globalMemoryIndex,[{id:'format',source:'model',updatedAt:1}]);assert.equal(JSON.stringify(payload).includes('Chinese tables'),false);
 assert.equal((await f.runtime.get(2)).results.at(-1).result.note.text,'User preference: Chinese tables');assert.equal((await siteMemory.read('https://other.test')).notes.length,0);
 await f.runtime.remove(1);assert.equal((await f.runtime.getGlobalMemory()).notes.length,1);
});

test('global user clear cancels all origins, scrubs active and archived reads and rejects late writes',async()=>{
 const globalMemory=durableFixture(),siteMemory=durableFixture();let resolve,signal;
 const f=fixture({globalMemory,siteMemory,model:async(text,s)=>{signal=s;return new Promise(r=>resolve=r);}});
 await f.runtime.start(1,'one');await f.runtime.start(2,'two');let other=await f.runtime.get(2);other.origin='https://other.test';other.contextSummary={content:{facts:['old']}};other.results=[{action:'global_memory_read',result:'old'},{action:'click',result:'keep'}];other.contextArchive=[{id:'h1',results:[{action:'history_read',result:'old'}]}];await f.store.set(2,other);
 await siteMemory.change('https://example.test',{action:'write',id:'site',text:'keep site',expectedVersion:0});
 const job=f.runtime.tick(1);while(!resolve)await new Promise(r=>setImmediate(r));
 await f.runtime.editGlobalMemory({action:'clear',expectedVersion:0});assert.equal(signal.aborted,true);
 resolve({text:JSON.stringify({reply:'late',action:'global_memory_write',id:'old',value:'bad'})});await job;
 assert.equal((await f.runtime.getGlobalMemory()).notes.length,0);assert.equal((await siteMemory.read('https://example.test')).notes.length,1);
 for(const id of [1,2])assert.equal((await f.runtime.get(id)).status,'paused');other=await f.runtime.get(2);assert.equal(other.contextSummary,null);assert.equal(other.contextArchive[0].results.length,0);assert.deepEqual(other.results,[{action:'click',result:'keep'}]);
});

test('global version changes discard stale page actions',async()=>{
 const globalMemory=durableFixture();let resolve;
 const f=fixture({globalMemory,model:async()=>new Promise(r=>resolve=r)});await f.runtime.start(1,'task');const job=f.runtime.tick(1);while(!resolve)await new Promise(r=>setImmediate(r));
 await globalMemory.change(null,{action:'clear',expectedVersion:0});resolve({text:JSON.stringify({reply:'click',action:'click',id:'t0'})});await job;assert.equal(f.executed.length,0);assert.equal((await f.runtime.get(1)).phase,'observe');
});

test('global editing preserves original waiting deadlines and unknown executing checkpoints on resume',async()=>{
 const f=fixture({globalMemory:durableFixture(),now:()=>1000});await f.runtime.start(1,'wait');let t=await f.runtime.get(1);t.status='waiting_page';t.phase='verifying';t.check={kind:'delay',deadline:5000,request:{action:'wait',timeoutMs:4000}};await f.store.set(1,t);
 await f.runtime.editGlobalMemory({action:'write',id:'pref',text:'tables',expectedVersion:0});await f.runtime.resume(1);t=await f.runtime.get(1);assert.equal(t.check.deadline,5000);await f.runtime.tick(1);assert.equal((await f.runtime.get(1)).check.deadline,5000);
 await f.runtime.start(2,'save');t=await f.runtime.get(2);t.phase='executing';await f.store.set(2,t);await f.runtime.editGlobalMemory({action:'clear',expectedVersion:1});await f.runtime.resume(2);await f.runtime.tick(2);assert.equal((await f.runtime.get(2)).reason,'uncertain');assert.equal(f.executed.length,0);
});

test('a model global write invalidates other in-flight decisions across tabs',async()=>{
 const globalMemory=durableFixture();let resolve,calls=0;
 const f=fixture({globalMemory,model:async()=>++calls===1?new Promise(r=>resolve=r):{text:JSON.stringify({reply:'save',action:'global_memory_write',id:'pref',value:'use tables'})}});
 await f.runtime.start(1,'first');const job=f.runtime.tick(1);while(!resolve)await new Promise(r=>setImmediate(r));await f.runtime.start(2,'second');await f.runtime.tick(2);resolve({text:JSON.stringify({reply:'click',action:'click',id:'t0'})});await job;assert.equal(f.executed.length,0);assert.equal((await f.runtime.getGlobalMemory()).version,1);
});

test('segmented observe delivers text on the next model turn and preserves cumulative budget',async()=>{
 const offsets=[];let calls=0,second;
 const f=fixture({tools:{async observe(id,offset){offsets.push(offset);return {url:'https://example.test/1',documentId:'doc',page:{text:offset===16000?'tail':'prefix',textRange:{start:offset||0,nextOffset:null},elements:[]}};}},model:async input=>{
  if(++calls===1)return {text:JSON.stringify({reply:'read more',action:'observe',value:16000})};
  second=JSON.parse(input);return {text:JSON.stringify({reply:'finished reading',action:'done'})};
 }});
 await f.runtime.start(1,'Read');await f.runtime.tick(1);await f.runtime.tick(1);
 assert.deepEqual(offsets,[undefined,16000,undefined]);assert.match(JSON.stringify(second),/tail/);
 assert.equal((await f.runtime.get(1)).steps,2);assert.equal(f.executed.length,0);
});

test('stop during a segmented read discards its late result',async()=>{
 let resolve,started;const ready=new Promise(r=>started=r);
 const f=fixture({tools:{async observe(id,offset){if(offset===16000){started();return new Promise(r=>resolve=r);}return {url:'https://example.test/1',page:{elements:[]}};}},model:async()=>({text:JSON.stringify({reply:'read',action:'observe',value:16000})})});
 await f.runtime.start(1,'Read');const job=f.runtime.tick(1);await ready;await f.runtime.stop(1);
 resolve({url:'https://example.test/1',page:{text:'late tail',elements:[]}});await job;
 assert.doesNotMatch(JSON.stringify(await f.runtime.get(1)),/late tail/);assert.equal(f.executed.length,0);
});

test('control scope is freshly observed on next tick and its current ID can execute',async()=>{
 let calls=0;const reads=[];
 const f=fixture({tools:{async observe(id,value){reads.push(value);return {url:'https://example.test/1',documentId:'doc',snapshotId:'fresh-'+reads.length,page:{elements:[{id:value?'late':'t0',label:value?'Late target':'First'}]}};}},model:async input=>{
  const page=JSON.parse(input).page;
  return {text:JSON.stringify(++calls===1?{reply:'find',action:'observe',value:{query:'Late target'}}:{reply:'click',action:'click',id:page.elements[0].id})};
 }});
 await f.runtime.start(1,'Find late target');await f.runtime.tick(1);
 assert.equal(f.executed.length,0);assert.deepEqual((await f.runtime.get(1)).nextObservation.value,{query:'Late target'});
 f.runtime=createRuntime(f.deps); // Simulate worker restart with the saved read-only scope.
 await f.runtime.tick(1);assert.deepEqual(reads,[undefined,{query:'Late target'}]);assert.equal(f.executed[0].snapshotId,'fresh-2');assert.equal(f.executed[0].plan.id,'late');assert.equal((await f.runtime.get(1)).steps,2);
});

test('same-URL document replacement discards an old scope and reobserves default page',async()=>{
 let calls=0;const reads=[];
 const f=fixture({tools:{async observe(id,value){reads.push(value);return {url:'https://example.test/1',documentId:reads.length===1?'old':'new',page:{elements:[],text:value?'old scope':'fresh default'}};}},model:async input=>{
  if(++calls===1)return {text:JSON.stringify({reply:'find',action:'observe',value:{elementOffset:120}})};
  assert.equal(JSON.parse(input).page.text,'fresh default');return {text:JSON.stringify({reply:'done',action:'done'})};
 }});
 await f.runtime.start(1,'Find');await f.runtime.tick(1);await f.runtime.tick(1);
 assert.deepEqual(reads,[undefined,{elementOffset:120},undefined]);assert.equal(f.executed.length,0);
});

test('stop and resume discard queued control scope',async()=>{
 const f=fixture({model:async()=>({text:JSON.stringify({reply:'find',action:'observe',value:{query:'Late target'}})})});
 await f.runtime.start(1,'Find');await f.runtime.tick(1);assert.ok((await f.runtime.get(1)).nextObservation);
 await f.runtime.stop(1);assert.equal((await f.runtime.get(1)).nextObservation,null);
 await f.runtime.resume(1);assert.equal((await f.runtime.get(1)).nextObservation,null);
});

test('cancelled input pauses without automatic replay, including after worker reconstruction',async()=>{
 let attempts=0;
 const f=fixture({tools:{async execute(){attempts++;throw Object.assign(new Error('Input cancelled'),{code:'INPUT_CANCELLED'});}},model:async()=>({text:JSON.stringify({reply:'Fill',action:'fill',id:'t0',value:'new'})})});
 await f.runtime.start(1,'Fill');await f.runtime.tick(1);
 assert.equal((await f.runtime.get(1)).status,'paused');assert.equal((await f.runtime.get(1)).lastOutcome.code,'INPUT_CANCELLED');assert.equal((await f.runtime.get(1)).lastOutcome.dispatch,'unknown');
 f.runtime=createRuntime(f.deps);await f.runtime.tick(1);assert.equal(attempts,1);
});


test('action verification preserves original dispatch across worker recovery and timeout',async()=>{
 for(const dispatch of ['sent','unknown']){
  let clock=0,executions=0;
  const f=fixture({now:()=>clock,model:async()=>({text:JSON.stringify({reply:'Click',action:'click',id:'t0',expected:[{kind:'element_absent',id:'t0'}]})}),tools:{
   async execute(){executions++;return {version:2,status:'unknown',dispatch,scope:'ui',code:'CONDITIONS_UNMET',recovery:'wait'};},
   async verify(){return {version:2,status:'unknown',dispatch:'not_sent',scope:'page',code:'CONDITIONS_UNMET',evidence:[{code:'TARGET_MISSING'}]};}
  }});
  await f.runtime.start(1,'click');await f.runtime.tick(1);
  assert.equal((await f.runtime.get(1)).check.dispatch,dispatch);
  clock=20000;const recovered=createRuntime(f.deps);await recovered.tick(1);
  const t=await recovered.get(1);assert.equal(t.lastOutcome.dispatch,dispatch);
  assert.equal(t.lastOutcome.code,'CONDITION_TIMEOUT');assert.equal(executions,1);
 }
});

test('wheel is checkpointed, interrupted execution and stop never replay it',async()=>{
 const f=fixture({model:async()=>({text:JSON.stringify({reply:'Wheel',action:'wheel',id:'t0',value:'down'})})});
 await f.runtime.start(1,'wheel');await f.runtime.tick(1);assert.equal(f.executed.length,1);assert.equal(f.executed[0].plan.action,'wheel');
 let t=await f.runtime.get(1);t.phase='executing';t.check=null;await f.store.set(1,t);
 const recovered=createRuntime(f.deps);await recovered.tick(1);assert.equal((await recovered.get(1)).reason,'uncertain');assert.equal(f.executed.length,1);
 await recovered.stop(1);await createRuntime(f.deps).tick(1);assert.equal(f.executed.length,1);
});


test('compact mouse and keyboard actions stop before dispatch and never replay interrupted input',async()=>{
 for(const action of ['press_key','double_click','right_click']){
  let release;
  const plan={reply:'Input',action,id:'t0',...(action==='press_key'?{value:'ArrowDown'}:{})};
  const f=fixture({model:()=>new Promise(r=>{release=()=>r({text:JSON.stringify(plan)});})});
  await f.runtime.start(1,'input');const pending=f.runtime.tick(1);
  while(!release)await new Promise(r=>setImmediate(r));
  await f.runtime.stop(1);release();await pending;assert.equal(f.executed.length,0);
  const g=fixture({model:async()=>({text:JSON.stringify(plan)})});
  await g.runtime.start(1,'input');await g.runtime.tick(1);assert.equal(g.executed.length,1);
  const t=await g.runtime.get(1);t.phase='executing';t.check=null;await g.store.set(1,t);
  const fresh=createRuntime(g.deps);await fresh.tick(1);assert.equal((await fresh.get(1)).reason,'uncertain');assert.equal(g.executed.length,1);
 }
});

test('user takeover cancels a thinking request and resumes against manual page changes with original budget',async()=>{
 let resolve,started;const ready=new Promise(r=>started=r);let value='before',calls=0;
 const f=fixture({tools:{async observe(){return {url:'https://example.test/1',documentId:'doc',snapshotId:'s',page:{elements:[{id:'t0',key:'node',label:'Name',value}]}};}},model:async input=>{
  if(++calls===1){started();return new Promise(r=>resolve=r);}
  assert.equal(JSON.parse(input).page.elements[0].value,'manual');return {text:JSON.stringify({reply:'Observed manual value',action:'done'})};
 }});
 await f.runtime.start(1,'Work');const job=f.runtime.tick(1);await ready;const id=(await f.runtime.get(1)).taskId;
 await f.runtime.takeover(1);value='manual';resolve({text:JSON.stringify({reply:'Old fill',action:'fill',id:'t0',value:'old'})});await job;
 assert.equal(f.executed.length,0);assert.equal((await f.runtime.get(1)).reason,'user_takeover');
 f.runtime=createRuntime(f.deps);await f.runtime.resume(1);await f.runtime.tick(1);
 assert.equal((await f.runtime.get(1)).taskId,id);assert.equal((await f.runtime.get(1)).steps,2);assert.equal(f.executed.length,0);
});

test('takeover during uncertain dispatch blocks a newly planned repeat after resume',async()=>{
 let resolve,started;const ready=new Promise(r=>started=r);let actions=0;
 const f=fixture({tools:{async observe(){return {url:'https://example.test/1',documentId:'doc',snapshotId:'s',page:{elements:[{id:'t0',key:'save',label:'Save'}]}};},async execute(){actions++;started();return new Promise(r=>resolve=r);}},model:async()=>({text:JSON.stringify({reply:'Save',action:'click',id:'t0'})})});
 await f.runtime.start(1,'Save');const job=f.runtime.tick(1);await ready;await f.runtime.takeover(1);
 resolve({version:2,status:'unknown',dispatch:'sent',code:'NO_CHANGE'});await job;
 assert.equal((await f.runtime.get(1)).uncertainClicks.length,1);
 f.runtime=createRuntime(f.deps);await f.runtime.resume(1);await f.runtime.tick(1);assert.equal(actions,1);assert.equal((await f.runtime.get(1)).reason,'uncertain');
});

test('controls-only scoped observation reaches the model and its current target executes',async()=>{
 const reads=[];let calls=0;
 const f=fixture({tools:{async observe(id,value){reads.push(value);return {url:'https://example.test/1',documentId:'doc',snapshotId:'fresh',page:{text:value?.includeText===false?'':'Long body',textRange:{omitted:value?.includeText===false},elements:[{id:'t0',label:'Save'}]}};}},model:async input=>{
  if(++calls===1)return {text:JSON.stringify({reply:'Inspect controls',action:'observe',value:{includeText:false,query:'Save'}})};
  const page=JSON.parse(input).page;assert.equal(page.text,'');assert.equal(page.textRange.omitted,true);return {text:JSON.stringify({reply:'Click',action:'click',id:page.elements[0].id})};
 }});
 await f.runtime.start(1,'Save');await f.runtime.tick(1);await f.runtime.tick(1);
 assert.deepEqual(reads,[undefined,{includeText:false,query:'Save'}]);assert.equal(f.executed.length,1);assert.equal((await f.runtime.get(1)).steps,2);
});

test('incremental task milestones use current evidence and remain distinct from final completion',async()=>{
 let calls=0,value='old',lastInput;
 const f=fixture({tools:{async observe(){return {url:'https://example.test/1',documentId:'doc',snapshotId:'s',page:{elements:[{id:'t0',label:'Name',role:'textbox',value}]}};}},model:async input=>{
  lastInput=JSON.parse(input);const check=[{kind:'field_equals',id:'t0',value:'new'}];
  return {text:JSON.stringify({reply:'Update milestones',action:'observe',subgoals:++calls===1?[{id:'edit',title:'Name is new',status:'completed',checks:check},{id:'save',title:'Save result',status:'pending'}]:calls===2?[{id:'edit',title:'Name is new',status:'completed',checks:check}]:[{id:'save',title:'Save needs user data',status:'blocked'}]})};
 }});
 await f.runtime.start(1,'Edit');await f.runtime.tick(1);let task=await f.runtime.get(1);assert.equal(task.taskPlan[0].status,'active');assert.equal(task.taskPlan[0].verification.status,'not_satisfied');
 value='new';f.runtime=createRuntime(f.deps);await f.runtime.tick(1);task=await f.runtime.get(1);assert.equal(task.taskPlan.length,2);assert.equal(task.taskPlan.find(g=>g.id==='edit').status,'completed');assert.equal(task.status,'running');
 await f.runtime.submit(1,'Save requires user data');await f.runtime.tick(1);task=await f.runtime.get(1);assert.equal(task.taskPlan.find(g=>g.id==='save').status,'blocked');assert.equal(lastInput.taskPlan.length,2);assert.equal(task.steps,3);assert.equal(f.executed.length,0);
});

test('a stopped model reply cannot write task milestones',async()=>{
 let resolve,started;const ready=new Promise(r=>started=r);
 const f=fixture({model:async()=>{started();return new Promise(r=>resolve=r);}});
 await f.runtime.start(1,'Work');const job=f.runtime.tick(1);await ready;await f.runtime.stop(1);
 resolve({text:JSON.stringify({reply:'Late plan',action:'observe',subgoals:[{id:'late',title:'Late',status:'active'}]})});await job;assert.equal((await f.runtime.get(1)).taskPlan,undefined);
});

test('same-origin navigation verifies after worker reconstruction without replay or budget reset',async()=>{
 let url='https://example.test/1',actions=0;
 const f=fixture({tools:{async tab(){return {url,status:'complete'};},async observe(){return {url,documentId:url, snapshotId:'s',page:{elements:[]}};},async execute(){actions++;url='https://example.test/next';return {version:2,status:'unknown',dispatch:'unknown',code:'NAVIGATION_UNKNOWN',navigation:true};}},model:async()=>({text:JSON.stringify({reply:'Navigate',action:'navigate',value:'https://example.test/next'})})});
 await f.runtime.start(1,'Navigate');await f.runtime.tick(1);let t=await f.runtime.get(1);const id=t.taskId;assert.equal(t.phase,'verifying');assert.equal(t.check.expected[0].kind,'url_equals');
 f.runtime=createRuntime(f.deps);await f.runtime.tick(1);t=await f.runtime.get(1);assert.equal(t.check,null);assert.equal(t.lastOutcome.status,'success');assert.equal(t.lastOutcome.dispatch,'unknown');assert.equal(t.taskId,id);assert.equal(t.steps,1);assert.equal(actions,1);
});

test('memory changes invalidate task milestones and archived planning metadata without clearing checkpoint evidence',async()=>{
 for(const scope of ['global','site']){
  const globalMemory=durableFixture(),siteMemory=durableFixture(),f=fixture({globalMemory,siteMemory});
  await f.runtime.start(1,'Work');let t=await f.runtime.get(1);
  const subgoals=[{id:'old',title:'forgotten-plan-text',status:'active'}],request={reply:'Inspect',action:'observe',subgoals};
  t.taskPlan=subgoals;t.results=[{action:'observe',request}];t.contextArchive=[{id:'h1',results:[{action:'observe',request}]}];
  t.phase='executing';t.pending={plan:{reply:'Click',action:'click',id:'t0',subgoals},url:'https://example.test/1'};t.check={kind:'action',deadline:12345,expected:[{kind:'url_equals',value:'https://example.test/next'}],dispatch:'unknown',request:{reply:'Click',action:'click',subgoals}};
  await f.store.set(1,t);
  if(scope==='global')await f.runtime.editGlobalMemory({action:'clear',expectedVersion:0});
  else await f.runtime.editSiteMemory(1,{origin:'https://example.test',action:'clear',expectedVersion:0});
  t=await f.runtime.get(1);assert.equal(t.taskPlan,null);assert.doesNotMatch(JSON.stringify(t),/forgotten-plan-text/);assert.equal(t.results[0].request.action,'observe');
  if(scope==='global'){assert.equal(t.check.deadline,12345);assert.equal(t.check.dispatch,'unknown');assert.equal(t.pending.plan.action,'click');assert.equal(t.check.expected[0].kind,'url_equals');}
  await f.runtime.resume(1);
  const P=require('../extension/prompts.js');assert.doesNotMatch(P.agentInput(await f.runtime.get(1),{elements:[]}),/forgotten-plan-text/);
 }
});

test('global memory edits discard late milestone replies as well as existing plan text',async()=>{
 const globalMemory=durableFixture();let resolve,started;const ready=new Promise(r=>started=r);
 const f=fixture({globalMemory,model:async()=>{started();return new Promise(r=>resolve=r);}});
 await f.runtime.start(1,'Work');const job=f.runtime.tick(1);await ready;
 await f.runtime.editGlobalMemory({action:'clear',expectedVersion:0});resolve({text:JSON.stringify({reply:'Old plan',action:'observe',subgoals:[{id:'old',title:'forgotten-plan-text',status:'active'}]})});await job;
 assert.equal((await f.runtime.get(1)).taskPlan,null);assert.doesNotMatch(JSON.stringify(await f.runtime.get(1)),/forgotten-plan-text/);
});

test('model memory clear cannot reintroduce removed milestones in its request archive',async()=>{
 for(const action of ['global_memory_clear','site_memory_clear']){
  const f=fixture({globalMemory:durableFixture(),siteMemory:durableFixture(),model:async()=>({text:JSON.stringify({reply:'Clear notes',action,subgoals:[{id:'old',title:'forgotten-plan-text',status:'active'}]})})});
  await f.runtime.start(1,'Clear');await f.runtime.tick(1);const task=await f.runtime.get(1);
  assert.equal(task.taskPlan,null);assert.doesNotMatch(JSON.stringify(task),/forgotten-plan-text/);
 }
});

test('diagnostic timing distinguishes model failure and tool completion without adding rounds',async()=>{
 let clock=1000,calls=0;
 const f=fixture({now:()=>clock,model:async()=>{clock+=120;if(++calls===1)throw Error('API 503');return {text:JSON.stringify({reply:'Click',action:'click',id:'t0'})};},tools:{async execute(){clock+=35;return {version:2,status:'unknown',dispatch:'sent',code:'NO_CHANGE'};}}});
 await f.runtime.start(1,'Work');await f.runtime.tick(1);await f.runtime.tick(1);
 const t=await f.runtime.get(1);assert.deepEqual(t.metrics.timings.model,{attempts:2,completed:1,failed:1,totalMs:240,lastMs:120});assert.deepEqual(t.metrics.timings.tool,{attempts:1,completed:1,failed:0,totalMs:35,lastMs:35});assert.equal(t.steps,2);assert.equal(calls,2);
});

test('late diagnostic completion cannot update timing after stop',async()=>{
 let resolve,started;const ready=new Promise(r=>started=r);let clock=100;
 const f=fixture({now:()=>clock,model:async()=>{started();return new Promise(r=>resolve=r);}});
 await f.runtime.start(1,'Work');const job=f.runtime.tick(1);await ready;await f.runtime.stop(1);clock+=5000;resolve({text:JSON.stringify({reply:'Late',action:'done'})});await job;
 const t=await f.runtime.get(1);assert.equal(t.metrics.timings.model.attempts,1);assert.equal(t.metrics.timings.model.completed,0);assert.equal(t.metrics.timings.model.totalMs,0);assert.equal(t.status,'stopped');
});

test('diagnostic export uses numeric and enum allowlists and cannot leak task or page content',async()=>{
 const f=fixture();await f.runtime.start(1,'PRIVATE_GOAL');let task=await f.runtime.get(1);
 task.token='PRIVATE_TOKEN';task.taskPlan=[{title:'PRIVATE_PLAN'}];task.reason='PRIVATE_REASON';task.metrics={actions:4,observations:2,timings:{model:{attempts:2,completed:1,failed:0,totalMs:125,lastMs:125,secret:'PRIVATE_TIMING'}}};
 task.results=[{action:'click',request:{value:'PRIVATE_FORM'},result:'PRIVATE_RESULT',outcome:{status:'success',dispatch:'sent',code:'PRIVATE_CODE',observed:'PRIVATE_OBSERVED'}},{action:'PRIVATE_ACTION',outcome:{status:'PRIVATE_STATUS',dispatch:'PRIVATE_DISPATCH'}}];task.contextArchive=[{id:'PRIVATE_ARCHIVE',results:[{action:'fill',request:{value:'PRIVATE_OLD'},outcome:{status:'not_satisfied',dispatch:'unknown'}}]}];await f.store.set(1,task);
 const before=JSON.stringify(await f.runtime.get(1)),report=await f.runtime.diagnostics(1,task.taskId);
 assert.doesNotMatch(JSON.stringify(report),/PRIVATE_/);assert.deepEqual(report.outcomes.actions,{fill:1,click:1});assert.equal(report.outcomes.statuses.unknown,1);assert.equal(report.timings.model.totalMs,125);assert.equal(report.counts.actions,4);assert.equal(JSON.stringify(await f.runtime.get(1)),before);assert.equal(f.executed.length,0);
 await assert.rejects(()=>f.runtime.diagnostics(1,'other-task'),/任务或网站已变化/);
 task.origin='https://other.test';await f.store.set(1,task);await assert.rejects(()=>f.runtime.diagnostics(1,task.taskId),/任务或网站已变化/);
});

test('truncated HTTP 200 model output never reaches page tools or automatic retries',async()=>{
 const {createService}=require('../extension/backend.js');let requests=0;
 const chrome={storage:{local:{async get(){return {config:{endpoint:'https://api.test/v1',key:'PRIVATE_KEY',model:'test',language:'English'}};}}},permissions:{contains:async()=>true}};
 const service=createService(chrome,async()=>{requests++;return new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:JSON.stringify({reply:'Save',action:'click',id:'t0'})}}]}));});
 const f=fixture({model:service.generateAgent});await f.runtime.start(1,'Save');await f.runtime.tick(1);await f.runtime.tick(1);
 const task=await f.runtime.get(1);assert.equal(f.executed.length,0);assert.equal(requests,1);assert.equal(task.lastOutcome.code,'MODEL_OUTPUT_TRUNCATED');assert.equal(task.lastOutcome.dispatch,'not_sent');assert.equal(task.status,'failed');assert.doesNotMatch(JSON.stringify(task),/PRIVATE_KEY/);
});

test('scope reconciliation continuation preserves action deadline and only verifies the prior operation',async()=>{
 let models=0;
 const f=fixture({model:async()=>{models++;return {text:JSON.stringify({reply:'Done',action:'done'})};}});
 await f.runtime.start(1,'Work');let task=await f.runtime.get(1);task.status='paused';task.reason='scope_reconciled';task.phase='executing';task.steps=17;task.check={kind:'action',action:'navigate',dispatch:'unknown',deadline:Date.now()+10000,expected:[{kind:'url_equals',value:'https://example.test/1'}]};const deadline=task.check.deadline;await f.store.set(1,task);
 await f.runtime.resume(1);task=await f.runtime.get(1);assert.equal(task.check.deadline,deadline);assert.equal(task.phase,'executing');await f.runtime.tick(1);task=await f.runtime.get(1);assert.equal(task.lastOutcome.status,'success');assert.equal(task.lastOutcome.dispatch,'unknown');assert.equal(task.steps,17);assert.equal(models,0);assert.equal(f.executed.length,0);
});

test('stale task scheduling cannot execute a replacement task on the same tab',async()=>{
 let calls=0;const f=fixture({model:async()=>{calls++;return {text:JSON.stringify({reply:'Done',action:'done'})};}});
 const first=await f.runtime.start(1,'First'),second=await f.runtime.start(1,'Second');
 await f.runtime.tick(1,first.taskId);assert.equal(calls,0);assert.equal((await f.runtime.get(1)).steps,0);
 await f.runtime.tick(1,second.taskId);assert.equal(calls,1);assert.equal((await f.runtime.get(1)).status,'completed');
});

test('replacement task runs without waiting for an aborted old task request to settle',async()=>{
 let resolve,started;const ready=new Promise(r=>started=r);let calls=0;
 const f=fixture({model:async()=>{if(++calls===1){started();return new Promise(r=>resolve=r);}return {text:JSON.stringify({reply:'New task done',action:'done'})};}});
 const first=await f.runtime.start(1,'First');const old=f.runtime.tick(1,first.taskId);await ready;
 const second=await f.runtime.start(1,'Second');await f.runtime.tick(1,second.taskId);assert.equal((await f.runtime.get(1)).status,'completed');
 resolve({text:JSON.stringify({reply:'Old click',action:'click',id:'t0'})});await old;assert.equal(f.executed.length,0);assert.equal((await f.runtime.get(1)).taskId,second.taskId);
});


test('member close aborts a live model, archives through the real store, and rejects late click replies',async()=>{
 const {createTaskStore}=require('../extension/task-store.js');const data={};
 const area={async get(k){return structuredClone(k===null?data:{[k]:data[k]});},async set(v){Object.assign(data,structuredClone(v));},async remove(k){delete data[k];}};
 const store=createTaskStore({storage:{session:area}});let resolve,signal;const cancelled=[];
 const f=fixture({store,cancelSchedule:async id=>cancelled.push(id),model:async(text,s)=>{signal=s;return new Promise(r=>resolve=r);}});
 await f.runtime.start(1,'First');await f.runtime.start(2,'Independent');const independent=await store.get(2),tick=f.runtime.tick(1);
 while(!resolve)await new Promise(r=>setImmediate(r));
 const close=f.runtime.memberClosed(1);assert.equal(signal.aborted,true);await close;
 resolve({text:'{"reply":"Late","action":"click","id":"t0"}'});await tick;
 assert.equal(await store.get(1),null);assert.equal(f.executed.length,0);assert.deepEqual(await store.get(2),independent);assert.ok(cancelled.includes(1));assert.equal(cancelled.includes(2),false);
 const archived=data[Object.keys(data).find(k=>k.startsWith('conversation:1:'))];assert.equal(archived.status,'ended');assert.equal(archived.steps,1);
 await f.runtime.memberClosed(1);await f.runtime.recover();assert.equal(await store.get(1),null);
});


test('startup closes missing members using ID inventory and retains unknown dispatched checks',async()=>{
 const {createTaskStore}=require('../extension/task-store.js');const data={};
 const area={async get(k){return structuredClone(k===null?data:{[k]:data[k]});},async set(v){Object.assign(data,structuredClone(v));},async remove(k){delete data[k];}};
 const store=createTaskStore({storage:{session:area}});let unavailable=true;
 const f=fixture({store,tools:{async existingTabIds(){if(unavailable)throw Error('inventory unavailable');return [2];}}});
 await f.runtime.start(1,'Missing');await f.runtime.start(2,'Retained');const task=await store.get(1),check={kind:'action',deadline:9876,dispatch:'unknown'};await store.set(1,{...task,phase:'executing',check,pending:{plan:{action:'click'}}});f.scheduled.length=0;
 await assert.rejects(()=>f.runtime.recover(),/inventory unavailable/);assert.equal((await store.get(1)).status,'running');assert.equal(f.scheduled.length,0);
 unavailable=false;await f.runtime.recover();assert.equal(await store.get(1),null);assert.deepEqual(f.scheduled.map(x=>x.id),[2]);assert.deepEqual(data['conversation:1:'+task.taskId].check,check);assert.equal(f.executed.length,0);
});


test('closing during dispatch preserves its executing checkpoint and cannot replay a lost reply',async()=>{
 const {createTaskStore}=require('../extension/task-store.js');const data={};
 const area={async get(k){return structuredClone(k===null?data:{[k]:data[k]});},async set(v){Object.assign(data,structuredClone(v));},async remove(k){delete data[k];}};
 const store=createTaskStore({storage:{session:area}});let resolve,dispatches=0;
 const f=fixture({store,model:async()=>({text:'{"reply":"Click","action":"click","id":"t0"}'}),tools:{async execute(){dispatches++;return new Promise(r=>resolve=r);}}});
 const started=await f.runtime.start(1,'Work'),tick=f.runtime.tick(1);while(!resolve)await new Promise(r=>setImmediate(r));const before=await store.get(1);assert.equal(before.phase,'executing');assert.ok(before.pending);
 await f.runtime.memberClosed(1);const archive=data['conversation:1:'+started.taskId];assert.deepEqual(archive.pending,before.pending);assert.deepEqual(archive.check,before.check);assert.equal(archive.phase,'executing');
 resolve({version:2,status:'unknown',dispatch:'unknown',scope:'dispatch',code:'REPLY_LOST'});await tick;await f.runtime.recover();await f.runtime.tick(1,started.taskId);
 assert.equal(dispatches,1);assert.equal(await store.get(1),null);assert.deepEqual(data['conversation:1:'+started.taskId],archive);
});


test('scope changes require a host grant, abort late model actions, and gate revoked current origins',async()=>{
 const {createTaskStore}=require('../extension/task-store.js');const data={},area={async get(k){return structuredClone(k===null?data:{[k]:data[k]});},async set(v){Object.assign(data,structuredClone(v));},async remove(k){delete data[k];}};
 const store=createTaskStore({storage:{session:area}});let granted=false,resolve,signal;
 const f=fixture({store,tools:{async hasOriginAccess(origin){return origin==='https://example.test'||granted;}},model:async(text,s)=>{signal=s;return new Promise(r=>resolve=r);}});
 await f.runtime.start(1,'Scope');const initial=await store.get(1),op={taskId:initial.taskId,expectedRevision:initial.scopeRevision,origin:'https://two.test',action:'add'};
 await assert.rejects(()=>f.runtime.changeOrigins(1,op),/授权/);assert.equal((await store.get(1)).status,'running');assert.deepEqual((await store.get(1)).allowedOrigins,[initial.origin]);
 const tick=f.runtime.tick(1);while(!resolve)await new Promise(r=>setImmediate(r));granted=true;const changed=await f.runtime.changeOrigins(1,op);assert.equal(signal.aborted,true);assert.equal(changed.status,'paused');assert.equal(changed.steps,1);
 resolve({text:'{"reply":"Old click","action":"click","id":"t0"}'});await tick;assert.equal(f.executed.length,0);
 await assert.rejects(()=>f.runtime.changeOrigins(1,op),/已变化/);
 const removed=await f.runtime.changeOrigins(1,{...op,action:'remove',origin:initial.origin,expectedRevision:changed.scopeRevision});await assert.rejects(()=>f.runtime.resume(1),/授权范围/);await assert.rejects(()=>f.runtime.submit(1,'Continue'),/授权范围/);assert.equal(f.executed.length,0);assert.deepEqual(removed.allowedOrigins,[op.origin]);
 await store.set(1,{...removed,status:'running'});const observations=(await store.get(1)).metrics.observations;await f.runtime.tick(1);assert.equal((await store.get(1)).reason,'scope_changed');assert.equal((await store.get(1)).metrics.observations,observations);
});

test('scope and browser permission revocation preserve unknown checkpoints for read-only continuation',async()=>{
 const {createTaskStore}=require('../extension/task-store.js');const data={},area={async get(k){return structuredClone(k===null?data:{[k]:data[k]});},async set(v){Object.assign(data,structuredClone(v));},async remove(k){delete data[k];}};
 const store=createTaskStore({storage:{session:area}});let granted=true;
 const f=fixture({store,tools:{async hasOriginAccess(){return granted;}}});await f.runtime.start(1,'Unknown');let current=await store.get(1);const check={kind:'action',deadline:99999,dispatch:'unknown',expected:[]};await store.set(1,{...current,phase:'executing',check,pending:{plan:{action:'click'}}});
 granted=false;await f.runtime.reviewPermissions();current=await store.get(1);assert.equal(current.status,'paused');assert.equal(current.reason,'permission_denied');assert.deepEqual(current.check,check);assert.equal(current.phase,'executing');await assert.rejects(()=>f.runtime.resume(1),/授权/);
 granted=true;const resumed=await f.runtime.resume(1);assert.deepEqual(resumed.check,check);assert.equal(resumed.phase,'executing');assert.equal(f.executed.length,0);
 const removed=await f.runtime.changeOrigins(1,{taskId:current.taskId,expectedRevision:current.scopeRevision,origin:current.origin,action:'remove'});
 const restored=await f.runtime.changeOrigins(1,{taskId:current.taskId,expectedRevision:removed.scopeRevision,origin:current.origin,action:'add'});assert.deepEqual(restored.check,check);assert.equal((await f.runtime.resume(1)).phase,'executing');
});


test('stop while an asynchronous host access check is pending cannot dispatch a returned model action',async()=>{
 let returned=false,resolveAccess;
 const f=fixture({tools:{async hasOriginAccess(){if(returned&&!resolveAccess)return new Promise(r=>resolveAccess=r);return true;}},model:async()=>{returned=true;return {text:'{"reply":"Click","action":"click","id":"t0"}'};}});
 await f.runtime.start(1,'Work');const tick=f.runtime.tick(1);while(!resolveAccess)await new Promise(r=>setImmediate(r));await f.runtime.stop(1);resolveAccess(true);await tick;assert.equal(f.executed.length,0);assert.equal((await f.runtime.get(1)).status,'stopped');
});


function crossFixture(options={}){
 const {createTaskStore}=require('../extension/task-store.js'),raw={},state={url:'https://a.test/start'},reads=[],payloads=[],dispatches=[];
 const area={async get(k){return structuredClone(k===null?raw:{[k]:raw[k]});},async set(v){Object.assign(raw,structuredClone(v));},async remove(k){delete raw[k];}},store=createTaskStore({storage:{session:area}});
 const f=fixture({store,...options,model:async(text,signal)=>{payloads.push(JSON.parse(text));return options.model?options.model(JSON.parse(text),signal):{text:JSON.stringify({reply:'Continue',action:new URL(state.url).origin==='https://a.test'?'navigate':'done',value:new URL(state.url).origin==='https://a.test'?'https://b.test/next':undefined})};},tools:{async tab(id){return {id,url:state.url,status:'complete'};},async hasOriginAccess(origin){return options.hasOriginAccess?options.hasOriginAccess(origin):true;},async observe(){reads.push(state.url);return {url:state.url,documentId:state.url,snapshotId:'s',page:{text:'Fresh page',elements:[{id:'t0',tag:'input',label:'Field'}]}};},async execute(id,pending){dispatches.push(pending);state.url=pending.plan.value;return {version:2,status:'unknown',dispatch:'unknown',code:'NAVIGATION_UNKNOWN',navigation:true};},...options.tools}});
 return {...f,store,raw,state,reads,payloads,dispatches};
}

test('authorized A to B to A navigation keeps one task and budget while each origin receives fresh isolated context',async()=>{
 let aCalls=0;const f=crossFixture({siteMemory:{async read(origin){return {version:0,notes:[{id:origin==='https://a.test'?'A_NOTE_ID':'B_NOTE_ID'}]};}},globalMemory:{async read(){return {version:0,notes:[{id:'GLOBAL_SHARED'}]};}},model:async data=>{
  if(data.page.url.startsWith('https://a.test')){aCalls++;if(aCalls===1){assert.ok(JSON.stringify(data).includes('A_BODY_SECRET'));return {text:'{"reply":"To B","action":"navigate","value":"https://b.test/next"}'};}assert.equal(JSON.stringify(data).includes('A_BODY_SECRET'),false);assert.equal(JSON.stringify(data).includes('B_BODY_SECRET'),false);return {text:'{"reply":"Finished","action":"done"}'};}
  const text=JSON.stringify(data);for(const marker of ['A_BODY_SECRET','A_SUMMARY_SECRET','A_PLAN_SECRET','A_GUARD_PRIVATE','A_NOTE_ID'])assert.equal(text.includes(marker),false,marker);assert.ok(text.includes('B_NOTE_ID'));assert.ok(text.includes('GLOBAL_SHARED'));assert.ok(text.includes('USER_SHARED'));
  return {text:'{"reply":"To A","action":"navigate","value":"https://a.test/back"}'};
 }});
 await f.runtime.start(1,'USER_SHARED visit the two authorized sites');let t=await f.store.get(1);await f.runtime.changeOrigins(1,{taskId:t.taskId,expectedRevision:t.scopeRevision,action:'add',origin:'https://b.test'});await f.runtime.resume(1);t=await f.store.get(1);
 await f.store.set(1,{...t,steps:17,results:[{action:'site_memory_read',result:'A_BODY_SECRET'}],contextSummary:{content:{facts:['A_SUMMARY_SECRET']}},contextArchive:[{id:'h1',from:1,to:1,results:[{result:'A_BODY_SECRET'}]}],taskPlan:[{id:'p',title:'A_PLAN_SECRET'}],uncertainClicks:[{url:'https://a.test/start',documentId:'old-document',target:{category:'element',label:'A_GUARD_PRIVATE'}}]});
 await f.runtime.tick(1);const deadline=(await f.store.get(1)).check.deadline;await f.runtime.tick(1);let b=await f.store.get(1);assert.equal(b.origin,'https://b.test');assert.equal(b.initialOrigin,'https://a.test');assert.equal(b.steps,18);assert.equal(b.contextSummary,undefined);assert.deepEqual(b.contextArchive,[]);assert.deepEqual(b.results,[]);assert.equal(b.check,null);
 await f.store.set(1,{...b,results:[{action:'site_memory_read',result:'B_BODY_SECRET'}]});await f.runtime.tick(1);await f.runtime.tick(1);await f.runtime.tick(1);
 const ended=await f.store.get(1);assert.equal(ended.taskId,t.taskId);assert.equal(ended.steps,20);assert.equal(ended.status,'completed');assert.equal(ended.origin,'https://a.test');assert.equal(ended.initialOrigin,'https://a.test');assert.equal(ended.uncertainClicks[0].target.label,'A_GUARD_PRIVATE');assert.equal(f.dispatches.length,2);assert.equal(f.payloads.length,3);assert.ok(deadline>0);
 const aHistory=await f.store.historyGet(1,'https://a.test',t.taskId),bHistory=await f.store.historyGet(1,'https://b.test',t.taskId);assert.ok(JSON.stringify(aHistory).includes('A_BODY_SECRET'));assert.equal(JSON.stringify(aHistory).includes('B_BODY_SECRET'),false);assert.ok(JSON.stringify(bHistory).includes('B_BODY_SECRET'));assert.equal(JSON.stringify(bHistory).includes('A_BODY_SECRET'),false);
});

test('browser host permission permits navigation without separate task grants',async()=>{
 const f=crossFixture();await f.runtime.start(1,'Navigate autonomously');await f.runtime.tick(1);assert.equal(f.dispatches.length,1);await f.runtime.tick(1);assert.equal((await f.store.get(1)).origin,'https://b.test');assert.ok((await f.store.get(1)).allowedOrigins.includes('https://b.test'));
 const denied=crossFixture({hasOriginAccess:origin=>origin==='https://a.test'});await denied.runtime.start(1,'No grant');const t=await denied.store.get(1);await assert.rejects(()=>denied.runtime.changeOrigins(1,{taskId:t.taskId,expectedRevision:t.scopeRevision,action:'add',origin:'https://b.test'}),/授权/);denied.state.url='https://b.test/next';await denied.runtime.tick(1);assert.equal(denied.reads.length,0);assert.equal((await denied.store.get(1)).status,'paused');
});

test('cross-origin worker recovery only checks the browser URL and never replays the saved navigation',async()=>{
 const f=crossFixture();await f.runtime.start(1,'Recover');let t=await f.store.get(1);await f.runtime.changeOrigins(1,{taskId:t.taskId,expectedRevision:t.scopeRevision,action:'add',origin:'https://b.test'});await f.runtime.resume(1);await f.runtime.tick(1);t=await f.store.get(1);const deadline=t.check.deadline;await f.store.set(1,{...t,phase:'executing',check:{...t.check,dispatch:'unknown'}});
 const replacement=createRuntime(f.deps);await replacement.recover();await replacement.tick(1);assert.equal((await f.store.get(1)).origin,'https://b.test');assert.equal(f.dispatches.length,1);assert.equal(f.payloads.length,1);assert.equal(f.reads.length,1);assert.equal(t.check.deadline,deadline);await replacement.tick(1);assert.equal((await f.store.get(1)).status,'completed');assert.equal(f.dispatches.length,1);
});

test('unapproved redirects and old DOM expectations pause before destination observation and retain original deadlines',async()=>{
 for(const domCheck of [false,true]){
  const f=crossFixture();await f.runtime.start(1,'Boundary');let t=await f.store.get(1);await f.runtime.changeOrigins(1,{taskId:t.taskId,expectedRevision:t.scopeRevision,action:'add',origin:'https://b.test'});await f.runtime.resume(1);await f.runtime.tick(1);t=await f.store.get(1);
  if(domCheck)await f.store.set(1,{...t,check:{...t.check,expected:[{kind:'field_equals',id:'t0',value:'Old private value'}]}});else f.state.url='https://c.test/redirect';
  await f.runtime.tick(1);const paused=await f.store.get(1);assert.equal(paused.status,'paused');assert.equal(paused.origin,'https://a.test');assert.equal(paused.check.deadline,t.check.deadline);assert.equal(paused.check.dispatch,'unknown');assert.equal(f.reads.length,1);assert.equal(f.payloads.length,1);assert.equal(f.dispatches.length,1);
 }
});

test('a URL change aborts a pending source model and its late click cannot reach the new origin',async()=>{
 let resolve,signal;const f=crossFixture({model:async(data,s)=>{signal=s;return new Promise(r=>resolve=r);}});await f.runtime.start(1,'Pending source');let t=await f.store.get(1);await f.runtime.changeOrigins(1,{taskId:t.taskId,expectedRevision:t.scopeRevision,action:'add',origin:'https://b.test'});await f.runtime.resume(1);const tick=f.runtime.tick(1);while(!resolve)await new Promise(r=>setImmediate(r));f.state.url='https://b.test/next';const changed=f.runtime.navigationChanged(1);assert.equal(signal.aborted,true);await changed;resolve({text:'{"reply":"Old","action":"click","id":"t0"}'});await tick;await f.runtime.tick(1);assert.equal((await f.store.get(1)).origin,'https://b.test');assert.equal(f.dispatches.length,0);assert.equal(f.payloads.length,1);
});


test('origin history capacity failure pauses with the original source intact instead of retrying or trimming',async()=>{
 const f=crossFixture();await f.runtime.start(1,'Large source');let t=await f.store.get(1);await f.runtime.changeOrigins(1,{taskId:t.taskId,expectedRevision:t.scopeRevision,action:'add',origin:'https://b.test'});await f.runtime.resume(1);t=await f.store.get(1);const large='x'.repeat(1000001);await f.store.set(1,{...t,results:[{result:large}]});f.state.url='https://b.test/next';await f.runtime.tick(1);const paused=await f.store.get(1);assert.equal(paused.status,'paused');assert.equal(paused.reason,'origin_storage');assert.equal(paused.origin,'https://a.test');assert.equal(paused.results[0].result,large);assert.equal(f.reads.length,0);assert.equal(f.payloads.length,0);assert.equal(paused.steps,0);
});


test('sensitive permission waits for explicit trusted decision and is conversation scoped',async()=>{
 for(const allow of [true,false]){
  const policies=[];
  const f=fixture({model:async()=>({text:JSON.stringify({action:'request_sensitive_access',reply:'Need sensitive fields'})}),tools:{async observe(id,offset,policy){policies.push(policy);return {url:'https://example.test/1',snapshotId:'s',page:{elements:[]}};}}});
  await f.runtime.start(1,'Fill');await f.runtime.tick(1);
  let t=await f.runtime.get(1);const request={taskId:t.taskId,requestId:t.sensitiveRequest.id,allow};
  assert.equal(t.status,'paused');assert.equal(t.helpAttempts||0,0);assert.equal(f.executed.length,0);assert.equal(policies[0].sensitiveFields,false);
  await assert.rejects(()=>f.runtime.resume(1));
  await assert.rejects(()=>f.runtime.sensitiveAccess(1,{...request,taskId:'old'}));
  t=await f.runtime.sensitiveAccess(1,request);assert.equal(t.sensitiveAccess,allow?'allowed':'denied');
  await assert.rejects(()=>f.runtime.sensitiveAccess(1,request));
  if(allow){await f.runtime.tick(1);assert.equal(policies[1].sensitiveFields,true);}
  await f.runtime.finish(1);await f.runtime.start(1,'New conversation');assert.equal((await f.runtime.get(1)).sensitiveAccess,undefined);
 }
});


test('browser conversation runs without DOM/site permission and keeps answer context',async()=>{
 let calls=0;
 const f=fixture({tools:{async tab(){return {url:'chrome://newtab/',status:'complete'};},async observe(){throw Error('must not read internal DOM');},async hasOriginAccess(){throw Error('must not request internal host access');}},model:async text=>{const data=JSON.parse(text);assert.equal(data.page.browser,true);assert.deepEqual(data.taskScope.allowedOrigins,[]);if(calls++)assert.equal(data.results[0].result,'First answer');return {text:JSON.stringify({action:'done',reply:'First answer'})};}});
 await f.runtime.start(1,'Help');const first=await f.runtime.get(1);await f.runtime.tick(1);assert.equal((await f.runtime.get(1)).status,'completed');
 await f.runtime.submit(1,'Follow up');assert.equal((await f.runtime.get(1)).taskId,first.taskId);await f.runtime.tick(1);assert.equal(calls,2);assert.equal(f.executed.length,0);
});

test('a follow-up on another site after completion continues the task through origin isolation',async()=>{
 const f=crossFixture({model:async data=>({text:JSON.stringify({action:'done',reply:data.page.url.startsWith('https://a.test')?'A_ANSWER':'B_ANSWER'})})});
 const first=await f.runtime.submit(1,'USER_GOAL');await f.runtime.tick(1);assert.equal((await f.store.get(1)).status,'completed');
 f.state.url='https://b.test/other';
 let t=await f.runtime.submit(1,'USER_FOLLOWUP');assert.equal(t.taskId,first.taskId);assert.equal(t.status,'running');
 await f.runtime.tick(1);t=await f.store.get(1);assert.equal(t.taskId,first.taskId);assert.equal(t.origin,'https://b.test');assert.equal(t.status,'running');
 await f.runtime.tick(1);t=await f.store.get(1);assert.equal(t.status,'completed');
 const last=JSON.stringify(f.payloads.at(-1));assert.ok(last.includes('USER_GOAL'));assert.ok(last.includes('USER_FOLLOWUP'));assert.equal(last.includes('A_ANSWER'),false);
 assert.equal(f.dispatches.length,0);
});

test('browser navigation requests only missing host permission then enters normal execution',async()=>{
 let granted=false;
 const f=crossFixture({hasOriginAccess:origin=>origin==='https://b.test'?granted:true,model:async data=>({text:JSON.stringify(data.page.browser?{action:'navigate',value:'https://b.test/next',reply:'Open requested site'}:{action:'done',reply:'Opened'})})});
 f.state.url='chrome://newtab/';await f.runtime.start(1,'Open site');await f.runtime.tick(1);
 let t=await f.store.get(1);assert.equal(t.reason,'browser_target');assert.equal(t.browserTarget,'https://b.test/next');assert.deepEqual(t.allowedOrigins,[]);assert.equal(f.dispatches.length,0);assert.equal(f.reads.length,0);
 granted=true;await f.runtime.resume(1);await f.runtime.tick(1);
 t=await f.store.get(1);assert.equal(t.check.expected[0].value,'https://b.test/next');assert.equal(f.dispatches.length,1);
 await createRuntime(f.deps).tick(1);t=await f.store.get(1);assert.equal(t.origin,'https://b.test');assert.equal(f.dispatches.length,1);await f.runtime.tick(1);assert.equal((await f.store.get(1)).status,'completed');assert.deepEqual(f.reads,['https://b.test/next']);
});

test('stopping browser planning drops late model navigation',async()=>{
 let resolve,signal;const f=fixture({tools:{async tab(){return {url:'edge://settings/',status:'complete'};}},model:async(text,s)=>{signal=s;return new Promise(r=>resolve=r);}});
 await f.runtime.start(1,'Open site');const job=f.runtime.tick(1);while(!resolve)await new Promise(r=>setImmediate(r));await f.runtime.stop(1);assert.equal(signal.aborted,true);resolve({text:JSON.stringify({action:'navigate',value:'https://example.test/',reply:'Open'})});await job;assert.equal((await f.runtime.get(1)).status,'stopped');assert.equal(f.executed.length,0);
});

test('internal tab navigates immediately with existing browser permission',async()=>{
 const f=crossFixture({model:async()=>({text:JSON.stringify({action:'navigate',value:'https://b.test/next',reply:'Open site'})})});
 f.state.url='chrome://newtab/';await f.runtime.start(1,'Open site');await f.runtime.tick(1);
 assert.equal(f.dispatches.length,1);assert.notEqual((await f.store.get(1)).reason,'browser_target');
 await f.runtime.tick(1);assert.equal((await f.store.get(1)).origin,'https://b.test');assert.equal(f.dispatches.length,1);
});

test('sensitive field operations are marked so saved history can hide their values',async()=>{
 let n=0;const H=require('../extension/history-store.js');
 const f=fixture({tools:{async observe(){return {url:'https://example.test/1',snapshotId:'s'+n,page:{text:'Login',elements:[{id:'t0',label:'Password',tag:'input',type:'password',sensitive:true},{id:'t1',label:'Name',tag:'input'}]}};}},
  model:async()=>{n++;return {text:JSON.stringify(n===1?{reply:'Fill password',action:'fill',id:'t0',value:'hunter22'}:n===2?{reply:'Fill name',action:'fill',id:'t1',value:'Alice'}:{reply:'Done',action:'done'})};}});
 await f.runtime.start(1,'Log in with hunter22');for(let i=0;i<4;i++)await f.runtime.tick(1);
 const task=await f.runtime.get(1);assert.equal(task.status,'completed');
 assert.equal(task.results[0].sensitive,true);assert.equal(task.results[1].sensitive,undefined);
 const saved=JSON.stringify(H.snapshot(task));
 assert.equal(saved.includes('hunter22'),false);assert.ok(saved.includes('Alice'));assert.ok(saved.includes('Log in with 已隐藏'));
});
