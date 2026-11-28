const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const {parseHTML}=require('linkedom');
const C=require('../extension/core.js');
const {createBrowserTools}=require('../extension/browser-tools.js');
const {createRuntime}=require('../extension/runtime.js');

// Fake chrome.debugger shared by the browser-tools tests.
function fakeDebugger(hooks={}){
 const log=[];let onDetach=null;const attached=new Set();
 const api={onDetach:{addListener(fn){onDetach=fn;}},
  async attach({tabId}){log.push(['attach',tabId]);if(hooks.attach)await hooks.attach();attached.add(tabId);},
  async detach({tabId}){log.push(['detach',tabId]);if(!attached.delete(tabId))throw Error('not attached');},
  async sendCommand({tabId},method,p){log.push(['send',p.type,p.x,p.y]);if(hooks.send)await hooks.send(tabId,p);if(!attached.has(tabId))throw Error('Detached');return {};}};
 return {api,log,detach:(tabId,reason)=>{attached.delete(tabId);onDetach({tabId},reason);}};
}
const URL1='https://example.test/page';
const policy={taskId:'task-1',origin:'https://example.test',allowedOrigins:['https://example.test']};
const pendingFor=(action='click',extra={})=>({operationId:'op1',documentId:'d1',snapshotId:'s1',url:URL1,label:'Go',plan:{action,id:'t0',reply:'x'},expected:[],...extra});
const synthetic=(extra={})=>({version:2,operationId:'op1',documentId:'d1',status:'unknown',dispatch:'sent',scope:'dispatch',code:'NO_CHANGE',observed:{input:'synthetic'},evidence:[],recovery:'observe',message:'操作已发出，暂未观察到页面变化',navigation:false,pageChange:'NO_CHANGE',...extra});
// Content-script replies are scripted per message type; every message is recorded.
function tools({execute=()=>({ok:true,value:synthetic()}),point=()=>({ok:true,value:{x:60,y:40}}),aim=()=>({ok:true,value:{x:60,y:40}}),settle=()=>({ok:true,value:{...synthetic({observed:{input:'cdp'},code:'PAGE_CHANGED',message:'操作已发出，页面有变化；具体效果待核对'}),pageChange:undefined}}),debug=fakeDebugger(),url=()=>URL1}={}){
 const messages=[];
 const chrome={debugger:debug.api,permissions:{async contains(){return true;}},tabs:{async get(){return {url:url(),status:'complete'};},async sendMessage(id,m){messages.push(m);
  const reply=m.type==='agent:execute'?execute(m):m.type==='agent:point'?point(m):m.type==='agent:aim'?aim(m):m.type==='agent:settle'?settle(m):{ok:true,value:{page:{}}};
  if(reply instanceof Error)throw reply;return reply;}}};
 return {tools:createBrowserTools(chrome),messages,debug};
}
const types=messages=>messages.map(m=>m.type);
const sends=log=>log.filter(e=>e[0]==='send').map(e=>e[1]);

const trustedPlan=(action='click')=>pendingFor(action,{plan:{action,id:'t0',reply:'x',trusted:true}});

test('a synthetic click with no visible change is never re-sent; the result only hints trusted:true',async()=>{
 const f=tools(),r=await f.tools.execute(1,pendingFor(),policy,async()=>true);
 assert.deepEqual(types(f.messages),['agent:execute']);assert.deepEqual(f.debug.log,[]);
 assert.equal(r.code,'NO_CHANGE');assert.equal(r.dispatch,'sent');assert.match(r.message,/trusted:true/);assert.equal(r.pageChange,undefined);
 const cases=[
  ['page changed',{execute:()=>({ok:true,value:synthetic({code:'PAGE_CHANGED',pageChange:'PAGE_CHANGED'})})}],
  ['expected met',{execute:()=>({ok:true,value:synthetic({status:'success',code:'CONDITIONS_MATCH',recovery:'none'})})}],
  ['high-risk label',{},pendingFor('click',{label:'提交订单'})],
  ['hover',{},pendingFor('hover')],
  ['not a click',{},pendingFor('press_key',{plan:{action:'press_key',id:'t0',value:'Enter',reply:'x'}})]
 ];
 for(const [name,options,pending] of cases){
  const g=tools(options),out=await g.tools.execute(1,pending||pendingFor(),policy,async()=>true);
  assert.deepEqual(types(g.messages),['agent:execute'],name);assert.deepEqual(g.debug.log,[],name);assert.notEqual(out.observed?.input,'cdp',name);
 }
 // TARGET_CHANGED (dispatch unknown) is thrown to the runtime as before; a lost reply only reconnects.
 const changed=tools({execute:()=>({ok:false,code:'TARGET_CHANGED',error:'变化',result:{code:'TARGET_CHANGED',dispatch:'unknown'}})});
 await assert.rejects(()=>changed.tools.execute(1,pendingFor(),policy,async()=>true),e=>e.code==='TARGET_CHANGED');
 const lost=tools({execute:()=>Error('port closed')});
 assert.equal((await lost.tools.execute(1,pendingFor(),policy,async()=>true)).connection,'reconnected');
 assert.deepEqual(changed.debug.log.concat(lost.debug.log),[]);
});

