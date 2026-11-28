const {test}=require('node:test');const assert=require('node:assert/strict');
const C=require('../extension/core.js');const P=require('../extension/prompts.js');
const backend=require('../extension/backend.js');
const {createRuntime}=require('../extension/runtime.js');
const {createAttachmentStore}=require('../extension/site-memory.js');

test('agentPlan: view_image takes viewport, a current element/region id or imageN, an optional question, never coordinates',()=>{
  const snap={nodes:new Map([['t0',true]])},plan=p=>C.agentPlan(JSON.stringify({reply:'look',action:'view_image',...p}),snap);
  for(const id of ['viewport','t0','r3','image2'])assert.equal(plan({id}).id,id);
  assert.equal(plan({id:'viewport',value:'What does the chart show?'}).value,'What does the chart show?');
  for(const bad of [{},{id:'t9'},{id:'10,20'},{id:'viewport',value:{x:10,y:20,width:5,height:5}},{id:'viewport',value:'x'.repeat(301)},{id:'viewport',clip:{x:1}},{id:'viewport',x:1,y:2},{id:'viewport',expected:[{kind:'url_changed'}]},{id:'image0'}])
    assert.throws(()=>plan(bad),undefined,JSON.stringify(bad));
  assert.equal(C.agentTool('view_image').route,'runtime');assert.equal(C.agentTool('view_image').effect,'read');
});

test('view_image is offered in both protocols with a terse schema',()=>{
  const tool=P.agentTools().find(t=>t.function.name==='view_image');
  assert.ok(tool);assert.deepEqual(Object.keys(tool.function.parameters.properties).sort(),['id','progress','reply','subgoals','value']);
  assert.deepEqual(tool.function.parameters.required,['reply','id']);assert.equal(tool.function.parameters.additionalProperties,false);
  assert.match(P.agentSystem('English','json'),/action \([^)]*\bview_image\b/);
  assert.match(P.agentSystem('English','native'),/view_image/);
  assert.ok(P.agentSystem('English','native').startsWith('You are Page Agent Lite'));
  const text=P.agentSystem('English','native')+JSON.stringify(P.agentTools({scripts:true}));
  assert.doesNotMatch(text,/hermes|nanobrowser|claude|chatgpt|openai/i);
});

// Runtime with an in-memory task store, a scripted page and image service.
function images(mode='supported',{present=null}={}){
  const calls=[],stored=new Map();let n=0;
  return {calls,stored,mode:async()=>typeof mode==='function'?mode():mode,
    async claim(ids){return ids.map(id=>({id,type:'image/jpeg',width:10,height:10,size:9}));},
    async recognize(source,goal,signal,question){calls.push(['recognize',typeof source==='string'?source:'data:'+source.data,goal,question]);return 'TEXT '+(question||'');},
    async saveShot(taskId,data){const id='shot_'+String(++n).padStart(8,'0');stored.set(id,{taskId,data});calls.push(['saveShot',taskId,data]);return id;},
    async dropShots(taskId,keep){calls.push(['dropShots',taskId,keep]);for(const id of [...stored.keys()])if(stored.get(id).taskId===taskId&&!keep.includes(id))stored.delete(id);},
    async present(ids){return (present?present(ids):ids.filter(id=>stored.has(id)));},
    async remove(taskId){calls.push(['remove',taskId]);},async prune(){}};
}
const {preapprove}=require('./real-input-helper.js');
function fixture(service,replies,{screenshot}={}){
  const data=new Map(),models=[],shots=[];let seq=0;
  const store={async get(id){return structuredClone(data.get(id)||null);},async set(id,t){data.set(id,structuredClone(t));},async remove(id){data.delete(id);},async list(){return [...data.values()].map(t=>structuredClone(t));}};
  const tools={async tab(id){return {id,url:'https://a.test/',status:'complete'};},
    async observe(){return {url:'https://a.test/',documentId:'d1',snapshotId:'s'+(++seq),page:{text:'page',elements:[{id:'t0',key:'k0',label:'Chart',tag:'canvas'}],regions:[{id:'r0',key:'k1',label:'Prices'}]}};},
    async screenshot(tabId,shot,policy){shots.push({tabId,shot,policy});if(screenshot)return screenshot(shot,policy);return {data:'SlBFRw==',masked:2,width:800,height:600};},
    async realInputEnabled(){return true;},async releaseInput(){return true;}};
  const make=()=>preapprove(createRuntime({store,tools,images:service,schedule:()=>{},cancelSchedule:async()=>{},uuid:()=>'id'+(++seq),preferences:async()=>({maxSteps:50}),
    model:async(text,signal,capabilities)=>{models.push({input:JSON.parse(text),images:capabilities.images,shots:capabilities.shots});const next=replies.shift();if(next instanceof Error)throw next;return {text:JSON.stringify(next||{reply:'ok',action:'done'})};}}),store);
  return {runtime:make(),make,models,shots,data,store};
}
const last=task=>task.results.at(-1);

