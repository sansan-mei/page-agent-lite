const {test}=require('node:test');const assert=require('node:assert/strict');
const {createTaskStore}=require('../extension/task-store.js');

test('conversation replacement archives by task ID, keeps scopes and current task separate, and preserves data on quota failure',async()=>{
 const data={};let fail=false;
 const area={async get(k){return structuredClone(k===null?data:{[k]:data[k]});},async set(v){if(fail)throw new Error('quota');Object.assign(data,structuredClone(v));},async remove(k){delete data[k];}};
 const store=createTaskStore({storage:{session:area}});
 const a={taskId:'a',tabId:1,origin:'https://one.test',goal:'First',updatedAt:1,token:'private',status:'ended',pending:{plan:{action:'click'}},results:[{result:'first only'}]};
 await store.set(1,a);await store.set(1,{...a,updatedAt:2});
 assert.equal((await store.history(1,a.origin)).length,1);
 await store.set(1,{...a,taskId:'b',goal:'Second',updatedAt:3,results:[]});
 assert.deepEqual((await store.history(1,a.origin)).map(t=>t.taskId),['b','a']);
 const old=await store.historyGet(1,a.origin,'a');assert.equal(old.results[0].result,'first only');assert.equal(old.token,undefined);assert.equal(old.pending,undefined);
 assert.deepEqual((await store.get(1)).results,[]);assert.equal((await store.list()).length,1);
 assert.equal((await store.history(2,a.origin)).length,0);assert.equal((await store.history(1,'https://other.test')).length,0);
 await assert.rejects(store.historyGet(1,'https://other.test','a'));
 fail=true;await assert.rejects(store.set(1,{...a,taskId:'c'}),/quota/);fail=false;
 assert.equal((await store.get(1)).taskId,'b');assert.equal((await store.history(1,a.origin)).length,2);
 await store.remove(1);assert.equal((await store.history(1,a.origin)).length,1);
 await store.removeHistory(1);assert.equal((await store.history(1,a.origin)).length,0);
});
test('legacy goals migrate once as paused tasks, with old records removed',async()=>{
 const data={'chat:4':{origin:'https://example.test',state:{goal:'继续',steps:17,active:true}},other:{secret:'untouched'}};
 const chrome={storage:{session:{async get(k){return structuredClone(k===null?data:{[k]:data[k]});},async set(v){Object.assign(data,structuredClone(v));},async remove(k){delete data[k];}}}};
 const store=createTaskStore(chrome);await store.migrate();const t=await store.get(4);
 assert.equal(t.status,'paused');assert.equal(t.steps,17);assert.equal(t.goal,'继续');assert.equal(data['chat:4'],undefined);
 await store.migrate();assert.equal((await store.get(4)).taskId,t.taskId);assert.equal((await store.list()).length,1);
 assert.equal(data.other.secret,'untouched');
 await store.setMemory(4,'https://example.test',[{id:'answer',text:'用户更正'}]);
 assert.equal((await store.getMemory(4,'https://example.test'))[0].text,'用户更正');
 assert.equal((await store.getMemory(5,'https://example.test')).length,0);
 assert.equal((await store.getMemory(4,'https://other.test')).length,0);
 assert.equal((await store.list()).length,1);
 await store.removeMemory(4);assert.equal((await store.getMemory(4,'https://example.test')).length,0);
});

test('single-member task roots are authoritative and migration preserves unknown checkpoints and budget',async()=>{
 const old={version:2,taskId:'old',tabId:3,origin:'https://example.test',goal:'Work',status:'running',phase:'executing',steps:27,token:'original',pending:{plan:{action:'click'},documentId:'doc'},check:{kind:'action',deadline:12345,dispatch:'unknown',expected:[{kind:'url_equals',value:'https://example.test/next'}]},results:[],events:[]};
 const data={'task:3':old};const area={async get(k){return structuredClone(k===null?data:{[k]:data[k]});},async set(v){Object.assign(data,structuredClone(v));},async remove(k){delete data[k];}};
 const store=createTaskStore({storage:{session:area}});await store.migrate();const task=await store.get(3);
 assert.equal(data['task:3'],undefined);assert.equal(task.version,3);assert.equal(task.steps,27);assert.equal(task.token,'original');assert.deepEqual(task.check,old.check);assert.deepEqual(task.allowedOrigins,[old.origin]);assert.equal(task.members[0].kind,'initial');assert.equal(data.taskRegistry.bindings[3].taskId,'old');
 data['task:3']={...old,steps:0};assert.equal((await store.get(3)).steps,27);
 await assert.rejects(()=>store.set(4,{...task,tabId:4}),/其他标签/);assert.equal((await store.list()).length,1);
 await store.migrate();assert.equal(data['task:3'],undefined);assert.equal((await store.get(3)).steps,27);
});