test('trusted:true sends only real input at the content-computed point, then settles without events',async()=>{
 const f=tools({aim:m=>{assert.equal(m.plan.trusted,true);assert.equal(m.snapshotId,'s1');assert.equal(m.expectedOrigin,'https://example.test');return {ok:true,value:{x:60,y:40}};}});
 const r=await f.tools.execute(1,trustedPlan(),policy,async()=>true);
 assert.deepEqual(types(f.messages),['agent:aim','agent:settle']);
 assert.deepEqual(f.debug.log.filter(e=>e[0]==='send'),[['send','mouseMoved',60,40],['send','mousePressed',60,40],['send','mouseReleased',60,40]]);
 assert.equal(r.observed.input,'cdp');assert.equal(r.observed.fallback,'trusted');assert.equal(r.dispatch,'sent');assert.match(r.message,/已发送真实输入/);
 const h=tools();await h.tools.execute(1,trustedPlan('hover'),policy,async()=>true);
 assert.deepEqual(sends(h.debug.log),['mouseMoved']);
 // Not sent: no task identity, frame-routed target, stopped run, lost aim reply. Stale/blocked targets throw like synthetic ones.
 for(const [name,opts,pending,pol,code] of [
  ['no task identity',{},trustedPlan(),{...policy,taskId:undefined},'CDP_UNAVAILABLE'],
  ['frame route',{},{...trustedPlan(),frameRoute:{frameId:3}},policy,'CDP_UNAVAILABLE'],
  ['lost aim reply',{aim:()=>Error('port closed')},trustedPlan(),policy,'CDP_SKIPPED']]){
  const g=tools(opts),out=await g.tools.execute(1,pending,pol,async()=>true);
  assert.equal(out.dispatch,'not_sent',name);assert.equal(out.code,'REAL_INPUT_NOT_SENT',name);assert.equal(out.observed.input,'none',name);assert.equal(out.observed.cdp.code,code,name);
  assert.deepEqual(sends(g.debug.log),[],name);assert.ok(!types(g.messages).includes('agent:execute'),name);
 }
 const stopped=tools(),gone=await stopped.tools.execute(1,trustedPlan(),policy,async()=>false);
 assert.equal(gone.observed.cdp.code,'CANCELLED');assert.deepEqual(stopped.messages,[]);
 const blocked=tools({aim:()=>({ok:false,code:'TARGET_BLOCKED',error:'遮挡',result:{code:'TARGET_BLOCKED',dispatch:'not_sent'}})});
 await assert.rejects(()=>blocked.tools.execute(1,trustedPlan(),policy,async()=>true),e=>e.code==='TARGET_BLOCKED');assert.deepEqual(blocked.debug.log,[]);
});

test('a run stopped before real input, or a disconnect mid-click, never dispatches again',async()=>{
 let live=true;const f=tools({aim:()=>{live=false;return {ok:true,value:{x:1,y:1}};}});
 const r=await f.tools.execute(1,trustedPlan(),policy,async()=>live);
 assert.deepEqual(sends(f.debug.log),[]);assert.equal(r.dispatch,'not_sent');assert.equal(r.observed.cdp.code,'CANCELLED');
 let debug;debug=fakeDebugger({send:(tabId,p)=>{if(p.type==='mousePressed')debug.detach(tabId,'target_closed');}});
 const g=tools({debug}),broken=await g.tools.execute(1,trustedPlan(),policy,async()=>true);
 assert.equal(broken.status,'unknown');assert.equal(broken.dispatch,'unknown');assert.equal(broken.code,'CDP_DETACHED');assert.equal(broken.recovery,'observe');
 assert.deepEqual(sends(debug.log),['mouseMoved','mousePressed']);assert.ok(!types(g.messages).includes('agent:settle'));
 // The real click navigated: report unknown and let the runtime wait for the page, never repeat.
 let url=URL1;const nav=tools({settle:()=>{url='https://example.test/next';return Error('port closed');},url:()=>url});
 const moved=await nav.tools.execute(1,trustedPlan(),policy,async()=>true);
 assert.equal(moved.code,'DOCUMENT_CHANGED');assert.equal(moved.navigation,true);assert.equal(moved.dispatch,'sent');assert.equal(sends(nav.debug.log).length,3);
});