test('vision model: the screenshot rides along with the next request only, after the attachments',async()=>{
  const service=images('supported');
  const f=fixture(service,[{reply:'look',action:'view_image',id:'t0',value:'Which bar is highest?'},{reply:'next',action:'observe'},{reply:'ok',action:'done'}]);
  await f.runtime.submit(1,'Read the chart',{attachments:['img_00000001']});
  await f.runtime.tick(1);
  let task=await f.runtime.get(1);
  assert.equal(f.shots.length,1);assert.deepEqual(f.shots[0].shot.id,'t0');assert.match(f.shots[0].shot.snapshotId,/^s\d+$/);
  assert.equal(f.shots[0].policy.taskId,task.taskId);assert.equal(f.shots[0].policy.sensitiveFields,false);
  assert.equal(last(task).outcome.code,'IMAGE_NEXT_TURN');assert.match(last(task).outcome.message,/下一轮.*progress/);
  assert.equal(last(task).outcome.observed.masked,2);assert.equal(task.status,'running');
  assert.deepEqual(task.shots.map(s=>[s.id,s.source,s.question,s.origin]),[['shot_00000001','t0','Which bar is highest?','https://a.test']]);
  assert.equal(JSON.stringify(task).includes('SlBFRw'),false,'no image data in the session task record');
  await f.runtime.tick(1);
  assert.deepEqual(f.models[1].images,['img_00000001']);assert.deepEqual(f.models[1].shots,['shot_00000001']);
  assert.deepEqual(f.models[1].input.screenshots,[{ref:'shot1',source:'t0',question:'Which bar is highest?',url:'https://a.test/'}]);
  task=await f.runtime.get(1);
  assert.deepEqual(task.shots,[]);assert.equal(service.stored.size,0,'sent screenshots are deleted');
  assert.ok(task.contextPressure.estimatedTokens>=2*P.IMAGE_TOKENS);
  await f.runtime.tick(1);
  assert.equal(f.models[2].shots,undefined,'never sent twice');assert.equal(f.models[2].input.screenshots,undefined);
});

test('pending screenshots: at most the newest 3, only for the current origin, reported when lost',async()=>{
  const service=images('supported');
  const f=fixture(service,[{reply:'look',action:'view_image',id:'viewport'}]);
  await f.runtime.start(1,'Look');
  // Seed screenshots that never reached a request (e.g. requests kept failing), one from another origin.
  let task=await f.store.get(1);
  for(const id of ['shot_a0000001','shot_a0000002','shot_a0000003'])service.stored.set(id,{taskId:task.taskId});
  task.shots=[{id:'shot_a0000001',source:'viewport',origin:'https://a.test'},{id:'shot_a0000002',source:'r0',origin:'https://a.test'},{id:'shot_a0000003',source:'viewport',origin:'https://b.test'},{id:'shot_gone0001',source:'t0',origin:'https://a.test'}];
  await f.store.set(1,task);
  await f.runtime.tick(1);
  assert.deepEqual(f.models[0].shots,['shot_a0000001','shot_a0000002'],'other origins and missing records are not sent');
  task=await f.runtime.get(1);
  const expired=task.results.find(r=>r.outcome?.code==='SHOT_EXPIRED');assert.ok(expired);assert.equal(expired.label,'t0');
  assert.deepEqual(task.shots.map(s=>s.id),['shot_00000001'],'sent ones are dropped, the new capture waits');
  assert.deepEqual([...service.stored.keys()],['shot_00000001']);
  // Three pending screenshots (the cap) all go into one request.
  task.shots=[1,2,3].map(i=>({id:'shot_b000000'+i,source:'viewport',origin:'https://a.test'}));await f.store.set(1,task);
  for(const s of task.shots)service.stored.set(s.id,{taskId:task.taskId});
  const g=fixture(service,[]);g.data.set(1,task);
  const runtime=g.runtime;await runtime.tick(1);
  assert.deepEqual(g.models[0].shots,['shot_b0000001','shot_b0000002','shot_b0000003']);
});

