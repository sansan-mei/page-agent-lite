const {test}=require('node:test');const assert=require('node:assert/strict');
const {createRuntime}=require('../extension/runtime.js');

// Non-vision model: view_image screenshots and attached images go through recognition, which may fail.
function fixture(recognize,{backoff=0,replies=[{reply:'look',action:'view_image',id:'viewport'}]}={}){
  const data=new Map(),models=[],calls=[];let seq=0;
  const store={async get(id){return structuredClone(data.get(id)||null);},async set(id,t){data.set(id,structuredClone(t));},async remove(id){data.delete(id);},async list(){return [...data.values()].map(t=>structuredClone(t));}};
  const images={mode:async()=>'unsupported',async claim(ids){return ids.map(id=>({id,type:'image/jpeg',width:10,height:10,size:9}));},
    async recognize(...args){calls.push(args);return recognize(calls.length,args);},async saveShot(){return 'shot_00000001';},async dropShots(){},async present(ids){return ids;},async remove(){},async prune(){}};
  const tools={async tab(id){return {id,url:'https://a.test/',status:'complete'};},
    async observe(){return {url:'https://a.test/',documentId:'d1',snapshotId:'s'+(++seq),page:{text:'page',elements:[],regions:[]}};},
    async screenshot(){return {data:'SlBFRw==',masked:0,width:8,height:6};},async releaseInput(){return true;},async clearPointer(){}};
  const runtime=createRuntime({store,tools,images,schedule:()=>{},cancelSchedule:async()=>{},uuid:()=>'id'+(++seq),preferences:async()=>({maxSteps:50}),recognitionBackoff:backoff,
    model:async text=>{models.push(JSON.parse(text));const next=replies.shift();return {text:JSON.stringify(next||{reply:'ok',action:'done'})};}});
  return {runtime,models,calls,data};
}
const last=task=>task.results.at(-1);

test('a failed recognition is retried and the second attempt is used',async()=>{
  const f=fixture(n=>{if(n===1)throw new Error('API 503：服务异常');return 'CHART TEXT';});
  await f.runtime.start(1,'Read the chart');await f.runtime.tick(1);
  const task=await f.runtime.get(1);
  assert.equal(f.calls.length,2);assert.equal(last(task).outcome.code,'IMAGE_RECOGNIZED');assert.equal(last(task).outcome.observed.text,'CHART TEXT');
  assert.ok(task.events.some(e=>/图片识别失败，稍后重试（1\/2）/.test(e.text)));
  assert.equal(task.steps,2,'one round for the model request, one for recognition; the retry adds none');
});

test('after 3 failed attempts the existing failure marking stays',async()=>{
  const f=fixture(()=>{throw new Error('API 500：服务异常');});
  await f.runtime.start(1,'Read the chart');await f.runtime.tick(1);
  let task=await f.runtime.get(1);
  assert.equal(f.calls.length,3,'1 attempt + 2 retries');
  assert.equal(last(task).outcome.code,'RECOGNITION_FAILED');assert.equal(last(task).outcome.dispatch,'not_sent');assert.equal(task.steps,2);
  // Attached images: the image is marked failed once and never recognized again.
  const a=fixture(()=>{throw new Error('API 500：服务异常');},{replies:[]});
  await a.runtime.submit(1,'Book from the image',{attachments:['img_00000001']});await a.runtime.tick(1);
  task=await a.runtime.get(1);
  assert.equal(a.calls.length,3);assert.equal(task.attachments[0].failed,true);assert.equal(task.steps,1);
  await a.runtime.tick(1);assert.equal(a.calls.length,3);
});

test('a stop during the backoff ends the retries without another attempt',async()=>{
  const f=fixture(()=>{throw new Error('API 503：服务异常');},{backoff:60000});
  await f.runtime.start(1,'Read the chart');
  const started=Date.now(),running=f.runtime.tick(1);
  while(f.calls.length<1)await new Promise(resolve=>setTimeout(resolve,5));
  await new Promise(resolve=>setTimeout(resolve,20));
  await f.runtime.stop(1);await running;
  assert.ok(Date.now()-started<5000,'the 60 s backoff was cut short');
  assert.equal(f.calls.length,1);
  const task=await f.runtime.get(1);
  assert.equal(task.results.some(r=>r.outcome?.code==='RECOGNITION_FAILED'),false,'a stopped run records nothing more');
});