test('unreachable target goes straight to real input; a cancelled infobar reports a stable code without sending',async()=>{
 const unreachable=()=>({ok:false,code:'SYNTHETIC_UNREACHABLE',error:'嵌入文档',result:{version:2,operationId:'op1',documentId:'d1',status:'unsupported',dispatch:'not_sent',scope:'dispatch',code:'SYNTHETIC_UNREACHABLE',observed:null,evidence:[],recovery:'replan',message:'嵌入文档'}});
 const f=tools({execute:unreachable}),r=await f.tools.execute(1,pendingFor(),policy,async()=>true);
 assert.deepEqual(types(f.messages),['agent:execute','agent:point','agent:settle']);assert.deepEqual(sends(f.debug.log),['mouseMoved','mousePressed','mouseReleased']);
 assert.equal(r.observed.input,'cdp');assert.equal(r.observed.fallback,'unreachable');assert.match(r.message,/合成事件无法到达/);
 // The user cancelled the infobar earlier in this task: no re-attach, the action stays not sent.
 const debug=fakeDebugger(),g=tools({execute:unreachable,debug});
 await g.tools.execute(1,pendingFor('hover'),policy,async()=>true);debug.detach(1,'canceled_by_user');
 const refused=await g.tools.execute(1,pendingFor(),policy,async()=>true);
 assert.equal(refused.dispatch,'not_sent');assert.equal(refused.code,'SYNTHETIC_UNREACHABLE');assert.equal(refused.observed.input,'none');assert.equal(refused.observed.cdp.code,'CDP_CANCELLED');
 assert.equal(debug.log.filter(e=>e[0]==='attach').length,1);
 // DevTools already attached: CDP_BUSY, nothing sent.
 const busy=fakeDebugger({attach:()=>{throw Error('Another debugger is already attached to the tab');}});
 busy.api.detach=async()=>{throw Error('not attached');};
 const b=await tools({execute:unreachable,debug:busy}).tools.execute(1,pendingFor(),policy,async()=>true);
 assert.equal(b.observed.cdp.code,'CDP_BUSY');assert.deepEqual(sends(busy.log),[]);
});

// Content script + core in linkedom: the point comes from the snapshot target, not from the model.
function page(html,setup){
 const {document,window}=parseHTML(`<html><body>${html}</body></html>`);
 window.innerWidth=800;window.innerHeight=600;window.MouseEvent=window.Event;setup?.(document,window);
 let listener;const chrome={runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,onMessage:{addListener(fn){listener=fn;}},async sendMessage(){return {ok:true};}}};
 vm.runInNewContext(fs.readFileSync('extension/content.js','utf8'),{PageAgentCore:C,PageAgentConditions:require('../extension/conditions.js'),PageAgentProtocol:require('../extension/tool-protocol.js'),chrome,document,location:{href:'https://example.test/'},crypto,Date,setTimeout:fn=>setImmediate(fn)});
 const send=m=>new Promise(r=>listener(m,{id:'test',url:'chrome-extension://test/background.js'},r));
 return {document,send};
}
const goButton=(onClick)=>d=>{const b=d.querySelector('button');b.getBoundingClientRect=()=>({left:10,right:110,top:20,bottom:60,width:100,height:40});d.elementFromPoint=()=>b;b.addEventListener('click',onClick);};

