const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');
const backend=fs.existsSync(require('node:path').join(__dirname,'../extension/backend.js'))?require('../extension/backend.js'):{};
function fake(){const data={};let granted=false;return {data,setGrant:v=>granted=v,runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p},storage:{local:{async setAccessLevel(x){data.level=x.accessLevel;},async get(k){return {[k]:data[k]};},async set(v){Object.assign(data,v);}}},permissions:{async contains(){return granted;}},scripting:{async registerContentScripts(x){data.scripts=x;},async getRegisteredContentScripts(){return [];},async unregisterContentScripts(){}}};}
const page={id:'test',url:'https://news.test/a?q=1#x',frameId:0,tab:{id:1}};
const options={id:'test',url:'chrome-extension://test/options.html'};
test('backend restricts storage, rejects untrusted senders and does not leak configuration',async()=>{
 assert.equal(typeof backend.createService,'function');const c=fake();const s=backend.createService(c,()=>{throw Error('unexpected');});await s.init();assert.equal(c.data.level,'TRUSTED_CONTEXTS');
 await assert.rejects(()=>s.handle({type:'settings'},page));await assert.rejects(()=>s.handle({type:'load'},{...page,id:'evil'}));await assert.rejects(()=>s.handle({type:'load'},{...page,frameId:1}));
 await assert.rejects(()=>s.handle({type:'configure',config:{endpoint:'https://api.test/v1',model:'m',key:'secret',language:'中文'}},options),/授权/);
 c.setGrant(true);await s.handle({type:'configure',config:{endpoint:'https://api.test/v1',model:'m',key:'secret',language:'中文'}},options);assert.equal((await s.handle({type:'settings'},options)).key,'secret');assert.deepEqual(await s.handle({type:'load'},page),{records:[],enabled:false});
});
test('site permission denial registers nothing; saved records survive restart and undo stays removed',async()=>{
 const c=fake(),s=backend.createService(c);await s.init();await assert.rejects(()=>s.handle({type:'enableSite',origin:'https://news.test'},options),/授权/);assert.equal(c.data.scripts,undefined);
 c.setGrant(true);await s.handle({type:'enableSite',origin:'https://news.test'},options);assert.equal(c.data.scripts[0].matches[0],'https://news.test/*');assert.equal(c.data.scripts[0].allFrames,false);
 const record={kind:'translation',target:{path:[0,0],tag:'p',text:'Original'},text:'译文'};
 await s.handle({type:'save',records:[record]},page);
 const restarted=backend.createService(c);assert.deepEqual((await restarted.handle({type:'load'}, {...page,url:'https://news.test/a?q=1#changed'})).records,[record]);
 assert.deepEqual((await restarted.handle({type:'load'},{...page,url:'https://news.test/a?q=2'})).records,[]);
 await restarted.handle({type:'save',records:[]},page);assert.deepEqual((await backend.createService(c).handle({type:'load'},page)).records,[]);
 await assert.rejects(()=>s.handle({type:'save',records:[{...record,key:'secret'}]},page));
 await assert.rejects(()=>s.handle({type:'save',records:Array(31).fill(record)},page));
 c.storage.local.set=async()=>{throw Error('QUOTA secret body');};await assert.rejects(()=>s.handle({type:'save',records:[record]},page),/存储空间/);
});
test('model uses background-only key and bounded task prompts; rejects errors without body leaks',async()=>{
 const c=fake();c.setGrant(true);c.data.config={endpoint:'https://api.test/v1',key:'secret-key',model:'model-one',language:'简体中文'};let request;
 const s=backend.createService(c,async(url,opts)=>{request={url,opts};return new Response(JSON.stringify({choices:[{message:{content:'翻译结果'}}]}));});
 assert.deepEqual(await s.handle({type:'model',task:'translate',text:'hello'},page),{text:'翻译结果'});assert.equal(request.url,'https://api.test/v1/chat/completions');assert.equal(request.opts.headers.Authorization,'Bearer secret-key');assert.equal(request.opts.redirect,'error');assert.match(JSON.parse(request.opts.body).messages[0].content,/简体中文/);
 await assert.rejects(()=>s.handle({type:'model',task:'translate',text:'x'.repeat(12001)},page));
 await assert.rejects(()=>s.handle({type:'model',task:'execute',text:'evil'},page));
 for(const status of [401,403,429,500]){const bad=backend.createService(c,async()=>new Response('secret-key private response',{status}));await assert.rejects(()=>bad.handle({type:'model',task:'summary',text:'article'},page),e=>!e.message.includes('secret-key')&&/API/.test(e.message));}
 const invalid=backend.createService(c,async()=>new Response('{bad'));await assert.rejects(()=>invalid.handle({type:'model',task:'summary',text:'article'},page),/响应/);
 const broken=backend.createService(c,async()=>new Response(new ReadableStream({start(controller){controller.error(Error('secret-key raw stream detail'));}})));
 await assert.rejects(()=>broken.handle({type:'model',task:'summary',text:'article'},page),e=>/响应/.test(e.message)&&!e.message.includes('secret-key'));
 const huge=backend.createService(c,async()=>new Response('x'.repeat(70000)));await assert.rejects(()=>huge.handle({type:'model',task:'summary',text:'article'},page),/过大/);
});
test('disabled sites never replay saved records; HTTP websites remain opt-in',async()=>{
 const c=fake(),s=backend.createService(c);c.setGrant(true);await s.init();
 await s.handle({type:'enableSite',origin:'http://news.test'},options);
 assert.equal(c.data.scripts[0].matches[0],'http://news.test/*');
 const p={...page,url:'http://news.test/a'};
 const record={kind:'summary',target:{path:[0],tag:'p',text:'Original'},text:'summary'};
 await s.handle({type:'save',records:[record]},p);
 await s.handle({type:'disableSite',origin:'http://news.test'},options);
 assert.deepEqual(await s.handle({type:'load'},p),{records:[],enabled:false});
 await assert.rejects(()=>s.handle({type:'sites'},page));
 assert.deepEqual(await s.handle({type:'sites'},options),[]);
});
test('trusted options opened in a real tab can read settings, but child frames and page senders cannot', async()=>{
 const c=fake(),s=backend.createService(c);await s.init();
 c.data.config={model:'test-model'};
 assert.equal((await s.handle({type:'settings'},{...options,frameId:0,tab:{id:4}})).model,'test-model');
 await assert.rejects(()=>s.handle({type:'settings'},{...options,frameId:1,tab:{id:4}}));
 await assert.rejects(()=>s.handle({type:'settings'},page));
});
module.exports={fake,page,options};
