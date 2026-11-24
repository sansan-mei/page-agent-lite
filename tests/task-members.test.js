const {test}=require('node:test');const assert=require('node:assert/strict');
const {createTaskStore}=require('../extension/task-store.js');const {createRuntime}=require('../extension/runtime.js');

function memoryArea(hooks={}){
 const data={};
 const area={async get(k){return structuredClone(k===null?data:{[k]:data[k]});},async set(v){if(hooks.set)hooks.set(v,data);Object.assign(data,structuredClone(v));},async remove(k){delete data[k];}};
 return {data,area,store:createTaskStore({storage:{session:area}})};
}
const base=(taskId,tabId,extra={})=>({taskId,tabId,origin:'https://a.test',goal:'Goal '+taskId,status:'running',phase:'observe',steps:3,token:'tok-'+taskId,results:[],events:[],updatedAt:1,...extra});
const join=(store,id,task,memberTabId)=>store.changeMembers(id,{taskId:task.taskId,expectedMembersRevision:task.membersRevision??0,action:'join',memberTabId,updatedAt:10});

test('joining a tab records an owned directory entry without touching execution identity or checkpoints',async()=>{
 const {data,store}=memoryArea();
 const check={kind:'action',deadline:9876,dispatch:'unknown',expected:[{kind:'url_equals',value:'https://a.test/next'}]};
 await store.set(1,base('task',1,{phase:'executing',check,pending:{plan:{action:'click'}}}));
 const before=await store.get(1);assert.equal(before.membersRevision,0);assert.equal(before.memberSeq,1);
 const joined=await join(store,1,before,2);
 assert.deepEqual(joined.members.map(m=>[m.tabId,m.tabRef,m.kind]),[[1,'tab0','initial'],[2,'tab1','user_joined']]);
 assert.equal(joined.scopeRevision,before.scopeRevision);assert.equal(joined.token,before.token);assert.deepEqual(joined.check,check);assert.equal(joined.status,'running');assert.equal(joined.phase,'executing');
 assert.equal(data.taskRegistry.tabOwners[2].taskId,'task');assert.equal(data.taskRegistry.pending,undefined);assert.equal(data.taskRegistry.bindings[1].revision,before.scopeRevision);
 assert.deepEqual(await store.owner(2),{taskId:'task',taskTabId:1,role:'member'});assert.equal(await store.get(2),null);
 // A stale runtime object cannot drop the directory: members come from storage.
 await store.set(1,{...before,steps:4});const after=await store.get(1);assert.equal(after.steps,4);assert.equal(after.members.length,2);assert.equal(after.memberSeq,2);
});

test('a tab belongs to at most one unfinished task; occupied, duplicate, self and stale joins are rejected',async()=>{
 const {data,store}=memoryArea();
 await store.set(1,base('a',1));await store.set(3,base('b',3));
 let a=await store.get(1);a=await join(store,1,a,2);
 await assert.rejects(()=>store.set(2,base('c',2)),e=>e.code==='TAB_OWNED');assert.equal(await store.get(2),null);
 const b=await store.get(3);
 await assert.rejects(()=>join(store,3,b,2),e=>e.code==='TAB_OWNED');
 await assert.rejects(()=>join(store,3,b,1),e=>e.code==='TAB_OWNED');
 await assert.rejects(()=>join(store,1,a,3),e=>e.code==='TAB_OWNED');
 await assert.rejects(()=>join(store,1,a,1),/无效/);
 await assert.rejects(()=>store.changeMembers(1,{taskId:'a',expectedMembersRevision:0,action:'join',memberTabId:9,updatedAt:1}),e=>e.code==='MEMBERS_CHANGED');
 assert.deepEqual(Object.keys(data.taskRegistry.tabOwners),['2']);assert.deepEqual((await store.get(3)).members.map(m=>m.tabId),[3]);
 for(let tab=10;tab<16;tab++)a=await join(store,1,a,tab);
 await assert.rejects(()=>join(store,1,a,20),/最多 8/);
 const ended=await store.get(1);await store.set(1,{...ended,status:'ended'});const endedTask=await store.get(1);
 await assert.rejects(()=>join(store,1,endedTask,21),e=>e.code==='TASK_SCOPE_INCONSISTENT');
});