test('regression: a synthetic click whose effect appears after 3 s is dispatched exactly once',async()=>{
 // Like the smoke "Filter" fixture: the click handler updates the page only after a 3000 ms timer.
 let clicks=0;const later=[];
 const {document,send}=page('<button>Filter</button><p id="out">Idle</p>',goButton(()=>{later.push(()=>{clicks++;document.getElementById('out').textContent='Filtered';});}));
 const debug=fakeDebugger(),messages=[];
 const chrome={debugger:debug.api,permissions:{async contains(){return true;}},tabs:{async get(){return {url:'https://example.test/',status:'complete'};},async sendMessage(id,m){messages.push(m.type);return send(m);}}};
 const t=createBrowserTools(chrome),snap=(await send({type:'agent:observe'})).value;
 const r=await t.execute(1,{operationId:'op1',documentId:snap.documentId,snapshotId:snap.snapshotId,url:snap.url,label:'Filter',plan:{action:'click',id:'t0',reply:'x'},expected:[]},policy,async()=>true);
 assert.equal(r.code,'NO_CHANGE');assert.equal(r.dispatch,'sent');
 assert.deepEqual(messages,['agent:execute']);assert.deepEqual(debug.log,[],'no real-input re-click');
 for(const fn of later.splice(0))fn();
 assert.equal(clicks,1);assert.equal(document.getElementById('out').textContent,'Filtered');
 // After a dispatched synthetic click the content script refuses a real-input point for it.
 assert.equal((await send({type:'agent:point',operationId:'op1',url:snap.url})).code,'STALE');
});

test('content aims a trusted:true target without synthetic events and settles the real input once',async()=>{
 let clicks=0;
 const {document,send}=page('<button>Go</button><p id="out"></p>',goButton(()=>clicks++));
 const snap=(await send({type:'agent:observe'})).value,base={operationId:'op1',snapshotId:snap.snapshotId,url:snap.url};
 assert.equal((await send({type:'agent:aim',...base,plan:{action:'click',id:'t0',reply:'x'}})).code,'STALE','aim needs trusted:true');
 const again=(await send({type:'agent:observe'})).value,msg={operationId:'op1',snapshotId:again.snapshotId,url:again.url};
 assert.deepEqual((await send({type:'agent:aim',...msg,plan:{action:'click',id:'t0',reply:'x',trusted:true}})).value,{x:60,y:40});
 assert.equal(clicks,0,'no synthetic events');
 assert.equal((await send({type:'agent:aim',...msg,plan:{action:'click',id:'t0',reply:'x',trusted:true}})).code,'STALE','snapshot consumed');
 assert.equal((await send({type:'agent:point',operationId:'other',url:again.url})).code,'STALE');
 document.getElementById('out').textContent='Opened';
 const settled=await send({type:'agent:settle',operationId:'op1',url:again.url});
 assert.equal(settled.value.code,'PAGE_CHANGED');assert.equal(JSON.stringify(settled.value.observed),'{"input":"cdp"}');assert.equal(clicks,0,'settle sends no events');
 assert.equal((await send({type:'agent:settle',operationId:'op1',url:again.url})).code,'STALE','one real input per action');
 // A new observation drops the remembered target.
 const third=(await send({type:'agent:observe'})).value;
 assert.equal((await send({type:'agent:point',operationId:'op1',url:third.url})).code,'STALE');
});

test('an embedded document under the hit point is unreachable for synthetic events and nothing is dispatched',async()=>{
 let clicks=0;
 const {send}=page('<div tabindex="0" aria-label="Widget"><iframe title="Check"></iframe></div>',d=>{const w=d.querySelector('div'),f=d.querySelector('iframe');
  w.getBoundingClientRect=()=>({left:0,right:300,top:0,bottom:80,width:300,height:80});f.getBoundingClientRect=()=>({left:0,right:300,top:0,bottom:80,width:300,height:80});
  d.elementFromPoint=()=>f;w.addEventListener('pointerdown',()=>clicks++);w.addEventListener('click',()=>clicks++);});
 const snap=(await send({type:'agent:observe'})).value,id=snap.page.elements.find(e=>e.label==='Widget').id;
 const r=await send({type:'agent:execute',operationId:'op1',snapshotId:snap.snapshotId,url:snap.url,plan:{action:'click',id,reply:'x'}});
 assert.equal(r.ok,false);assert.equal(r.code,'SYNTHETIC_UNREACHABLE');assert.equal(r.result.dispatch,'not_sent');assert.equal(r.result.status,'unsupported');assert.equal(clicks,0);
 assert.deepEqual((await send({type:'agent:point',operationId:'op1',url:snap.url,reason:'unreachable'})).value,{x:150,y:40});
});