test('worker restart between capture and request: the screenshot is read back from storage, or reported as expired',async()=>{
  const service=images('unknown');
  const f=fixture(service,[{reply:'look',action:'view_image',id:'viewport'}]);
  await f.runtime.start(1,'Look');await f.runtime.tick(1);
  // A new runtime instance stands for a restarted service worker: task in session storage, image in IndexedDB.
  const restarted=f.make();await restarted.recover();await restarted.tick(1);
  assert.deepEqual(f.models.at(-1).shots,['shot_00000001']);
  // The record is gone (storage cleared): the model is told to call view_image again, nothing is sent.
  const g=fixture(images('supported',{present:()=>[]}),[{reply:'look',action:'view_image',id:'viewport'}]);
  await g.runtime.start(1,'Look');await g.runtime.tick(1);await g.runtime.tick(1);
  assert.equal(g.models[1].shots,undefined);
  const task=await g.runtime.get(1);assert.equal(task.results.find(r=>r.outcome?.code==='SHOT_EXPIRED').outcome.recovery,'replan');
});

test('model without vision: the screenshot becomes labelled recognition text within the observed cap',async()=>{
  const service=images('unsupported');service.recognize=async(source,goal,signal,question)=>{service.calls.push(['recognize',source,goal,question]);return '"quoted"\n'.repeat(400);};
  const f=fixture(service,[{reply:'look',action:'view_image',id:'r0',value:'List the prices'},{reply:'ok',action:'done'}]);
  await f.runtime.start(1,'Compare prices');await f.runtime.tick(1);
  const task=await f.runtime.get(1),result=last(task);
  assert.equal(result.outcome.code,'IMAGE_RECOGNIZED');assert.equal(result.outcome.observed.note,'来自图片识别，可能有误');assert.equal(result.outcome.observed.untrusted,true);
  assert.ok(result.outcome.observed.text.length>1000&&result.outcome.observed.text.length<=2000);
  assert.ok(JSON.stringify(result.outcome.observed).length<=4500,'not replaced by {truncated:true}');
  const call=service.calls.find(c=>c[0]==='recognize');assert.deepEqual(call[1],{data:'SlBFRw=='});assert.equal(call[2],'Compare prices');assert.equal(call[3],'List the prices');
  assert.equal(service.calls.some(c=>c[0]==='saveShot'),false,'nothing is stored');assert.equal(task.shots,undefined);
  assert.equal(task.steps,2,'recognition counts as a round');
  await f.runtime.tick(1);
  assert.equal(f.models[1].input.results.at(-1).outcome.observed.source,'r0');
});

test('attachment refs: vision models are told the image is already in the request; others get a new answer',async()=>{
  let f=fixture(images('supported'),[{reply:'again',action:'view_image',id:'image1',value:'Total?'}]);
  await f.runtime.submit(1,'Pay',{attachments:['img_00000001']});await f.runtime.tick(1);
  let task=await f.runtime.get(1);
  assert.equal(last(task).outcome.code,'IMAGE_IN_REQUEST');assert.equal(f.shots.length,0);
  const service=images('unsupported');f=fixture(service,[{reply:'again',action:'view_image',id:'image1',value:'Total?'},{reply:'x',action:'view_image',id:'image3'}]);
  await f.runtime.submit(1,'Pay',{attachments:['img_00000001']});
  await f.runtime.tick(1);await f.runtime.tick(1);await f.runtime.tick(1);
  task=await f.runtime.get(1);
  const asked=service.calls.filter(c=>c[0]==='recognize');
  assert.deepEqual(asked.at(-1),['recognize','img_00000001','Pay','Total?']);
  assert.equal(task.results.find(r=>r.action==='view_image').outcome.observed.text,'TEXT Total?');
  assert.equal(last(task).outcome.code,'IMAGE_NOT_FOUND');assert.equal(f.shots.length,0);
});

test('capture failures are tool results: masking failure stores no image and does not pause',async()=>{
  const service=images('supported');
  const f=fixture(service,[{reply:'look',action:'view_image',id:'viewport'}],{screenshot:()=>{throw Object.assign(new Error('无法遮盖敏感字段，未截图'),{code:'MASK_FAILED'});}});
  await f.runtime.start(1,'Look');await f.runtime.tick(1);
  const task=await f.runtime.get(1);
  assert.equal(last(task).outcome.code,'MASK_FAILED');assert.equal(last(task).outcome.status,'error');assert.equal(task.status,'running');
  assert.equal(service.calls.some(c=>c[0]==='saveShot'),false);assert.equal(task.shots,undefined);
  // Sensitive grant and frame-routed targets.
  const g=fixture(images(),[{reply:'look',action:'view_image',id:'t0'}]);
  await g.runtime.start(1,'Look');const t=await g.store.get(1);t.sensitiveAccess='allowed';await g.store.set(1,t);await g.runtime.tick(1);
  assert.equal(g.shots[0].policy.sensitiveFields,true);
});

