const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {parseHTML}=require('linkedom');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const source=fs.readFileSync('extension/welcome-image.js','utf8');
const png='data:image/png;base64,iVBORw0KGgo=';
function fixture({saved=null,get,fail=false,settings=false}={}){
 const {document,window}=parseHTML(settings?'<img id="welcome-image-preview" src="icons/welcome-assistant.png"><input id="welcome-image-file"><button id="welcome-image-reset"></button><p id="welcome-image-status"></p>':'<img class="welcome-art" src="icons/welcome-assistant.png">');
 let changed;const writes=[];
 const chrome={storage:{local:{get:get||(async()=>({welcomeImage:saved})),async set(value){if(fail)throw Error('配额不足');writes.push(value);}},onChanged:{addListener(fn){changed=fn;}}}};
 vm.runInNewContext(source,{chrome,document,URL,Image:class{}});
 return {document,window,writes,change:(value)=>changed({welcomeImage:{newValue:value}},'local')};
}
test('welcome image ignores URLs and active formats and observes only local appearance changes',async()=>{
 for(const saved of ['https://example.test/track.png','data:image/svg+xml;base64,PHN2Zz4=',png+'!','x'.repeat(2097153)]){
  const f=fixture({saved});await flush();assert.equal(f.document.querySelector('img').getAttribute('src'),'icons/welcome-assistant.png');
 }
 const f=fixture({saved:png});await flush();assert.equal(f.document.querySelector('img').getAttribute('src'),png);
 f.change(null);assert.equal(f.document.querySelector('img').getAttribute('src'),'icons/welcome-assistant.png');
});
test('a late initial read cannot overwrite a newer main image',async()=>{
 let resolve;const f=fixture({get:()=>new Promise(r=>resolve=r)});
 f.change(png);resolve({welcomeImage:null});await flush();
 assert.equal(f.document.querySelector('img').getAttribute('src'),png);
});
test('reset persists default and storage failure keeps the existing preview',async()=>{
 for(const fail of [false,true]){
  const f=fixture({saved:png,settings:true,fail});await flush();
  f.document.getElementById('welcome-image-reset').dispatchEvent(new f.window.Event('click'));await flush();
  assert.equal(f.document.querySelector('img').getAttribute('src'),fail?png:'icons/welcome-assistant.png');
  assert.equal(f.writes.length,fail?0:1);
  if(fail)assert.match(f.document.getElementById('welcome-image-status').textContent,/配额不足/);
  else assert.equal(f.writes[0].welcomeImage,null);
 }
});
test('unsupported and oversized uploads fail before decoding or storage',async()=>{
 for(const selected of [{type:'image/svg+xml',size:10},{type:'image/png',size:5242881}]){
  const f=fixture({saved:png,settings:true});await flush();const file=f.document.getElementById('welcome-image-file');
  file.files=[selected];file.dispatchEvent(new f.window.Event('change'));await flush();
  assert.equal(f.writes.length,0);assert.equal(f.document.querySelector('img').getAttribute('src'),png);
  assert.match(f.document.getElementById('welcome-image-status').textContent,/PNG|5 MB/);
 }
});
