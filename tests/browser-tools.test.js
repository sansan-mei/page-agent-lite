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

test('trusted navigation enforces origin, permission and a consumed snapshot, never retries unknown update',async()=>{
 let granted=true,current='https://example.test/page',updates=0,prepared=0,fail=false;
 const chrome={permissions:{async contains(){return granted;}},tabs:{async get(){return {url:current,status:'complete'};},async sendMessage(id,m){assert.equal(m.type,'agent:prepare-navigation');prepared++;return {ok:true,value:{prepared:true}};},async update(id,opts){updates++;assert.equal(opts.url,'https://example.test/next');if(fail)throw Error('Lost response');}}};
 const tools=createBrowserTools(chrome),pending={url:current,documentId:'doc',snapshotId:'s',plan:{action:'navigate',value:'https://example.test/next'}};
 let r=await tools.execute(1,pending);assert.equal(r.dispatch,'sent');assert.equal(r.navigation,true);assert.equal(prepared,1);
 fail=true;r=await tools.execute(1,pending);assert.equal(r.dispatch,'unknown');assert.equal(updates,2);
 for(const value of ['javascript:alert(1)','https://user:pass@example.test/next'])await assert.rejects(()=>tools.execute(1,{...pending,plan:{action:'navigate',value}}),e=>e.code==='NAVIGATION_DENIED');
 granted=false;await assert.rejects(()=>tools.execute(1,pending),e=>e.code==='PERMISSION_DENIED');granted=true;
 current='https://example.test/changed';await assert.rejects(()=>tools.execute(1,pending),e=>e.code==='STALE');assert.equal(updates,2);
});


test('startup tab inventory returns IDs only and propagates query failure',async()=>{
 const chrome={tabs:{async query(options){assert.deepEqual(options,{});return [{id:1,url:'https://private.test',title:'Private'},{id:2},{id:null}];}}};
 assert.deepEqual(await createBrowserTools(chrome).existingTabIds(),[1,2]);chrome.tabs.query=async()=>{throw Error('unavailable');};await assert.rejects(()=>createBrowserTools(chrome).existingTabIds(),/unavailable/);
});


test('destination host permission and final cancellation are checked before cross-origin tabs.update',async()=>{
 const calls=[];let destinationGranted=false,live=true;
 const chrome={permissions:{async contains({origins}){return origins[0].startsWith('https://a.test')||destinationGranted;}},tabs:{async get(){return {url:'https://a.test/start'};},async sendMessage(id,message){calls.push(message.type);return {ok:true,value:{prepared:true}};},async update(){calls.push('update');}}};
 const tools=createBrowserTools(chrome),pending={url:'https://a.test/start',plan:{action:'navigate',value:'https://b.test/next'}},policy={origin:'https://a.test',allowedOrigins:['https://a.test','https://b.test']};
 await assert.rejects(()=>tools.execute(1,pending,policy,async()=>live),e=>e.code==='PERMISSION_DENIED');assert.deepEqual(calls,[]);destinationGranted=true;live=false;await assert.rejects(()=>tools.execute(1,pending,policy,async()=>live),e=>e.code==='CANCELLED');assert.deepEqual(calls,['agent:prepare-navigation']);live=true;await tools.execute(1,pending,policy,async()=>live);assert.equal(calls.filter(c=>c==='update').length,1);
});

test('origin policy prevents destination injection, observation and verification after a boundary change',async()=>{
 const calls=[];const chrome={permissions:{async contains(){return true;}},tabs:{async get(){return {url:'https://c.test/unapproved'};},async sendMessage(){calls.push('read');}},scripting:{async executeScript(){calls.push('inject');}}},tools=createBrowserTools(chrome),policy={origin:'https://a.test',allowedOrigins:['https://a.test','https://b.test']};
 for(const run of [()=>tools.observe(1,0,policy),()=>tools.verify(1,{expected:[]},policy),()=>tools.inject(1,policy)])await assert.rejects(run,e=>e.code==='ORIGIN_BOUNDARY');assert.deepEqual(calls,[]);
});


