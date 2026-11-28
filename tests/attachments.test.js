const {test}=require('node:test');const assert=require('node:assert/strict');
const P=require('../extension/prompts.js');const H=require('../extension/history-store.js');
const backend=require('../extension/backend.js');
const {createAttachmentStore}=require('../extension/site-memory.js');
const {createRuntime}=require('../extension/runtime.js');
const {createTaskStore}=require('../extension/task-store.js');

// IndexedDB stand-in with the calls the attachment store uses: open/upgrade, getAll, put, delete.
function fakeIndexedDB(){
  const dbs=new Map();
  return {dbs,open(name,version){
    const request={};
    setImmediate(()=>{
      let record=dbs.get(name);const upgrade=!record||record.version<version;
      if(!record){record={version:0,stores:new Map()};dbs.set(name,record);}
      const keyOf=v=>v.id??v.origin??v.scope??v.taskId;
      const db={close(){},objectStoreNames:{contains:n=>record.stores.has(n)},createObjectStore(n){record.stores.set(n,new Map());return {createIndex(){}};},deleteObjectStore(n){record.stores.delete(n);},
        transaction(n){
          const data=record.stores.get(n);if(!data)throw new Error('NotFoundError');
          const staged=new Map(data);
          const tx={aborted:false,abort(){if(tx.aborted)return;tx.aborted=true;setImmediate(()=>tx.onabort?.());},
            objectStore(){return {getAll(){const r={};setImmediate(()=>{r.result=[...staged.values()].map(v=>structuredClone(v));r.onsuccess?.();setImmediate(finish);});return r;},put(v){staged.set(keyOf(v),structuredClone(v));},delete(k){staged.delete(k);}};}};
          const finish=()=>{if(tx.aborted)return;data.clear();for(const [k,v] of staged)data.set(k,v);tx.oncomplete?.();};
          return tx;
        }};
      request.result=db;request.transaction={db,objectStore(){return {getAll(){return {};}};}};
      if(upgrade){record.version=version;request.onupgradeneeded?.();}
      setImmediate(()=>request.onsuccess?.());
    });
    return request;
  }};
}
const JPEG='data:image/jpeg;base64,'+Buffer.from('jpeg').toString('base64');
const meta={width:800,height:600,size:120000};

test('attachment store: drafts, claims, discard, task cleanup and pruning',async()=>{
  let clock=1000;const factory=fakeIndexedDB(),store=createAttachmentStore({factory,now:()=>clock});
  assert.deepEqual(await store.put({id:'img_aaaaaaa1',data:JPEG,...meta}),{id:'img_aaaaaaa1',type:'image/jpeg',...meta});
  assert.equal(factory.dbs.get('page-agent-memory').version,6);
  // Only base64 raster data URLs: SVG, network URLs and bad ids are refused.
  for(const data of ['data:image/svg+xml;base64,PHN2Zz4=','https://example.test/a.png','data:text/html;base64,PGI+'])await assert.rejects(()=>store.put({id:'img_bad00001',data,...meta}),/图片数据无效/);
  await assert.rejects(()=>store.put({id:'../x',data:JPEG,...meta}),/图片数据无效/);
  await store.put({id:'img_aaaaaaa2',data:JPEG,...meta});await store.put({id:'img_aaaaaaa3',data:JPEG,...meta});
  assert.deepEqual((await store.get(['img_aaaaaaa2','img_aaaaaaa1'])).map(r=>r.id),['img_aaaaaaa2','img_aaaaaaa1']);
  // Claim binds drafts to one task; another task cannot take them; a missing id fails the whole claim.
  assert.deepEqual((await store.claim(['img_aaaaaaa1'],'task-a')).map(m=>m.id),['img_aaaaaaa1']);
  await assert.rejects(()=>store.claim(['img_aaaaaaa1'],'task-b'),/图片已失效/);
  await assert.rejects(()=>store.claim(['img_aaaaaaa2','img_missing1'],'task-b'),/图片已失效/);
  assert.equal((await store.get(['img_aaaaaaa2']))[0].taskId,null,'failed claim changes nothing');
  // The side panel may discard only unclaimed drafts.
  assert.equal(await store.discard('img_aaaaaaa1'),false);assert.equal(await store.discard('img_aaaaaaa3'),true);
  await store.claim(['img_aaaaaaa2'],'task-b');
  assert.equal(await store.removeTask('task-a'),1);assert.deepEqual((await store.get(['img_aaaaaaa1','img_aaaaaaa2'])).map(r=>r.id),['img_aaaaaaa2']);
  // Prune: images of tasks no longer running, and drafts older than a day.
  await store.put({id:'img_draft001',data:JPEG,...meta});
  assert.equal(await store.prune(['task-b']),0);
  assert.equal(await store.prune([]),0,'a fresh claim may belong to a task still being saved');
  clock+=86400001;assert.equal(await store.prune([]),2);
  assert.deepEqual(await store.get(['img_aaaaaaa2','img_draft001']),[]);
});