test('after an image-type 400 the pending screenshot is answered by the recognition model',async()=>{
  let mode='unknown';const service=images(()=>mode);
  const fallback=Object.assign(new Error('模型不支持图片输入'),{code:'MODEL_VISION_FALLBACK'});
  const f=fixture(service,[{reply:'look',action:'view_image',id:'viewport',value:'Seat map?'},fallback,{reply:'ok',action:'done'}]);
  await f.runtime.start(1,'Pick a seat');await f.runtime.tick(1);await f.runtime.tick(1);
  assert.deepEqual(f.models[1].shots,['shot_00000001']);
  mode='unsupported';await f.runtime.tick(1);
  let task=await f.runtime.get(1);
  assert.deepEqual(task.shots,[]);assert.equal(service.stored.size,0);
  assert.equal(last(task).outcome.code,'IMAGE_RECOGNIZED');assert.equal(last(task).outcome.observed.question,'Seat map?');
  await f.runtime.tick(1);task=await f.runtime.get(1);
  assert.equal(f.models[2].shots,undefined);assert.equal(task.status,'completed');
});

test('backend: screenshots follow attachments without the cache mark, at most 3, and only for vision models',async()=>{
  const JPG='data:image/jpeg;base64,'+Buffer.from('x').toString('base64');
  const run=async(format,vision)=>{
    const data={config:{endpoint:'https://main.test/v1',key:'K',model:'m',language:'English',toolMode:'json',...(format?{apiFormat:format}:{})},visionSupport:{}},requests=[];
    const chrome={runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p},storage:{local:{async setAccessLevel(){},async get(k){return {[k]:structuredClone(data[k])};},async set(v){Object.assign(data,v);}}},permissions:{async contains(){return true;}}};
    const s=backend.createService(chrome,async(url,opts)=>{requests.push(JSON.parse(opts.body));return new Response(JSON.stringify(url.endsWith('/messages')?{content:[{type:'text',text:'{"reply":"ok","action":"done"}'}],stop_reason:'end_turn'}:{choices:[{finish_reason:'stop',message:{content:'{"reply":"ok","action":"done"}'}}]}));},{attachments:{async get(ids){return ids.map(id=>({id,data:JPG}));}}});
    if(vision==='unsupported'){const id=await s.identity();data.visionSupport={unsupported:[id]};}
    await s.generateAgent('{"goal":"g"}',undefined,{images:['img_00000001'],shots:['shot_00000001','shot_00000002','shot_00000003','shot_00000004']});
    return requests[0].messages.at(-1).content;
  };
  const claude=await run('anthropic');
  const blocks=claude.filter(p=>p.type==='image');
  assert.equal(blocks.length,4,'one attachment + newest 3 screenshot ids');
  assert.deepEqual(blocks.map(b=>!!b.cache_control),[true,false,false,false]);
  assert.equal(claude.filter(p=>p.text===P.IMAGE_NOTE).length,4);
  assert.equal((await run()).filter(p=>p.type==='image_url').length,4);
  assert.equal(typeof await run(null,'unsupported'),'string','no images for a model known not to see them');
});

test('attachment store keeps screenshots bound to their task and drops them on demand',async()=>{
  const records=new Map();
  // Minimal IndexedDB stand-in sharing the attachment store's single object store.
  const factory={open(){const request={};setImmediate(()=>{
    const db={close(){},objectStoreNames:{contains:()=>true},transaction(){const staged=new Map(records);const tx={abort(){tx.aborted=true;setImmediate(()=>tx.onabort?.());},objectStore(){return {getAll(){const r={};setImmediate(()=>{r.result=[...staged.values()].map(v=>structuredClone(v));r.onsuccess?.();setImmediate(()=>{if(tx.aborted)return;records.clear();for(const [k,v] of staged)records.set(k,v);tx.oncomplete?.();});});return r;},put(v){staged.set(v.id,structuredClone(v));},delete(k){staged.delete(k);}};}};return tx;}};
    request.result=db;request.onsuccess?.();});return request;}};
  const store=createAttachmentStore({factory});
  const JPG='data:image/jpeg;base64,SlBFRw==';
  await store.putShot({id:'shot_00000001',taskId:'t1',data:JPG});await store.putShot({id:'shot_00000002',taskId:'t1',data:JPG});
  await assert.rejects(()=>store.putShot({id:'shot_00000003',taskId:'t1',data:'data:image/png;base64,QQ=='}),/截图数据无效/);
  await assert.rejects(()=>store.putShot({id:'shot_00000004',taskId:'',data:JPG}),/截图数据无效/);
  assert.equal(records.get('shot_00000001').kind,'shot');
  assert.equal(await store.removeShots('t1',['shot_00000002']),1);assert.deepEqual([...records.keys()],['shot_00000002']);
  assert.equal(await store.removeTask('t1'),1);assert.equal(records.size,0);
});