test('browser metadata permits internal tabs but navigation still requires exact task and host grants',async()=>{
 let updates=0,messages=0,granted=false,url='chrome://newtab/';
 const chrome={permissions:{async contains(){return granted;}},tabs:{async get(){return {url,status:'complete'};},async sendMessage(){messages++;throw Error('no internal injection');},async update(id,value){updates++;url=value.url;}}};
 const tools=createBrowserTools(chrome),pending={url,plan:{action:'navigate',value:'https://example.test/'}};
 assert.equal((await tools.tab(1,true)).url,url);await assert.rejects(()=>tools.tab(1),e=>e.code==='UNSUPPORTED_PAGE');
 await assert.rejects(()=>tools.execute(1,pending,{origin:'browser',allowedOrigins:[]}),e=>e.code==='PERMISSION_DENIED');
 await assert.rejects(()=>tools.execute(1,pending,{origin:'browser',allowedOrigins:['https://example.test']}),e=>e.code==='PERMISSION_DENIED');
 granted=true;const outcome=await tools.execute(1,pending,{origin:'browser',allowedOrigins:['https://example.test']});assert.equal(outcome.dispatch,'sent');assert.equal(updates,1);assert.equal(messages,0);
 await assert.rejects(()=>tools.execute(1,pending,{origin:'browser',allowedOrigins:['https://example.test']}),e=>e.code==='STALE');assert.equal(updates,1);
});

test('hover moves the real mouse once through a short debugger session and falls back without replaying',async()=>{
 const T=require('../extension/tool-protocol.js');
 const make=({url='https://a.test/p',attach,send,action='hover'}={})=>{
  const calls=[];
  const chrome={permissions:{async contains(){return true;}},tabs:{async get(){return {url,status:'complete'};},async sendMessage(id,m){calls.push(m.type);return {ok:true,value:T.result({operationId:'op',status:'unknown',dispatch:'sent',code:'NO_CHANGE',recovery:'observe',observed:{input:action,point:{x:12,y:34}},message:'操作已发出'})};}},
   debugger:{async attach(t,v){calls.push(['attach',t.tabId,v]);if(attach)throw Error(attach);},async sendCommand(t,method,params){calls.push([method,params.type,params.x,params.y]);if(send)throw Error(send);},async detach(t){calls.push(['detach',t.tabId]);}}};
  return {calls,run:(live)=>createBrowserTools(chrome).execute(7,{operationId:'op',url:'https://a.test/p',plan:{action}},{origin:'https://a.test',allowedOrigins:['https://a.test']},live)};
 };
 let f=make();let r=await f.run(async()=>true);
 assert.deepEqual(f.calls,['agent:execute',['attach',7,'1.3'],['Input.dispatchMouseEvent','mouseMoved',12,34],['detach',7]]);
 assert.equal(r.code,'TRUSTED_HOVER');assert.equal(r.observed.pointer,'trusted');assert.equal(r.dispatch,'sent');
 f=make({attach:'Another debugger is already attached'});r=await f.run();
 assert.deepEqual(f.calls,['agent:execute',['attach',7,'1.3']]);assert.equal(r.code,'NO_CHANGE');assert.equal(r.observed.pointer,'synthetic');assert.match(r.message,/真实鼠标未移动/);
 f=make({send:'boom'});r=await f.run();
 assert.deepEqual(f.calls.slice(-1),[['detach',7]]);assert.equal(r.observed.pointer,'synthetic');
 f=make({url:'https://a.test/other'});r=await f.run();
 assert.deepEqual(f.calls,['agent:execute']);assert.equal(r.observed.pointer,'synthetic');
 f=make();r=await f.run(async()=>false);
 assert.deepEqual(f.calls,['agent:execute']);
 f=make({action:'click'});r=await f.run();
 assert.deepEqual(f.calls,['agent:execute']);assert.equal(r.code,'NO_CHANGE');
});
