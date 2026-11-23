const {test}=require('node:test');const assert=require('node:assert/strict');
const {createBrowserTools}=require('../extension/browser-tools.js');
test('missing host access produces actionable error and checks page before injecting',async()=>{
 let granted=false,calls=0;
 const chrome={tabs:{async get(){return {url:'https://example.test/page'};}},permissions:{async contains(){return granted;}},scripting:{async executeScript(){calls++;throw Error('Cannot access contents of url');}}};
 const tools=createBrowserTools(chrome);
 await assert.rejects(()=>tools.inject(1),/授权当前网站/);granted=true;
 await assert.rejects(()=>tools.inject(1),/受保护页面/);assert.equal(calls,2);
 chrome.tabs.get=async()=>({url:'chrome://settings'});
 await assert.rejects(()=>tools.inject(1),/不支持操作/);assert.equal(calls,2);
 chrome.tabs.get=async()=>{throw Error('No tab');};
 await assert.rejects(()=>tools.tab(1),/已关闭/);
});

test('lost click reply reconnects observation only and never retries the click',async()=>{
 let executed=0,observed=0;
 const chrome={tabs:{async get(){return {url:'https://example.test/page',status:'complete'};},async sendMessage(id,m){if(m.type==='agent:execute'){executed++;throw Error('port closed');}observed++;return {ok:true,value:{snapshotId:'new',page:{}}};}}};
 const r=await createBrowserTools(chrome).execute(1,{url:'https://example.test/page',plan:{action:'click'}});
 assert.equal(executed,1);assert.equal(observed,1);assert.equal(r.connection,'reconnected');assert.equal(r.navigation,false);
});

test('lost response during navigation waits without sending another action',async()=>{
 let calls=0;const chrome={tabs:{async get(){return {url:'https://example.test/review',status:'loading'};},async sendMessage(){calls++;throw Error('port closed');}}};
 const r=await createBrowserTools(chrome).execute(1,{url:'https://example.test/page'});
 assert.equal(calls,1);assert.equal(r.navigation,true);assert.equal(r.connection,'document_changed');
});

test('explicit tool failures do not get mislabeled as navigation or recovered connection',async()=>{
 const chrome={tabs:{async sendMessage(){return {ok:false,error:'目标不支持'};}}};
 await assert.rejects(()=>createBrowserTools(chrome).execute(1,{}),e=>e.code==='TOOL_ERROR');
});


test('loading tab without receiver reconnects read-only to an interactive document',async()=>{
 let injected=0,observed=0;
 const chrome={tabs:{async get(){return {url:'https://example.test/page',status:'loading'};},async sendMessage(id,m){assert.equal(m.type,'agent:observe');observed++;if(!injected)throw Error('No receiver');return {ok:true,value:{readyState:'interactive'}};}},scripting:{async executeScript(){injected++;}}};
 const snap=await createBrowserTools(chrome).observe(1);
 assert.equal(snap.readyState,'interactive');assert.equal(injected,1);assert.equal(observed,2);
});

test('reconnecting an observation preserves its bounded reading scope',async()=>{
 const messages=[];let injected=0;
 const chrome={tabs:{async get(){return {url:'https://example.test/page',status:'complete'};},async sendMessage(id,m){messages.push(m);if(messages.length===1)throw Error('No receiver');return {ok:true,value:{page:{elementRange:{total:1}}}};}},scripting:{async executeScript(){injected++;}}};
 const value={query:'Late target',elementOffset:120};
 await createBrowserTools(chrome).observe(1,value);
 assert.equal(injected,1);assert.deepEqual(messages,[{type:'agent:observe',textOffset:value},{type:'agent:observe',textOffset:value}]);
});
