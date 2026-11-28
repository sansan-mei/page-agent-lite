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
      const notes=old.notes.filter(n=>p.action==='clear'?false:n.id!==p.id);if(p.action==='write')notes.push({id:p.id,...(p.description?{description:p.description,sites:p.sites||[],from:p.from??null}:{}),text:p.text,source:p.source});
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

test('starting a new chat right after completion lets the running review finish and save',async()=>{
  let release,signalSeen;const gate=new Promise(r=>{release=r;});
  const f=fixture({review:async(text,signal)=>{signalSeen=signal;await gate;return {text:JSON.stringify({notes:[{scope:'site',action:'write',id:'flow',text:'Save button at the bottom; verified.'}]})};}});
  await f.runtime.start(1,'Save the form');await f.runtime.tick(1);
  const ticking=f.runtime.tick(1);
  while(!signalSeen)await new Promise(r=>setImmediate(r));
  await f.runtime.remove(1);assert.equal(signalSeen.aborted,false);assert.equal(await f.runtime.get(1),null);
  await f.runtime.start(1,'Next task');assert.equal(signalSeen.aborted,false,'a new task on the same tab does not cancel the detached review');
  release();await ticking;
  assert.deepEqual((await f.siteMemory.read('https://example.test')).notes.map(n=>n.id),['flow']);
  assert.equal((await f.runtime.get(1)).goal,'Next task');
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
  assert.deepEqual(P.parseReview('{"notes":[]}'),{notes:[],skills:[]});
  assert.deepEqual(P.parseReview('{}'),{notes:[],skills:[]});
  assert.deepEqual(P.parseReview('{"notes":[{"scope":"site","action":"delete","id":"old","text":"ignored"}]}'),{notes:[{scope:'site',action:'delete',id:'old'}],skills:[]});
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

test('parseReview accepts at most two well-formed skill operations with optional sites',()=>{
  assert.deepEqual(P.parseReview('{"skills":[{"action":"write","id":"export","description":" Export orders ","text":"1. Open Orders"}]}').skills,[{action:'write',id:'export',description:'Export orders',sites:[],text:'1. Open Orders'}]);
  assert.deepEqual(P.parseReview('{"skills":[{"action":"write","id":"export","description":"d","sites":["https://a.test","https://a.test"],"text":"t"}]}').skills[0].sites,['https://a.test']);
  const skill=(o={})=>({action:'write',id:'s',description:'d',text:'t',...o});
  for(const skills of [[skill(),skill({id:'b'}),skill({id:'c'})],[skill({description:''})],[skill({description:'x'.repeat(201)})],[skill({text:'x'.repeat(4001)})],[skill(),skill()],[skill({extra:1})],[skill({action:'clear'})],
    [skill({sites:'https://a.test'})],[skill({sites:['https://a.test/path']})],[skill({sites:['javascript:alert(1)']})],[skill({sites:Array.from({length:9},(_,i)=>'https://s'+i+'.test')})],[{action:'delete',id:'s',sites:[]}]])
    assert.throws(()=>P.parseReview(JSON.stringify({skills})),/复盘结果格式无效/);
  assert.throws(()=>P.parseReview(JSON.stringify({skills:[skill()]}),{site:true,global:true,skill:false}),/技能库不可用/);
});

test('skillIndex lists the current origin first, then general skills, then other sites, with descriptions only',()=>{
  const notes=[{id:'other',description:'o',sites:['https://b.test'],text:'x'},{id:'general',description:'g',sites:[],text:'x'},{id:'here',description:'h',sites:['https://a.test'],text:'x'}];
  assert.deepEqual(P.skillIndex(notes,'https://a.test'),[{id:'here',description:'h',sites:['https://a.test']},{id:'general',description:'g'},{id:'other',description:'o',sites:['https://b.test']}]);
});

test('reviewInput gives full text only for skills this task could touch',()=>{
  const library={version:1,notes:[{id:'here',description:'h',sites:['https://a.test'],text:'HERE'},{id:'general',description:'g',sites:[],text:'GENERAL'},{id:'other',description:'o',sites:['https://b.test'],text:'OTHER'},{id:'used',description:'u',sites:['https://c.test'],text:'USED'}]};
  const task={origin:'https://a.test',goal:'g',results:[{action:'skill_read',request:{action:'skill_read',id:'used'},result:{}}]};
  const skills=JSON.parse(P.reviewInput(task,null,null,library)).skills;
  assert.deepEqual(skills.map(k=>[k.id,k.text]),[['here','HERE'],['general','GENERAL'],['other',null],['used','USED']]);
  assert.deepEqual(skills[2].sites,['https://b.test']);
});

test('a skill saved by the review on one site is listed and readable on another site, flagged as cross-site',async()=>{
  const skills=memory();let payload,turn=0,url='https://a.test/1';
  const plans=[{reply:'Click',action:'click',id:'t0'},{reply:'完成',action:'done'},{reply:'read',action:'skill_read',id:'save_form'},{reply:'Click',action:'click',id:'t0'},{reply:'完成',action:'done'}];
  const data=new Map();let seq=0;
  const store={async get(id){return structuredClone(data.get(id)||null);},async set(id,t){data.set(id,structuredClone(t));},async remove(id){data.delete(id);},async list(){return [...data.values()].map(t=>structuredClone(t));}};
  const tools={async tab(id){return {id,url,status:'complete'};},async observe(){return {url,snapshotId:'s',page:{text:'Q',elements:[{id:'t0',label:'Save',tag:'button'}]}};},
    async execute(){return {version:2,status:'success',dispatch:'sent',scope:'ui',code:'CONDITIONS_MATCH',recovery:'none',message:'Matched'};}};
  let reviews=0;
  const runtime=createRuntime({store,tools,siteMemory:memory(),globalMemory:memory(),skills,schedule:()=>{},cancelSchedule:async()=>{},uuid:()=>String(++seq),preferences:async()=>({maxSteps:50}),
    model:async text=>{payload=JSON.parse(text);return {text:JSON.stringify(plans[turn++])};},
    review:async text=>{const input=JSON.parse(text);reviews++;
      if(reviews===1){assert.deepEqual(input.skills,[]);return {text:JSON.stringify({skills:[{action:'write',id:'save_form',description:'Saving the profile form',sites:['https://a.test'],text:'1. Click Save at the bottom\n2. Check the toast'}]})};}
      assert.equal(input.skills[0].id,'save_form');assert.match(input.skills[0].text,/Click Save/,'a skill read in this task keeps its text');assert.ok(input.results.some(r=>r.action==='skill_read'));return {text:'{"notes":[]}'};}});
  await runtime.start(1,'Save the form');await runtime.tick(1);await runtime.tick(1);
  assert.match((await runtime.get(1)).events.at(-1).text,/保存技能 save_form/);
  const saved=(await skills.read(null)).notes[0];
  assert.deepEqual([saved.source,saved.sites,saved.from],['model',['https://a.test'],'https://a.test']);
  await runtime.finish(1);url='https://b.test/1';await runtime.start(1,'Save it again');await runtime.tick(1);
  assert.deepEqual(payload.skillIndex,[{id:'save_form',description:'Saving the profile form',sites:['https://a.test']}]);assert.ok(!JSON.stringify(payload).includes('Click Save at the bottom'));
  const read=(await runtime.get(1)).results.at(-1).result;
  assert.match(read.skill.text,/Click Save/);assert.equal(read.crossSite,true);assert.equal(read.writtenOn,'https://a.test');
  await runtime.tick(1);await runtime.tick(1);assert.equal(reviews,2);assert.equal((await runtime.get(1)).reviewState,'done');
});

test('users can delete or clear skills but not write them from the management page',async()=>{
  const skills=memory();await skills.change(null,{action:'write',id:'a',description:'d',text:'t',expectedVersion:0});
  const runtime=createRuntime({store:{async get(){return null;},async set(){},async list(){return [];}},tools:{async tab(id){return {id,url:'https://example.test/x'};}},skills,schedule:()=>{},cancelSchedule:async()=>{},preferences:async()=>({}),model:async()=>({})});
  assert.equal((await runtime.getSkills()).notes.length,1);
  await assert.rejects(runtime.editSkills({action:'write',id:'b',expectedVersion:1}),/只能删除或清空/);
  await runtime.editSkills({action:'delete',id:'a',expectedVersion:1});
  assert.equal((await runtime.getSkills()).notes.length,0);
});

// Minimal IndexedDB double: enough of open/upgrade/transaction/get/getAll/put/abort/deleteObjectStore for site-memory.js.
function fakeIndexedDB(){
  const dbs=new Map();
  return {dbs,open(name,version){
    const request={};
    setImmediate(()=>{
      let record=dbs.get(name);const upgrade=!record||record.version<version;
      if(!record){record={version:0,stores:new Map()};dbs.set(name,record);}
      const db={close(){},objectStoreNames:{contains:n=>record.stores.has(n)},createObjectStore(n){record.stores.set(n,new Map());return {createIndex(){}};},deleteObjectStore(n){record.stores.delete(n);},
        transaction(n){
          const data=record.stores.get(n);if(!data)throw new Error('NotFoundError');
          const staged=new Map(data);let pending=0;
          const tx={aborted:false,abort(){if(tx.aborted)return;tx.aborted=true;setImmediate(()=>tx.onabort?.());},
            objectStore(){return {get(key){const r={};pending++;setImmediate(()=>{r.result=structuredClone(staged.get(key));r.onsuccess?.();if(--pending===0)setImmediate(finish);});return r;},put(value){staged.set(value.origin??value.scope,structuredClone(value));}};}};
          const finish=()=>{if(tx.aborted)return;for(const [k,v] of staged)data.set(k,v);tx.oncomplete?.();};
          return tx;
        }};
      // The versionchange transaction writes straight through; open succeeds after its queued requests.
      const upgradeTx={db,objectStore(n){const data=record.stores.get(n);return {getAll(){const r={};setImmediate(()=>{r.result=[...data.values()].map(v=>structuredClone(v));r.onsuccess?.();});return r;},put(value){data.set(value.origin??value.scope,structuredClone(value));}};}};
      request.result=db;request.transaction=upgradeTx;
      if(upgrade){record.version=version;request.onupgradeneeded?.();}
      setImmediate(()=>setImmediate(()=>request.onsuccess?.()));
    });
    return request;
  }};
}

test('skills live in one cross-site library with description, sites, size and count limits',async()=>{
  const {createSiteMemory}=require('../extension/site-memory.js');
  const factory=fakeIndexedDB(),skills=createSiteMemory({factory,scope:'skill',now:()=>5}),notes=createSiteMemory({factory});
  const saved=await skills.change(null,{action:'write',id:'export',description:' Export orders ',sites:['https://a.test','https://a.test'],from:'https://a.test',text:' 1. Open Orders ',expectedVersion:0,source:'model'});
  assert.deepEqual(saved,{scope:'skills',version:1,notes:[{id:'export',description:'Export orders',sites:['https://a.test'],from:'https://a.test',text:'1. Open Orders',source:'model',createdAt:5,updatedAt:5}]});
  const db=factory.dbs.get('page-agent-memory');assert.equal(db.version,6);assert.ok(db.stores.has('skillLibrary'));assert.ok(db.stores.has('attachments'));assert.ok(!db.stores.has('skills'));
  assert.equal((await notes.read('https://a.test')).notes.length,0,'skills do not appear among site notes');
  await assert.rejects(skills.change(null,{action:'write',id:'x',description:'',text:'t',expectedVersion:1}),/技能名称、适用说明或步骤无效/);
  await assert.rejects(skills.change(null,{action:'write',id:'x',description:'d',text:'x'.repeat(4001),expectedVersion:1}),/技能名称/);
  await assert.rejects(skills.change(null,{action:'write',id:'x',description:'d',text:'t',sites:['https://a.test/path'],expectedVersion:1}),/网站源无效/);
  const browser=await skills.change(null,{action:'write',id:'general',description:'d',text:'t',from:'browser',expectedVersion:1});
  assert.deepEqual([browser.notes[1].sites,browser.notes[1].from],[[],null]);
  let version=2;for(let i=0;i<30;i++)version=(await skills.change(null,{action:'write',id:'s'+i,description:'d',text:'t',expectedVersion:version})).version;
  await assert.rejects(skills.change(null,{action:'write',id:'s32',description:'d',text:'t',expectedVersion:version}),/技能容量已满/);
  assert.equal((await skills.read('https://other.test')).notes.length,32,'every origin reads the same library');
});

test('upgrading from v4 merges per-origin skills into the library with their origin as sites, newest first',async()=>{
  const {createSiteMemory}=require('../extension/site-memory.js');
  const factory=fakeIndexedDB();
  const skill=(id,updatedAt)=>({id,description:'d '+id,text:'t',source:'model',createdAt:1,updatedAt});
  factory.dbs.set('page-agent-memory',{version:4,stores:new Map([['sites',new Map()],['global',new Map()],['history',new Map()],['historyViews',new Map()],
    ['skills',new Map([['https://a.test',{origin:'https://a.test',version:2,notes:[skill('export',10),skill('login',30)]}],['https://b.test',{origin:'https://b.test',version:1,notes:[skill('export',20)]}]])]])});
  const library=await createSiteMemory({factory,scope:'skill'}).read(null);
  assert.equal(library.version,1);
  assert.deepEqual(library.notes.map(n=>[n.id,n.sites,n.from]),[['login',['https://a.test'],'https://a.test'],['export',['https://b.test'],'https://b.test'],['export_2',['https://a.test'],'https://a.test']]);
  assert.ok(!factory.dbs.get('page-agent-memory').stores.has('skills'));
});