test('remove releases only joined members, keeps tab refs unique, and never removes the executing tab',async()=>{
 const {data,store}=memoryArea();
 await store.set(1,base('a',1));let a=await join(store,1,await store.get(1),2);a=await join(store,1,a,3);
 await assert.rejects(()=>store.changeMembers(1,{taskId:'a',expectedMembersRevision:a.membersRevision,action:'remove',tabRef:'tab0',updatedAt:2}),/执行/);
 a=await store.changeMembers(1,{taskId:'a',expectedMembersRevision:a.membersRevision,action:'remove',tabRef:'tab2',updatedAt:3});
 assert.deepEqual(a.members.map(m=>m.tabRef),['tab0','tab1']);assert.equal(data.taskRegistry.tabOwners[3],undefined);assert.equal(data.taskRegistry.tabOwners[2].taskId,'a');
 a=await join(store,1,a,3);assert.equal(a.members.at(-1).tabRef,'tab3');
 await store.set(3,base('x',3)).then(()=>assert.fail('owned tab accepted a task'),e=>assert.equal(e.code,'TAB_OWNED'));
 await assert.rejects(()=>store.changeMembers(1,{taskId:'a',expectedMembersRevision:a.membersRevision,action:'remove',tabRef:'tab9',updatedAt:4}),e=>e.code==='MEMBERS_CHANGED');
});

test('replacing, clearing or closing the executing tab releases every joined member',async()=>{
 for(const mode of ['replace','remove','close']){
  const {data,store}=memoryArea();
  await store.set(1,base('a',1));await join(store,1,await store.get(1),2);
  if(mode==='replace')await store.set(1,base('next',1));
  if(mode==='remove')await store.remove(1);
  if(mode==='close'){const ended=await store.closeMember(1,'a',50);assert.equal(ended.reason,'member_closed');assert.deepEqual(ended.members,[]);}
  assert.deepEqual(data.taskRegistry.tabOwners,{},mode);assert.equal(await store.owner(2),null,mode);
  await store.set(2,base('free',2));assert.equal((await store.get(2)).taskId,'free',mode);
 }
});

test('interrupted member publication reconciles to exactly one consistent owner set without pausing the task',async()=>{
 for(const stage of ['root','commit']){
  let fail=false;
  const {data,store}=memoryArea({set(v){if(!fail)return;if(stage==='root'&&Object.keys(v).some(k=>k.startsWith('taskRoot:'))||stage==='commit'&&v.taskRegistry&&!v.taskRegistry.pending)throw Error('interrupted');}});
  await store.set(1,base('a',1));const before=await store.get(1);fail=true;
  await assert.rejects(()=>join(store,1,before,2),/interrupted/);fail=false;
  assert.equal(data.taskRegistry.pending.kind,'members_changed');
  assert.equal((await store.get(1)).taskId,'a',stage+': executing tab stays readable during a directory journal');
  await assert.rejects(()=>store.set(5,base('blocked',5)),e=>e.code==='TASK_SCOPE_INCONSISTENT');
  const restarted=createTaskStore({storage:{session:{get:k=>structuredClone(k===null?data:{[k]:data[k]}),set:async v=>Object.assign(data,structuredClone(v)),remove:async k=>{delete data[k];}}}});
  await restarted.migrate();const task=await restarted.get(1);
  assert.equal(data.taskRegistry.pending,undefined);assert.equal(task.status,'running');assert.equal(task.token,before.token);
  const owned=!!data.taskRegistry.tabOwners[2],listed=task.members.some(m=>m.tabId===2);
  assert.equal(owned,listed,stage);assert.equal(listed,stage==='commit',stage);
 }
});

test('startup prunes owners of tasks that are no longer bound',async()=>{
 const {data,store}=memoryArea();await store.set(1,base('a',1));await join(store,1,await store.get(1),2);
 data.taskRegistry={...data.taskRegistry,tabOwners:{...data.taskRegistry.tabOwners,7:{taskId:'gone',revision:1}}};
 await store.migrate();assert.deepEqual(Object.keys(data.taskRegistry.tabOwners),['2']);
});

