const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createRuntime}=require('../extension/runtime.js');

function fixture(overrides={}){
 const data=new Map(),memories=new Map(),scheduled=[],executed=[];let seq=0,observed=0;
 const store={async get(id){return structuredClone(data.get(id)||null);},async set(id,t){data.set(id,structuredClone(t));},async remove(id){data.delete(id);},async list(){return [...data.values()].map(t=>structuredClone(t));},async getMemory(id,origin){return structuredClone(memories.get(id+origin)||[]);},async setMemory(id,origin,notes){memories.set(id+origin,structuredClone(notes));},async removeMemory(id){for(const key of memories.keys())if(key.startsWith(String(id)))memories.delete(key);}};
 const tools={async tab(id){return {id,url:'https://example.test/1',status:'complete'};},async observe(){observed++;return {url:'https://example.test/1',snapshotId:'snap'+observed,page:{text:'Question',elements:[{id:'t0',label:'Answer',tag:'input'}]}};},async execute(id,p){executed.push(p);return {version:2,status:'success',dispatch:'sent',scope:'ui',code:'CONDITIONS_MATCH',recovery:'none',message:'Matched'};},...overrides.tools};
 const deps={store,tools,summarize:async()=>({text:JSON.stringify({completed:['已核实的字段状态'],remaining:[],facts:[],failed:[],uncertain:[]})}),schedule:(id,delay)=>scheduled.push({id,delay}),cancelSchedule:async()=>{},uuid:()=>String(++seq),preferences:async()=>({maxSteps:50,autoFill:true}),model:async()=>({text:'{"reply":"完成","action":"done"}'}),...overrides,tools};
 return {data,store,tools,deps,scheduled,executed,runtime:createRuntime(deps)};
}

test('auto click executes without confirmation independently of auto fill',async()=>{
 const f=fixture({preferences:async()=>({maxSteps:50,autoFill:false,autoClick:true}),model:async()=>({text:'{"reply":"翻页","action":"click","id":"t0"}'})});
 await f.runtime.start(1,'翻页');await f.runtime.tick(1);
 assert.equal(f.executed.length,1);assert.equal((await f.runtime.get(1)).status,'running');
 const g=fixture({preferences:async()=>({maxSteps:50,autoFill:false,autoClick:true}),model:async()=>({text:'{"reply":"填写","action":"fill","id":"t0","value":"4"}'})});
 await g.runtime.start(1,'填表');await g.runtime.tick(1);
 assert.equal(g.executed.length,0);assert.equal((await g.runtime.get(1)).status,'waiting_confirmation');
});

test('resuming pending confirmation applies newly enabled auto click and replans',async()=>{
 let enabled=false;const f=fixture({preferences:async()=>({maxSteps:50,autoFill:true,autoClick:enabled}),model:async()=>({text:'{"reply":"翻页","action":"click","id":"t0"}'})});
 await f.runtime.start(1,'翻页');await f.runtime.tick(1);assert.equal((await f.runtime.get(1)).status,'waiting_confirmation');
 enabled=true;await f.runtime.resume(1);await f.runtime.tick(1);assert.equal(f.executed.length,1);assert.equal((await f.runtime.get(1)).prefs.autoClick,true);
});

