const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const {parseHTML}=require('linkedom');const {runUi}=require('./i18n-helper.js');
const A=require('../extension/attachments.js');const C=require('../extension/core.js');
const flush=async(n=4)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
const file=(type,size=1000,name='a')=>({type,size,name});

test('image files: only local PNG/JPEG/WebP/GIF up to 5 MB; links and HTML drops count as network addresses',()=>{
  for(const type of A.TYPES)assert.equal(A.check(file(type)),null);
  assert.equal(A.check(file('image/svg+xml')),'spImageType');assert.equal(A.check(file('')),'spImageType');assert.equal(A.check(null),'spImageType');
  assert.equal(A.check(file('image/png',5*1024*1024+1)),'spImageSize');assert.equal(A.check(file('image/png',5*1024*1024)),null);
  assert.deepEqual(A.fromTransfer({files:[],types:['text/uri-list']}),{files:[],url:true});
  assert.deepEqual(A.fromTransfer({files:[],types:['text/html','text/plain']}),{files:[],url:true});
  assert.deepEqual(A.fromTransfer({files:[file('image/png')],types:['Files','text/uri-list']}).url,false);
  assert.match(A.newId(),/^img_[a-f0-9]{24}$/);
});

function canvasDeps({width,height,fail=false,output}={}){
  const drawn=[];let revoked=0;
  class Image{set src(v){setImmediate(()=>{if(fail)this.onerror();else{this.naturalWidth=width;this.naturalHeight=height;this.onload();}});}}
  const document={createElement(){const canvas={getContext:()=>({fillRect:(...a)=>drawn.push(['fill',canvas.width,canvas.height,...a]),drawImage:(img,...a)=>drawn.push(['draw',...a]),set fillStyle(v){drawn.push(['style',v]);}}),toDataURL:(type,q)=>output??('data:'+type+';base64,QUJD'),width:0,height:0};return canvas;}};
  const URL={createObjectURL:()=>'blob:x',revokeObjectURL:()=>revoked++};
  return {deps:{document,URL,Image},drawn,revoked:()=>revoked};
}

test('compression scales the long edge to 1568 and re-encodes as JPEG on white; failures are rejected',async()=>{
  let x=canvasDeps({width:4000,height:2000});
  const out=await A.compress(file('image/png',3e6),x.deps);
  assert.deepEqual([out.width,out.height,out.size],[1568,784,3e6]);assert.match(out.data,/^data:image\/jpeg;base64,/);
  assert.deepEqual(x.drawn[0],['style','#fff']);assert.deepEqual(x.drawn.at(-1),['draw',0,0,1568,784]);assert.equal(x.revoked(),1);
  x=canvasDeps({width:800,height:600});assert.deepEqual([(await A.compress(file('image/webp'),x.deps)).width],[800],'small images are not enlarged');
  await assert.rejects(()=>A.compress(file('image/png'),canvasDeps({fail:true}).deps),/decode/);
  await assert.rejects(()=>A.compress(file('image/png'),canvasDeps({width:10,height:10,output:'data:,'}).deps),/decode/);
});

function fakeAttachments({decodeFail=false,putFail=false}={}){
  const puts=[],discards=[];let n=0;
  return {puts,discards,api:{...A,newId:()=>'img_'+String(++n).padStart(8,'0'),
    async compress(f){if(decodeFail||f.name==='broken')throw new Error('decode');return {data:'data:image/jpeg;base64,QQ==',width:10,height:10,size:f.size};},
    store:()=>({async put(r){if(putFail)throw new Error('x');puts.push(r.id);return r;},async discard(id){discards.push(id);return true;}})}};
}
async function panel(hook=()=>undefined,attachments=fakeAttachments()){
  const {document,window}=parseHTML(fs.readFileSync('extension/sidepanel.html','utf8'));
  const calls=[];
  const chrome={tabs:{async query(){return [{id:9,url:'https://example.test/',title:'T'}];},onRemoved:{addListener(){}},onActivated:{addListener(){}},onUpdated:{addListener(){}}},permissions:{async contains(){return true;},onAdded:{addListener(){}},onRemoved:{addListener(){}},async request(){return true;}},
    runtime:{async sendMessage(m){calls.push(m);const r=hook(m);if(r!==undefined)return await r;return {ok:true,value:m.type==='task:get'?null:{connected:true}};},async openOptionsPage(){}},storage:{onChanged:{addListener(){}}}};
  runUi('extension/sidepanel.js',{chrome,document,window,URL,Date,...(attachments?{PageAgentAttachments:attachments.api}:{})});await flush();
  const $=id=>document.getElementById(id);
  const pick=async files=>{Object.defineProperty($('image-file'),'files',{value:files,configurable:true});$('image-file').dispatchEvent(new window.Event('change'));await flush();};
  return {document,window,calls,$,pick,attachments};
}