function runtimeFixture(options={}){
 const {data,store}=memoryArea();let seq=0;const scheduled=[],executed=[];let open=options.open||[1,2,3,4];
 const tabs={1:{id:1,url:'https://a.test/1',title:'Task tab'},2:{id:2,url:'https://b.test/x',title:'<img src=x onerror=alert(1)>'},3:{id:3,url:'chrome://settings',title:'Settings'},4:{id:4,url:'https://a.test/other',title:'Other A'}};
 const tools={async tab(id){if(!open.includes(id))throw Object.assign(new Error('目标标签页已关闭'),{code:'TAB_CLOSED'});return {...tabs[id],status:'complete'};},async listTabs(){return open.map(id=>tabs[id]);},async existingTabIds(){return open;},async hasOriginAccess(){return true;},
  async observe(){return {url:'https://a.test/1',documentId:'d',snapshotId:'s',page:{text:'Page',elements:[{id:'t0',tag:'input',label:'Field'}]}};},async execute(id,p){executed.push([id,p]);return {version:2,status:'success',dispatch:'sent',scope:'ui',code:'CONDITIONS_MATCH',recovery:'none'};},...options.tools};
 const runtime=createRuntime({store,tools,summarize:async()=>({text:'{}'}),schedule:(id,delay)=>scheduled.push({id,delay}),cancelSchedule:async()=>{},uuid:()=>'u'+(++seq),preferences:async()=>({maxSteps:50,contextTokens:32768}),model:async()=>({text:'{"reply":"完成","action":"done"}'}),...options});
 return {data,store,runtime,executed,scheduled,setOpen:value=>{open=value;}};
}

test('side-panel directory lists only web tabs, marks occupancy, and joining mid-request does not abort or fail the running task',async()=>{
 let resolve,signal;const f=runtimeFixture({model:async(text,s)=>{signal=s;return new Promise(r=>resolve=r);}});
 await f.runtime.start(1,'Work');const tick=f.runtime.tick(1);while(!resolve)await new Promise(r=>setImmediate(r));
 let task=await f.store.get(1);const view=await f.runtime.members(1,task.taskId);
 assert.deepEqual(view.members.map(m=>[m.tabRef,m.kind,m.active]),[['tab0','initial',true]]);
 assert.deepEqual(view.candidates.map(c=>[c.tabId,c.origin,c.authorized,c.occupied]),[[2,'https://b.test',false,false],[4,'https://a.test',true,false]]);
 assert.equal(view.candidates[0].title.length<=80,true);
 await assert.rejects(()=>f.runtime.changeMembers(1,{taskId:task.taskId,expectedMembersRevision:5,action:'join',memberTabId:2}),/已变化/);
 await assert.rejects(()=>f.runtime.changeMembers(1,{taskId:task.taskId,expectedMembersRevision:0,action:'join',memberTabId:3}),/不支持/);
 await assert.rejects(()=>f.runtime.changeMembers(1,{taskId:task.taskId,expectedMembersRevision:0,action:'join',memberTabId:9}),/关闭/);
 task=await f.runtime.changeMembers(1,{taskId:task.taskId,expectedMembersRevision:0,action:'join',memberTabId:2});
 assert.equal(signal.aborted,false);resolve({text:'{"reply":"Fill","action":"fill","id":"t0","value":"x"}'});await tick;
 const after=await f.store.get(1);assert.equal(after.status,'running');assert.equal(after.members.length,2);assert.deepEqual(f.executed.map(x=>x[0]),[1]);
 await f.runtime.start(4,'Other');const otherId=(await f.store.get(4)).taskId,other=await f.runtime.members(4,otherId);
 assert.equal(other.candidates.find(c=>c.tabId===2).occupied,true);assert.equal(other.candidates.find(c=>c.tabId===1).occupied,true);
 await assert.rejects(()=>f.runtime.changeMembers(4,{taskId:otherId,expectedMembersRevision:0,action:'join',memberTabId:2}),e=>e.code==='TAB_OWNED');
 await assert.rejects(()=>f.runtime.changeMembers(1,{taskId:after.taskId,expectedMembersRevision:after.membersRevision,action:'remove',tabRef:'../tab1'}),/标识无效/);
});

test('closing a joined tab only leaves the directory; startup drops missing members from the ID inventory',async()=>{
 const f=runtimeFixture();await f.runtime.start(1,'Work');let task=await f.store.get(1);
 task=await f.runtime.changeMembers(1,{taskId:task.taskId,expectedMembersRevision:0,action:'join',memberTabId:2});
 task=await f.runtime.changeMembers(1,{taskId:task.taskId,expectedMembersRevision:task.membersRevision,action:'join',memberTabId:4});
 await f.runtime.memberClosed(2);let current=await f.store.get(1);
 assert.equal(current.status,'running');assert.equal(current.token,task.token);assert.deepEqual(current.members.map(m=>m.tabId),[1,4]);assert.equal(f.data.taskRegistry.tabOwners[2],undefined);
 assert.equal(await f.runtime.memberClosed(2),null);
 f.setOpen([1]);await f.runtime.recover();current=await f.store.get(1);
 assert.deepEqual(current.members.map(m=>m.tabId),[1]);assert.deepEqual(f.data.taskRegistry.tabOwners,{});assert.equal(current.status,'running');
});