test('interrupted ownership publication fails closed and reconciles only to a paused checkpoint',async()=>{
 for(const failAfterRoot of [false,true]){
  const data={};let fail=false;
  const area={async get(k){return structuredClone(k===null?data:{[k]:data[k]});},async set(v){if(fail&&Object.keys(v).some(k=>k.startsWith('taskRoot:'))){if(failAfterRoot)for(const [k,value] of Object.entries(v))if(k.startsWith('taskRoot:'))data[k]=structuredClone(value);throw Error('interrupted');}Object.assign(data,structuredClone(v));},async remove(k){delete data[k];}};
  const store=createTaskStore({storage:{session:area}}),task={taskId:'first',tabId:1,origin:'https://one.test',goal:'First',status:'running',phase:'executing',steps:12,check:{kind:'action',deadline:9876,dispatch:'unknown'},pending:{plan:{action:'click'}},results:[],events:[]};
  await store.set(1,task);fail=true;await assert.rejects(()=>store.set(1,{...task,taskId:'second',goal:'Second'}),/interrupted/);
  await assert.rejects(()=>store.get(1),e=>e.code==='TASK_SCOPE_INCONSISTENT');fail=false;
  const restored=createTaskStore({storage:{session:area}});await restored.migrate();const current=await restored.get(1);
  assert.equal(current.taskId,failAfterRoot?'second':'first');assert.equal(current.status,'paused');assert.equal(current.reason,'scope_reconciled');assert.equal(current.steps,12);assert.equal(current.check.deadline,9876);assert.equal(current.check.dispatch,'unknown');assert.equal(data.taskRegistry.pending,undefined);
  if(failAfterRoot)assert.equal((await restored.historyGet(1,task.origin,'first')).goal,'First');
 }
});

test('separate store instances serialize single-member ownership claims',async()=>{
 const data={},area={async get(k){return structuredClone(k===null?data:{[k]:data[k]});},async set(v){await new Promise(r=>setImmediate(r));Object.assign(data,structuredClone(v));},async remove(k){delete data[k];}},chrome={storage:{session:area}};
 const first=createTaskStore(chrome),second=createTaskStore(chrome),task={taskId:'shared',tabId:1,origin:'https://one.test',goal:'Work',status:'paused',steps:1,results:[],events:[]};
 const results=await Promise.allSettled([first.set(1,task),second.set(2,{...task,tabId:2})]);assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');assert.equal(Object.keys(data.taskRegistry.bindings).length,1);assert.equal((await first.list()).length,1);
});

test('task identity lookup follows only committed current ownership',async()=>{
 const data={},area={async get(k){return structuredClone(k===null?data:{[k]:data[k]});},async set(v){Object.assign(data,structuredClone(v));},async remove(k){delete data[k];}};
 const store=createTaskStore({storage:{session:area}}),task={taskId:'first',tabId:7,origin:'https://one.test',goal:'Work',status:'paused',steps:3};
 await store.set(7,task);assert.equal((await store.getByTaskId('first')).tabId,7);await store.set(7,{...task,taskId:'second'});assert.equal(await store.getByTaskId('first'),null);assert.equal((await store.getByTaskId('second')).taskId,'second');await store.remove(7);assert.equal(await store.getByTaskId('second'),null);
});


test('new tasks and checkpoints store one payload and invalid roots retain legacy migration evidence',async()=>{
 const data={},writes=[],area={async get(k){return structuredClone(k===null?data:{[k]:data[k]});},async set(v){writes.push(...Object.keys(v));Object.assign(data,structuredClone(v));},async remove(k){delete data[k];}};
 const store=createTaskStore({storage:{session:area}}),task={taskId:'one',tabId:1,origin:'https://one.test',goal:'Work',status:'paused',steps:1};
 await store.set(1,task);await store.set(1,{...await store.get(1),steps:2});assert.equal(data['task:1'],undefined);assert.equal(writes.includes('task:1'),false);assert.equal((await store.get(1)).steps,2);
 data['task:1']=task;delete data['taskRoot:one'];await assert.rejects(()=>store.migrate(),e=>e.code==='TASK_SCOPE_INCONSISTENT');assert.deepEqual(data['task:1'],task);
});