test('side panel: pick, preview, remove and send images with the instruction',async()=>{
  let answer;const f=await panel(m=>m.type==='task:submit'?answer(m):undefined);
  assert.equal(f.$('attach').hidden,false);assert.equal(f.$('drafts').hidden,true);
  await f.pick([file('image/png',100,'a'),file('image/svg+xml',100,'b'),file('image/jpeg',100,'c')]);
  assert.deepEqual(f.attachments.puts,['img_00000001','img_00000002']);
  assert.equal(f.$('drafts').querySelectorAll('img').length,2);assert.equal(f.$('drafts').hidden,false);
  assert.match(f.$('status').textContent,/只支持 PNG/);
  f.$('drafts').querySelectorAll('button')[0].dispatchEvent(new f.window.Event('click'));await flush();
  assert.deepEqual(f.attachments.discards,['img_00000001']);assert.equal(f.$('drafts').querySelectorAll('img').length,1);
  // A failed send keeps the drafts; a successful one sends their ids and clears them.
  answer=()=>({ok:false,error:'失败'});f.$('instruction').value='看图填写';f.$('chat').dispatchEvent(new f.window.Event('submit'));await flush();
  assert.deepEqual(Array.from(f.calls.filter(m=>m.type==='task:submit').at(-1).attachments),['img_00000002']);assert.equal(f.$('drafts').querySelectorAll('img').length,1);
  answer=()=>({ok:true,value:{taskId:'t',goal:'看图填写',status:'running',steps:0,prefs:{maxSteps:9},events:[],attachments:[{id:'img_00000002'}]}});
  f.$('chat').dispatchEvent(new f.window.Event('submit'));await flush();
  assert.equal(f.$('drafts').hidden,true);assert.equal(f.$('task-images-count').textContent,'附图 1 张');
  // Sends without images carry no attachments field.
  f.$('instruction').value='继续';f.$('chat').dispatchEvent(new f.window.Event('submit'));await flush();
  assert.equal('attachments' in f.calls.filter(m=>m.type==='task:submit').at(-1),false);
});

test('side panel: at most 4 images per task, counting ones the task already has',async()=>{
  const task={taskId:'t',goal:'g',status:'running',steps:0,prefs:{maxSteps:9},events:[],attachments:[{id:'img_a0000001'},{id:'img_a0000002'},{id:'img_a0000003'}]};
  const f=await panel(m=>m.type==='task:get'?{ok:true,value:task}:undefined);await flush();
  await f.pick([file('image/png'),file('image/png')]);
  assert.equal(f.attachments.puts.length,1);assert.match(f.$('status').textContent,/最多 4 张/);
});

