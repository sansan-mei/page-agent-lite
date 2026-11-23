const {test}=require('node:test');const assert=require('node:assert/strict');
const {createTaskStore}=require('../extension/task-store.js');
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