test('runtime owns task independent of document, confirms clicks and consumes same budget',async()=>{
 let calls=0;const f=fixture({model:async()=>({text:JSON.stringify(++calls===1?{reply:'填写',action:'fill',id:'t0',value:'4'}:calls===2?{reply:'下一页',action:'click',id:'t0'}:{reply:'完成',action:'done'})})});
 const task=await f.runtime.start(1,'做题');assert.equal(task.prefs.maxSteps,50);
 await f.runtime.tick(1);assert.equal(f.executed.length,1);
 await f.runtime.tick(1);let state=await f.runtime.get(1);assert.equal(state.status,'waiting_confirmation');assert.equal(f.executed.length,1);
 await assert.rejects(()=>f.runtime.approve(1,'wrong'));
 await f.runtime.approve(1,task.taskId);await f.runtime.tick(1);assert.equal(f.executed.length,2);assert.equal(calls,2);
 await f.runtime.tick(1);state=await f.runtime.get(1);assert.equal(state.status,'completed');assert.equal(state.steps,3);
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

test('navigation invalidates confirmation and cross-origin destination pauses task',async()=>{
 let url='https://example.test/1';const f=fixture({tools:{async tab(){return {url,status:'complete'};}},model:async()=>({text:'{"reply":"下一页","action":"click","id":"t0"}'})});
 const t=await f.runtime.start(1,'翻页');await f.runtime.tick(1);url='https://example.test/2';
 await f.runtime.approve(1,t.taskId);await f.runtime.tick(1);assert.equal(f.executed.length,0);assert.equal((await f.runtime.get(1)).phase,'observe');
 url='https://other.test/';await f.runtime.tick(1);assert.equal((await f.runtime.get(1)).reason,'origin');
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
 const next=await f.runtime.submit(1,'新的工作');assert.notEqual(next.taskId,original.taskId);assert.equal(next.steps,0);
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

test('model writes temporary notes, sees index only and chooses read across task boundaries',async()=>{
 let count=0,payload;const f=fixture({model:async text=>{
  payload=JSON.parse(text);count++;
  return {text:JSON.stringify(count===1?{reply:'保存更正',action:'memory_write',id:'answers',value:'用户指定第1题对、第2题错'}:count===3?{reply:'回顾答案',action:'memory_read'}:{reply:'完成',action:'done'})};
 }});
 await f.runtime.submit(1,'作答');await f.runtime.tick(1);await f.runtime.tick(1);
 const first=await f.runtime.get(1);assert.equal(first.status,'completed');
 assert.equal((await f.runtime.getMemory(1))[0].text,'用户指定第1题对、第2题错');
 await f.runtime.submit(1,'再检查一次');await f.runtime.tick(1);
 assert.notEqual((await f.runtime.get(1)).taskId,first.taskId);
 assert.equal(payload.memoryIndex[0].id,'answers');assert.equal(JSON.stringify(payload).includes('用户指定第1题'),false);
 await f.runtime.tick(1);assert.match(JSON.stringify(payload.results),/用户指定第1题/);
 assert.equal(f.executed.length,0);
});

test('model can delete notes or clear site memory; manual clear invalidates pending model',async()=>{
 const f=fixture({model:async()=>({text:'{"reply":"过期","action":"memory_delete","id":"old"}'})});
 await f.store.setMemory(1,'https://example.test',[{id:'old',text:'旧答案'},{id:'keep',text:'保留'}]);
 await f.runtime.submit(1,'清理');await f.runtime.tick(1);assert.deepEqual((await f.runtime.getMemory(1)).map(m=>m.id),['keep']);
 f.deps.model=async()=>({text:'{"reply":"清空","action":"memory_clear"}'});
 await createRuntime(f.deps).tick(1);assert.equal((await f.runtime.getMemory(1)).length,0);
 let resolve;const g=fixture({model:async()=>new Promise(r=>resolve=r)});await g.runtime.submit(1,'任务');const tick=g.runtime.tick(1);
 while(!resolve)await new Promise(r=>setImmediate(r));
 await g.runtime.clearMemory(1);resolve({text:'{"reply":"旧写入","action":"memory_write","id":"old","value":"不应写入"}'});await tick;
 assert.equal((await g.runtime.getMemory(1)).length,0);assert.equal((await g.runtime.get(1)).status,'paused');
});

test('memory capacity returns tool feedback so model can consolidate; tab close clears notes',async()=>{
 const f=fixture({model:async()=>({text:'{"reply":"保存","action":"memory_write","id":"extra","value":"more"}'})});
 await f.store.setMemory(1,'https://example.test',Array.from({length:12},(_,i)=>({id:'note'+i,text:'data'})));
 await f.runtime.submit(1,'任务');await f.runtime.tick(1);
 const t=await f.runtime.get(1);assert.equal(t.status,'running');assert.match(t.results.at(-1).result.error,/容量/);
 await f.runtime.remove(1);assert.equal((await f.runtime.getMemory(1)).length,0);
});

test('model reporting incomplete work pauses and preserves task identity for followups',async()=>{
 const f=fixture({model:async()=>({text:'{"reply":"仍有错题，请提供回顾页面","action":"pause"}'})});
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
 const second=P.agentInput(t,{text:'new'});const prefix=first.slice(0,first.indexOf('],"memoryIndex"'));
 assert.ok(second.startsWith(prefix));
});

test('oversized protected context pauses without repeated summary requests',async()=>{
 let summaries=0;const f=fixture({tools:{async observe(){return {url:'https://example.test/1',page:{text:'中'.repeat(26000),elements:[]}};}},summarize:async()=>{summaries++;return {text:summaryText};}});
 await f.runtime.start(1,'任务');let t=await f.runtime.get(1);t.results=oldHistory();await f.store.set(1,t);
 await f.runtime.tick(1);await f.runtime.tick(1);assert.equal((await f.runtime.get(1)).reason,'context');assert.equal(summaries,1);assert.equal(f.executed.length,0);
});


test('manual memory clearing removes archived and recovered note bodies and invalidates usage',async()=>{
 const f=fixture();await f.runtime.start(1,'任务');let t=await f.runtime.get(1);
 t.contextArchive=[{id:'h1',from:1,to:3,results:[{action:'memory_read',result:'old note'},{action:'history_read',result:'old note'},{action:'click',result:'safe'}]}];
 t.contextSummary={content:{facts:['old note']},through:3};t.contextUsage={promptTokens:10};t.results=[{action:'history_read',result:'old note'}];await f.store.set(1,t);
 await f.runtime.clearMemory(1);t=await f.runtime.get(1);assert.equal(t.contextSummary,null);assert.equal(t.contextUsage,null);assert.equal(t.results.length,0);assert.deepEqual(t.contextArchive[0].results,[{action:'click',result:'safe'}]);
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