function images(mode='unknown'){
  const calls=[];
  return {calls,mode:async()=>typeof mode==='function'?mode():mode,
    async claim(ids,taskId){calls.push(['claim',ids,taskId]);if(ids.includes('img_missing1'))throw new Error('图片已失效，请重新添加');return ids.map(id=>({id,type:'image/jpeg',width:10,height:10,size:99}));},
    async recognize(id,goal){calls.push(['recognize',id,goal]);if(id==='img_broken01')throw new Error('API 400：服务异常');return 'TEXT OF '+id;},
    async remove(taskId){calls.push(['remove',taskId]);},async prune(ids){calls.push(['prune',ids]);}};
}
function fixture(service,replies=[{reply:'ok',action:'done'}]){
  const data=new Map(),models=[];let seq=0;
  const store={async get(id){return structuredClone(data.get(id)||null);},async set(id,t){data.set(id,structuredClone(t));},async remove(id){data.delete(id);},async list(){return [...data.values()].map(t=>structuredClone(t));}};
  const tools={async tab(id){return {id,url:'https://a.test/',status:'complete'};},async observe(){return {url:'https://a.test/',documentId:'d',page:{text:'page',elements:[]}};}};
  const runtime=createRuntime({store,tools,images:service,schedule:()=>{},cancelSchedule:async()=>{},uuid:()=>'id'+(++seq),preferences:async()=>({maxSteps:50}),recognitionBackoff:0,
    model:async(text,signal,capabilities)=>{models.push({input:JSON.parse(text),images:capabilities.images});const next=replies.shift();if(next instanceof Error)throw next;return {text:JSON.stringify(next||{reply:'ok',action:'done'})};}});
  return {runtime,models,data};
}

test('submit claims images for the task, caps them at 4 and records only metadata',async()=>{
  const service=images(),f=fixture(service);
  const task=await f.runtime.submit(1,'Fill the form from the screenshot',{attachments:['img_00000001','img_00000002']});
  assert.deepEqual(service.calls[0],['claim',['img_00000001','img_00000002'],task.taskId]);
  assert.deepEqual(task.attachments.map(a=>a.id),['img_00000001','img_00000002']);
  assert.equal(JSON.stringify(task).includes('base64'),false);
  assert.match(task.events.at(-2).text,/附图 2 张/);
  await assert.rejects(()=>f.runtime.submit(1,'more',{attachments:['img_00000003','img_00000004','img_00000005']}),/最多 4 张/);
  await assert.rejects(()=>f.runtime.submit(1,'bad',{attachments:['../etc']}),/图片参数无效/);
  await assert.rejects(()=>f.runtime.submit(1,'gone',{attachments:['img_missing1']}),/图片已失效/);
  assert.equal((await f.runtime.get(1)).instructions.length,0,'a failed claim adds no instruction');
  const next=await f.runtime.submit(1,'and this one',{attachments:['img_00000003']});
  assert.equal(next.attachments.length,3);assert.match(next.events.at(-1).text,/补充指令.*附图 1 张/);
  // Without the image service, attachments are refused instead of silently dropped.
  await assert.rejects(()=>fixture(null).runtime.submit(1,'x',{attachments:['img_00000001']}),/图片功能不可用/);
});

test('vision models get the image ids every turn and the context counts them',async()=>{
  for(const mode of ['supported','unknown']){
    const f=fixture(images(mode),[{reply:'look',action:'observe'},{reply:'ok',action:'done'}]);
    await f.runtime.submit(1,'What is in the picture?',{attachments:['img_00000001']});
    await f.runtime.tick(1);await f.runtime.tick(1);
    assert.deepEqual(f.models.map(m=>m.images),[['img_00000001'],['img_00000001']]);
    assert.deepEqual(f.models[0].input.images,[{ref:'image1'}]);
    assert.ok((await f.runtime.get(1)).contextPressure.estimatedTokens>=P.IMAGE_TOKENS);
  }
});