test('side panel: paste and drop add local images; links, oversize, decode and storage failures are refused',async()=>{
  const f=await panel();
  const paste=new f.window.Event('paste',{cancelable:true});paste.clipboardData={files:[file('image/png')],types:['Files']};
  f.$('instruction').dispatchEvent(paste);await flush();
  assert.equal(paste.defaultPrevented,true);assert.equal(f.attachments.puts.length,1);
  const text=new f.window.Event('paste',{cancelable:true});text.clipboardData={files:[],types:['text/plain']};
  f.$('instruction').dispatchEvent(text);assert.equal(text.defaultPrevented,false,'plain text paste is untouched');
  const link=new f.window.Event('drop',{cancelable:true});link.dataTransfer={files:[],types:['text/uri-list']};
  f.$('composer').dispatchEvent(link);await flush();assert.match(f.$('status').textContent,/不支持网络地址/);
  const drop=new f.window.Event('drop',{cancelable:true});drop.dataTransfer={files:[file('image/gif')],types:['Files']};
  f.$('composer').dispatchEvent(drop);await flush();assert.equal(f.attachments.puts.length,2);
  await f.pick([file('image/png',6*1024*1024)]);assert.match(f.$('status').textContent,/5 MB/);
  await f.pick([file('image/png',10,'broken')]);assert.match(f.$('status').textContent,/无法读取/);
  const g=await panel(()=>undefined,fakeAttachments({putFail:true}));await g.pick([file('image/png')]);
  assert.match(g.$('status').textContent,/保存失败/);assert.equal(g.$('drafts').hidden,true);
});

test('side panel shows recognition text as plain text and hides the image button without the helper',async()=>{
  const task={taskId:'t',goal:'g',status:'running',steps:0,prefs:{maxSteps:9},events:[],attachments:[{id:'img_a0000001',text:'<img src=x onerror=alert(1)>Total 42'},{id:'img_a0000002'}]};
  const f=await panel(m=>m.type==='task:get'?{ok:true,value:task}:undefined);await flush();
  assert.equal(f.$('task-images').hidden,false);assert.equal(f.$('task-images-count').textContent,'附图 2 张');
  assert.match(f.$('task-images-text').textContent,/可能有误.*Total 42/);assert.equal(f.$('task-images-text').querySelector('img'),null);
  const g=await panel(()=>undefined,null);assert.equal(g.$('attach').hidden,true);
});

test('options: optional recognition model is saved with its own host grant and loaded back',async()=>{
  const {document,window}=parseHTML(fs.readFileSync('extension/options.html','utf8'));
  const sent=[],grants=[];
  const saved={endpoint:'https://api.test/v1',model:'m',key:'',language:'English',recognition:{apiFormat:'anthropic',endpoint:'https://vision.test/v1',key:'VK',model:'claude-v'}};
  const chrome={runtime:{id:'test',async sendMessage(m){sent.push(m);if(m.type==='settings')return {ok:true,value:saved};if(m.type==='agentPreferences')return {ok:true,value:{}};return {ok:true,value:{ok:true}};}},permissions:{async request(p){grants.push(p);return true;},async contains(){return false;},onAdded:{addListener(){}},onRemoved:{addListener(){}}},storage:{local:{async get(){return {};},async set(){}},onChanged:{addListener(){}}},tabs:{async query(){return [];}},userScripts:undefined};
  runUi('extension/options.js',{chrome,document,window,URL,Date,PageAgentCore:C});await flush(5);
  const $=id=>document.getElementById(id);
  assert.deepEqual([$('rec-model').value,$('rec-endpoint').value,$('rec-key').value,$('rec-format').value],['claude-v','https://vision.test/v1','VK','anthropic']);
  $('config').dispatchEvent(new window.Event('submit',{cancelable:true}));await flush(5);
  assert.deepEqual(Array.from(grants[0].origins),['https://api.test/*','https://vision.test/*']);
  assert.deepEqual(JSON.parse(JSON.stringify(sent.find(m=>m.type==='configure').config.recognition)),{apiFormat:'anthropic',model:'claude-v',endpoint:'https://vision.test/v1',key:'VK'});
  // Empty model: nothing saved, main model is used; no extra host grant.
  $('rec-model').value='';$('config').dispatchEvent(new window.Event('submit',{cancelable:true}));await flush(5);
  assert.deepEqual(Array.from(grants[1].origins),['https://api.test/*']);
  assert.equal('recognition' in sent.filter(m=>m.type==='configure').at(-1).config,false);
});