test('last member close ends only its task, preserves unknown evidence, and never deletes independent history',async()=>{
 const data={},area={async get(k){return structuredClone(k===null?data:{[k]:data[k]});},async set(v){Object.assign(data,structuredClone(v));},async remove(k){delete data[k];}};
 const store=createTaskStore({storage:{session:area}}),task={taskId:'closing',tabId:1,origin:'https://one.test',status:'waiting_page',phase:'verifying',steps:24,token:'private',pending:{plan:{action:'click'}},check:{kind:'action',deadline:123,dispatch:'unknown'},results:[]};
 await store.set(1,task);await store.set(2,{...task,taskId:'independent',tabId:2});await store.setMemory(1,task.origin,[{text:'temporary'}]);await store.setMemory(2,task.origin,[{text:'other'}]);
 assert.equal(await store.closeMember(1,'obsolete',99),null);assert.equal((await store.get(1)).status,'waiting_page');
 const ended=await store.closeMember(1,'closing',100);assert.equal(ended.status,'ended');assert.equal(ended.reason,'member_closed');assert.deepEqual(ended.members,[]);assert.equal(ended.activeTabId,null);assert.equal(ended.token,undefined);assert.equal(ended.steps,24);assert.deepEqual(ended.check,task.check);
 assert.equal(await store.get(1),null);assert.equal(await store.getByTaskId('closing'),null);assert.equal(data.taskRegistry.bindings[1],undefined);assert.deepEqual(await store.getMemory(1,task.origin),[]);assert.equal((await store.getMemory(2,task.origin))[0].text,'other');assert.equal((await store.get(2)).taskId,'independent');
 assert.equal((await store.history(1,task.origin))[0].status,'ended');assert.equal((await store.historyGet(1,task.origin,'closing')).pending,undefined);assert.equal(await store.closeMember(1,'closing',101),null);
});

test('interrupted close intent finishes only storage cleanup at startup without reopening a task',async()=>{
 for(const stage of ['archive','memory','commit']){
  const data={};let fail=false;
  const area={async get(k){return structuredClone(k===null?data:{[k]:data[k]});},async set(v){if(fail&&(stage==='archive'&&Object.keys(v).some(k=>k.startsWith('conversation:'))||stage==='commit'&&v.taskRegistry&&!v.taskRegistry.pending))throw Error('interrupted');Object.assign(data,structuredClone(v));},async remove(k){if(fail&&stage==='memory'&&k==='memory:1')throw Error('interrupted');delete data[k];}};
  const store=createTaskStore({storage:{session:area}}),task={taskId:'closing',tabId:1,origin:'https://one.test',status:'running',phase:'executing',steps:49,token:'secret',pending:{plan:{action:'click'}},check:{kind:'action',deadline:9876,dispatch:'unknown'}};
  await store.set(1,task);await store.setMemory(1,task.origin,[{text:'temporary'}]);fail=true;await assert.rejects(()=>store.closeMember(1,task.taskId,500),/interrupted/);await assert.rejects(()=>store.get(1),e=>e.code==='TASK_SCOPE_INCONSISTENT');
  fail=false;const restarted=createTaskStore({storage:{session:area}});await restarted.migrate();assert.equal(await restarted.get(1),null);assert.deepEqual(await restarted.list(),[]);assert.equal(data.taskRegistry.pending,undefined);assert.equal(data['memory:1'],undefined);
  const archive=data['conversation:1:closing'];assert.equal(archive.status,'ended');assert.equal(archive.updatedAt,500);assert.equal(archive.steps,49);assert.deepEqual(archive.check,task.check);assert.deepEqual(archive.pending,task.pending);assert.equal(archive.token,undefined);
 }
});