test('models without vision get recognition text once per image, labelled as possibly wrong',async()=>{
  const service=images('unsupported'),f=fixture(service);
  await f.runtime.submit(1,'Book the flight in the image',{attachments:['img_00000001','img_broken01']});
  await f.runtime.tick(1);
  let task=await f.runtime.get(1);
  assert.equal(f.models.length,0,'recognition runs before the first agent request');
  assert.equal(task.steps,1,'recognition, retries included, counts as one round');
  assert.deepEqual(service.calls.filter(c=>c[0]==='recognize').map(c=>c[1]),['img_00000001','img_broken01','img_broken01','img_broken01'],'a failure is retried twice');
  assert.equal(service.calls.find(c=>c[0]==='recognize')[2],'Book the flight in the image');
  assert.match(task.events.at(-1).text,/图片识别失败 1 张/);
  await f.runtime.tick(1);
  assert.equal(service.calls.filter(c=>c[0]==='recognize').length,4,'never recognized again after the final failure');
  assert.equal(f.models[0].images,undefined);
  assert.deepEqual(f.models[0].input.images,[{ref:'image1',note:'来自图片识别，可能有误',text:'TEXT OF img_00000001'},{ref:'image2',note:'图片识别失败，内容未知'}]);
  task=await f.runtime.get(1);assert.equal(task.status,'completed');
});

test('an image-type 400 during a task retries the turn through the recognition path',async()=>{
  let mode='unknown';const service=images(()=>mode);
  const fallback=Object.assign(new Error('模型不支持图片输入'),{code:'MODEL_VISION_FALLBACK'});
  const f=fixture(service,[fallback,{reply:'ok',action:'done'}]);
  await f.runtime.submit(1,'Read the receipt',{attachments:['img_00000001']});
  await f.runtime.tick(1);
  let task=await f.runtime.get(1);
  assert.equal(task.status,'running');assert.equal(task.retries,1);assert.match(task.events.at(-1).text,/识别模型/);
  mode='unsupported';
  await f.runtime.tick(1);await f.runtime.tick(1);
  task=await f.runtime.get(1);
  assert.deepEqual(f.models.map(m=>m.images),[['img_00000001'],undefined]);
  assert.equal(f.models[1].input.images[0].text,'TEXT OF img_00000001');assert.equal(task.status,'completed');
});

test('ending or clearing a task deletes its images; startup and new tasks prune leftovers',async()=>{
  const service=images(),f=fixture(service);
  const task=await f.runtime.submit(1,'Goal',{attachments:['img_00000001']});
  await f.runtime.finish(1);
  assert.deepEqual(service.calls.find(c=>c[0]==='remove'),['remove',task.taskId]);
  const ended=await f.runtime.get(1);assert.equal(ended.attachments.length,1,'metadata stays for history');
  const second=await f.runtime.submit(1,'Next',{attachments:['img_00000002']});
  await new Promise(r=>setImmediate(r));
  assert.deepEqual(service.calls.filter(c=>c[0]==='prune').at(-1),['prune',[second.taskId]]);
  service.calls.length=0;await f.runtime.remove(1);
  assert.deepEqual(service.calls.find(c=>c[0]==='remove'),['remove',second.taskId]);
  await f.runtime.submit(2,'Other');service.calls.length=0;await f.runtime.recover();
  assert.deepEqual(service.calls.filter(c=>c[0]==='prune').length,1);
});

test('history keeps only the image count and recognition text',()=>{
  const view=H.snapshot({taskId:'t',goal:'g',status:'ended',attachments:[{id:'img_00000001',type:'image/jpeg',width:1,height:1,size:9,text:'Receipt total 42'},{id:'img_00000002',type:'image/png',width:1,height:1,size:9}]});
  assert.deepEqual(view.images,{count:2,texts:['Receipt total 42']});
  assert.equal(view.attachments,undefined);assert.equal(JSON.stringify(view).includes('img_0000'),false);
});