test('frame targets add the iframe offset; covered or changed targets get no point',()=>{
 const {document,window}=parseHTML('<html><body><iframe title="Pay"></iframe><div id="cover"></div></body></html>');
 window.innerWidth=800;window.innerHeight=600;
 const iframe=document.querySelector('iframe'),inner=parseHTML('<html><body><button>Pay</button></body></html>');
 Object.defineProperty(iframe,'contentDocument',{configurable:true,get:()=>inner.document});
 iframe.getBoundingClientRect=()=>({left:100,right:400,top:200,bottom:300,width:300,height:100});
 const button=inner.document.querySelector('button');button.getBoundingClientRect=()=>({left:10,right:50,top:10,bottom:30,width:40,height:20});
 inner.document.elementFromPoint=()=>button;let top=iframe;document.elementFromPoint=()=>top;
 const snap=C.agentSnapshot(document),ref=snap.nodes.get(snap.page.elements.find(e=>e.label==='Pay').id);
 assert.deepEqual(C.agentInputPoint(ref.node,snap,ref.signature),{x:130,y:220});
 top=document.getElementById('cover');
 assert.throws(()=>C.agentInputPoint(ref.node,snap,ref.signature),e=>e.code==='TARGET_BLOCKED');
 top=iframe;button.textContent='Refund';
 assert.throws(()=>C.agentInputPoint(ref.node,snap,ref.signature),e=>e.code==='STALE');
 // Coordinates are not part of any tool: the plan validator rejects them.
 assert.throws(()=>C.agentPlan(JSON.stringify({action:'click',id:'t0',reply:'x',x:5,y:6}),snap));
 // trusted is a boolean for click/hover only, in the plan whitelist and the native schema.
 const id=snap.page.elements.find(e=>e.label==='Pay').id;
 assert.equal(C.agentPlan(JSON.stringify({action:'click',id,reply:'x',trusted:true}),snap).trusted,true);
 assert.equal(C.agentPlan(JSON.stringify({action:'hover',id,reply:'x',trusted:false}),snap).trusted,false);
 assert.throws(()=>C.agentPlan(JSON.stringify({action:'click',id,reply:'x',trusted:'yes'}),snap));
 assert.throws(()=>C.agentPlan(JSON.stringify({action:'double_click',id,reply:'x',trusted:true}),snap));
 const tool=name=>require('../extension/prompts.js').agentTools().find(t=>t.function.name===name).function.parameters.properties;
 assert.deepEqual(tool('click').trusted,{type:'boolean'});assert.deepEqual(tool('hover').trusted,{type:'boolean'});assert.equal(tool('fill').trusted,undefined);
});

test('runtime passes its task identity and does not wait on an action that was not sent',async()=>{
 const data=new Map(),calls=[];let seq=0;
 const store={async get(id){return structuredClone(data.get(id)||null);},async set(id,t){data.set(id,structuredClone(t));},async remove(id){data.delete(id);},async list(){return [...data.values()];}};
 const tools={async tab(id){return {id,url:'https://example.test/1',status:'complete'};},
  async observe(){return {url:'https://example.test/1',documentId:'d1',snapshotId:'s'+(++seq),page:{text:'',elements:[{id:'t0',key:'node1',label:'Widget',tag:'div'}],regions:[{id:'r0',key:'node2',label:'Status',text:'Waiting'}]}};},
  async execute(tabId,pending,policy){calls.push(policy);return {version:2,operationId:pending.operationId,status:'unsupported',dispatch:'not_sent',scope:'dispatch',code:'SYNTHETIC_UNREACHABLE',observed:{input:'none',cdp:{code:'CDP_CANCELLED'}},evidence:[],recovery:'replan',message:'嵌入文档'};}};
 const plan={reply:'Check',action:'click',id:'t0',expected:[{kind:'text_present',id:'r0',value:'Done'}]};
 const runtime=createRuntime({store,tools,summarize:async()=>({text:'{}'}),schedule(){},cancelSchedule:async()=>{},uuid:()=>'u'+(++seq),preferences:async()=>({maxSteps:50,contextTokens:32768}),model:async()=>({text:JSON.stringify(plan)})});
 const task=await runtime.start(1,'Work');await runtime.tick(1);
 const t=await store.get(1);
 assert.equal(calls[0].taskId,task.taskId);
 assert.equal(t.status,'running');assert.equal(t.phase,'observe');assert.equal(t.check,null);
 assert.equal(t.results.at(-1).outcome.observed.cdp.code,'CDP_CANCELLED');
});
