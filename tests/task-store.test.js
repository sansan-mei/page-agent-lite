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
 assert.equal(task.version,3);assert.equal(task.steps,27);assert.equal(task.token,'original');assert.deepEqual(task.check,old.check);assert.deepEqual(task.allowedOrigins,[old.origin]);assert.equal(task.members[0].kind,'initial');assert.equal(data.taskRegistry.bindings[3].taskId,'old');
 data['task:3']={...old,steps:0};assert.equal((await store.get(3)).steps,27);
 await assert.rejects(()=>store.set(4,{...task,tabId:4}),/其他标签/);assert.equal((await store.list()).length,1);
 await store.migrate();assert.equal((await store.get(3)).steps,27);
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