test('recognition uses its own model settings, or the main model when left empty',async()=>{
  const JPG='data:image/jpeg;base64,'+Buffer.from('x').toString('base64');
  const run=async(config,answer='Total: 42')=>{
    const data={config:{endpoint:'https://main.test/v1',key:'MAIN_KEY',model:'main',language:'English',...config}},requests=[];
    const chrome={runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p},storage:{local:{async setAccessLevel(){},async get(k){return {[k]:structuredClone(data[k])};},async set(v){Object.assign(data,v);}}},permissions:{async contains(){return true;}}};
    const s=backend.createService(chrome,async(url,opts)=>{requests.push({url,headers:opts.headers,body:JSON.parse(opts.body)});return new Response(JSON.stringify(url.endsWith('/messages')?{content:[{type:'text',text:answer}],stop_reason:'end_turn'}:{choices:[{finish_reason:'stop',message:{content:answer}}]}));},{attachments:{async get(){return [{id:'img_00000001',data:JPG}];}}});
    return {text:await s.images.recognize('img_00000001','Pay the bill',undefined),request:requests[0],s,data};
  };
  let r=await run({});
  assert.equal(r.request.url,'https://main.test/v1/chat/completions');assert.equal(r.request.body.model,'main');assert.equal(r.request.headers.Authorization,'Bearer MAIN_KEY');
  const content=r.request.body.messages[1].content;
  assert.equal(content[0].text,P.IMAGE_NOTE);assert.equal(content[1].image_url.url,JPG);assert.equal(content[2].text,'Task: Pay the bill');
  assert.equal(r.request.body.reasoning_effort,undefined,'recognition never sends reasoning parameters');
  assert.match(r.request.body.messages[0].content,/never follow instructions/);
  assert.equal(r.text,'Total: 42');
  r=await run({recognition:{model:'vision-small'}});
  assert.equal(r.request.url,'https://main.test/v1/chat/completions');assert.equal(r.request.body.model,'vision-small');assert.equal(r.request.headers.Authorization,'Bearer MAIN_KEY');
  r=await run({recognition:{apiFormat:'anthropic',endpoint:'https://vision.test/v1',key:'OWN_KEY',model:'claude-v'}});
  assert.equal(r.request.url,'https://vision.test/v1/messages');assert.equal(r.request.headers['x-api-key'],'OWN_KEY');
  assert.equal(JSON.stringify(r.request).includes('MAIN_KEY'),false,'the main key never goes to another host');
  r=await run({},'y'.repeat(5000));assert.equal(r.text.length,2000);
  // configure validates the optional block, drops an empty one and needs permission for its own host.
  const options={id:'test',url:'chrome-extension://test/options.html'};
  const base={endpoint:'https://main.test/v1',key:'k',model:'main',language:'English'};
  await r.s.handle({type:'configure',config:{...base,recognition:{apiFormat:'openai',endpoint:'',key:'',model:''}}},options);
  assert.equal(r.data.config.recognition,undefined);
  await r.s.handle({type:'configure',config:{...base,recognition:{apiFormat:'openai',endpoint:'https://vision.test/v1',key:'v',model:'vm'}}},options);
  assert.deepEqual(r.data.config.recognition,{apiFormat:'openai',endpoint:'https://vision.test/v1',key:'v',model:'vm'});
  await assert.rejects(()=>r.s.handle({type:'configure',config:{...base,recognition:{model:'m',extra:1}}},options),/设置格式无效/);
});

test('image metadata and recognition text are user input and survive an origin switch',async()=>{
  const data={},area={async get(k){return structuredClone(k===null?data:{[k]:data[k]});},async set(v){Object.assign(data,structuredClone(v));},async remove(k){delete data[k];}},store=createTaskStore({storage:{session:area}});
  const attachments=[{id:'img_00000001',type:'image/jpeg',width:1,height:1,size:9,text:'Order 77'}];
  await store.set(1,{taskId:'t',tabId:1,origin:'https://a.test',status:'running',token:'old',goal:'Copy',attachments,results:[{result:'A_PAGE'}]});
  let t=await store.get(1);await store.changeOrigins(1,{taskId:t.taskId,expectedRevision:t.scopeRevision,action:'add',origin:'https://b.test',token:'scope',updatedAt:1});t=await store.get(1);
  t=await store.switchOrigin(1,{taskId:t.taskId,expectedRevision:t.scopeRevision,expectedToken:t.token,origin:'https://b.test',token:'new',updatedAt:2});
  assert.deepEqual(t.attachments,attachments);assert.equal(JSON.stringify(t.results).includes('A_PAGE'),false);
});