test('only revision-checked scope mutations change exact origin grants, while checkpoints preserve authority',async()=>{
 const data={},area={async get(k){return structuredClone(k===null?data:{[k]:data[k]});},async set(v){Object.assign(data,structuredClone(v));},async remove(k){delete data[k];}};
 const store=createTaskStore({storage:{session:area}}),task={taskId:'scope',tabId:1,origin:'https://one.test',status:'running',phase:'executing',steps:28,token:'old',pending:{plan:{action:'click'}},check:{kind:'action',deadline:12345,dispatch:'unknown'}};
 await store.set(1,{...task,allowedOrigins:['https://evil.test']});let current=await store.get(1);assert.deepEqual(current.allowedOrigins,[task.origin]);
 await store.set(1,{...current,allowedOrigins:['https://evil.test'],initialOrigin:'https://evil.test'});current=await store.get(1);assert.deepEqual(current.allowedOrigins,[task.origin]);assert.equal(current.initialOrigin,task.origin);
 const operation={taskId:task.taskId,expectedRevision:current.scopeRevision,action:'add',origin:'https://one.test:8443',token:'new',updatedAt:100};
 const changed=await store.changeOrigins(1,operation);assert.deepEqual(changed.allowedOrigins,[task.origin,operation.origin]);assert.ok(changed.scopeRevision>current.scopeRevision);assert.equal(changed.status,'paused');assert.equal(changed.reason,'scope_changed');assert.equal(changed.steps,28);assert.equal(changed.token,'new');assert.deepEqual(changed.check,task.check);assert.deepEqual(changed.pending,task.pending);
 await assert.rejects(()=>store.changeOrigins(1,operation),e=>e.code==='TASK_SCOPE_INCONSISTENT');await store.set(1,{...changed,allowedOrigins:[]});assert.deepEqual((await store.get(1)).allowedOrigins,changed.allowedOrigins);
 const removed=await store.changeOrigins(1,{...operation,action:'remove',origin:task.origin,expectedRevision:changed.scopeRevision});assert.deepEqual(removed.allowedOrigins,[operation.origin]);
 for(const origin of ['https://one.test/path','https://one.test/','https://user:secret@one.test','https://*.one.test','file:///tmp','https://one.test#x'])await assert.rejects(()=>store.changeOrigins(1,{...operation,origin,expectedRevision:removed.scopeRevision}));
 await assert.rejects(()=>store.set(1,{...removed,origin:'https://elsewhere.test'}),e=>e.code==='TASK_SCOPE_INCONSISTENT');
});

test('scope publication interruption reconciles to a paused old or new scope and keeps original check deadline',async()=>{
 for(const rootWritten of [false,true]){
  const data={};let fail=false;const area={async get(k){return structuredClone(k===null?data:{[k]:data[k]});},async set(v){if(fail&&Object.keys(v).some(k=>k.startsWith('taskRoot:'))){if(rootWritten)Object.assign(data,structuredClone(v));throw Error('interrupted');}Object.assign(data,structuredClone(v));},async remove(k){delete data[k];}};
  const store=createTaskStore({storage:{session:area}}),task={taskId:'scope',tabId:1,origin:'https://one.test',status:'running',phase:'executing',steps:49,token:'old',check:{kind:'action',deadline:321,dispatch:'unknown'},pending:{plan:{action:'click'}}};
  await store.set(1,task);const current=await store.get(1);fail=true;await assert.rejects(()=>store.changeOrigins(1,{taskId:'scope',expectedRevision:current.scopeRevision,action:'add',origin:'https://two.test',token:'new',updatedAt:100}),/interrupted/);await assert.rejects(()=>store.get(1),e=>e.code==='TASK_SCOPE_INCONSISTENT');fail=false;
  const restarted=createTaskStore({storage:{session:area}});await restarted.migrate();const recovered=await restarted.get(1);assert.equal(recovered.status,'paused');assert.equal(recovered.reason,'scope_reconciled');assert.equal(recovered.check.deadline,321);assert.equal(recovered.steps,49);assert.deepEqual(recovered.allowedOrigins,rootWritten?[task.origin,'https://two.test']:[task.origin]);
 }
});


test('task origin scope is bounded without evicting earlier explicit grants',async()=>{
 const data={},area={async get(k){return structuredClone(k===null?data:{[k]:data[k]});},async set(v){Object.assign(data,structuredClone(v));},async remove(k){delete data[k];}};
 const store=createTaskStore({storage:{session:area}});await store.set(1,{taskId:'scope-limit',tabId:1,origin:'https://initial.test',status:'paused',token:'old'});
 for(let i=1;i<16;i++){const task=await store.get(1);await store.changeOrigins(1,{taskId:task.taskId,expectedRevision:task.scopeRevision,action:'add',origin:'https://site'+i+'.test',token:'new',updatedAt:100});}
 const before=await store.get(1);await assert.rejects(()=>store.changeOrigins(1,{taskId:before.taskId,expectedRevision:before.scopeRevision,action:'add',origin:'https://overflow.test',token:'new',updatedAt:101}),/16/);assert.deepEqual(await store.get(1),before);
});
