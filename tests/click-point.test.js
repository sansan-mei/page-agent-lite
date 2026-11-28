const {test}=require('node:test');const assert=require('node:assert/strict');
const C=require('../extension/core.js');const P=require('../extension/prompts.js');
const {createBrowserTools}=require('../extension/browser-tools.js');
const {createRuntime}=require('../extension/runtime.js');

test('agentPlan: click_point takes value {x,y} in screenshot pixels and nothing else',()=>{
  const snap={nodes:new Map([['t0',true]])},plan=p=>C.agentPlan(JSON.stringify({reply:'tap',action:'click_point',...p}),snap);
  assert.deepEqual(plan({value:{x:10,y:20.5}}).value,{x:10,y:20.5});
  assert.equal(plan({value:{x:0,y:0},expected:[{kind:'url_changed'}]}).expected.length,1);
  for(const bad of [{},{value:{x:1}},{value:{x:1,y:2,z:3}},{value:{x:-1,y:2}},{value:{x:1,y:10001}},{value:{x:'1',y:2}},{value:[1,2]},{value:'1,2'},{id:'t0',value:{x:1,y:2}}])
    assert.throws(()=>plan(bad),undefined,JSON.stringify(bad));
  assert.equal(C.agentTool('click_point').route,'browser');assert.equal(C.agentTool('click_point').effect,'page');
});

test('click_point is offered only with the vision capability, in both protocols',()=>{
  const names=caps=>P.agentTools(caps).map(t=>t.function.name);
  assert.ok(!names().includes('click_point'));assert.ok(!names({scripts:true}).includes('click_point'));
  assert.ok(names({vision:true}).includes('click_point'));
  const tool=P.agentTools({vision:true}).find(t=>t.function.name==='click_point');
  assert.deepEqual(tool.function.parameters.required,['reply','value']);assert.deepEqual(tool.function.parameters.properties.value.required,['x','y']);
  assert.doesNotMatch(P.agentSystem('English','native'),/click_point/);assert.doesNotMatch(P.agentSystem('English','json'),/click_point/);
  assert.match(P.agentSystem('English','native',{vision:true}),/click_point[^.]*latest viewport screenshot/);
  assert.match(P.agentSystem('English','json',{vision:true}),/action \([^)]*\bclick_point\b/);
  const text=P.agentSystem('English','native',{vision:true})+JSON.stringify(P.agentTools({vision:true}));
  assert.ok(text.startsWith('You are Page Agent Lite'));assert.doesNotMatch(text,/hermes|claude|chatgpt|openai|captcha|验证码/i);
});

// Runtime with an in-memory store, a scripted page, an image service and a recording executor.
function fixture(replies,{mode='supported',documentId=()=>'d1',clock=null,view={area:{left:0,top:0,width:1600,height:1200},viewport:{width:1600,height:1200},scroll:{x:0,y:300}}}={}){
  const data=new Map(),models=[],executed=[],stored=new Set();let seq=0;
  const store={async get(id){return structuredClone(data.get(id)||null);},async set(id,t){data.set(id,structuredClone(t));},async remove(id){data.delete(id);},async list(){return [...data.values()].map(t=>structuredClone(t));}};
  const images={mode:async()=>mode,async recognize(){return 'TEXT';},async saveShot(){const id='shot_'+String(++seq).padStart(8,'0');stored.add(id);return id;},
    async dropShots(taskId,keep){for(const id of [...stored])if(!keep.includes(id))stored.delete(id);},async present(ids){return ids.filter(id=>stored.has(id));},async remove(){},async prune(){}};
  const tools={async tab(id){return {id,url:'https://a.test/',status:'complete'};},
    async observe(){return {url:'https://a.test/',documentId:documentId(),snapshotId:'s'+(++seq),page:{text:'page',elements:[{id:'t0',key:'k0',label:'Board',tag:'canvas'}],regions:[]}};},
    async screenshot(){return {data:'SlBFRw==',masked:0,width:800,height:600,view:structuredClone(view)};},
    async execute(tabId,pending,policy){executed.push({pending:structuredClone(pending),policy,phase:data.get(tabId).phase});
      return {version:2,operationId:pending.operationId,documentId:pending.documentId,status:'unknown',dispatch:'sent',scope:'dispatch',code:'POINT_CLICKED',observed:{input:'cdp',target:'point',...pending.plan.value},evidence:[],recovery:'observe',message:'已按截图坐标发送真实点击'};},
    async releaseInput(){return true;}};
  const runtime=createRuntime({store,tools,images,schedule:()=>{},cancelSchedule:async()=>{},uuid:()=>'id'+(++seq),preferences:async()=>({maxSteps:50}),...(clock?{now:clock}:{}),
    model:async(text,signal,capabilities)=>{models.push({input:JSON.parse(text),capabilities:{...capabilities}});const next=replies.shift();return {text:JSON.stringify(next||{reply:'ok',action:'done'})};}});
  return {runtime,models,executed,data};
}
const last=task=>task.results.at(-1);
const look={reply:'look',action:'view_image',id:'viewport'},tap=(x,y)=>({reply:'tap',action:'click_point',value:{x,y}});

test('vision model: a point of the seen viewport screenshot becomes one real click at viewport CSS pixels',async()=>{
  const f=fixture([look,tap(100,50),tap(100,50)]);
  await f.runtime.start(1,'Press the square on the board');
  await f.runtime.tick(1);
  let task=await f.runtime.get(1);
  assert.equal(f.models[0].capabilities.vision,true);
  assert.equal(task.lastView.seen,false);assert.deepEqual(task.lastView.image,{width:800,height:600});
  await f.runtime.tick(1);
  task=await f.runtime.get(1);
  assert.equal(f.executed.length,1);
  const {pending,phase,policy}=f.executed[0];
  assert.equal(phase,'executing','checkpoint written before the side effect');
  assert.deepEqual(pending.point,{x:200,y:100},'800x600 image of a 1600x1200 viewport');
  assert.deepEqual(pending.view,{viewport:{width:1600,height:1200},scroll:{x:0,y:300}});
  assert.equal(pending.documentId,'d1');assert.equal(pending.url,'https://a.test/');assert.equal(policy.taskId,task.taskId);
  assert.equal(last(task).action,'click_point');assert.equal(last(task).outcome.observed.input,'cdp');assert.equal(last(task).outcome.observed.target,'point');
  assert.equal(task.phase,'observe','the page is re-observed after the click');assert.equal(task.lastView,null,'one click per screenshot');
  // A second click on the same screenshot is refused without dispatch.
  await f.runtime.tick(1);
  task=await f.runtime.get(1);
  assert.equal(f.executed.length,1);assert.equal(last(task).outcome.code,'POINT_NO_SCREENSHOT');assert.equal(last(task).outcome.dispatch,'not_sent');
});

test('click_point is refused before dispatch without vision, before the screenshot was seen, on another document, when stale or outside',async()=>{
  const blind=fixture([tap(1,1)],{mode:'unsupported'});
  await blind.runtime.start(1,'Tap');await blind.runtime.tick(1);
  assert.equal(blind.models[0].capabilities.vision,false);
  assert.equal(last(await blind.runtime.get(1)).outcome.code,'POINT_UNAVAILABLE');assert.equal(blind.executed.length,0);

  const unseen=fixture([tap(1,1)]);
  await unseen.runtime.start(1,'Tap');await unseen.runtime.tick(1);
  assert.equal(last(await unseen.runtime.get(1)).outcome.code,'POINT_NO_SCREENSHOT');

  let doc='d1';const moved=fixture([look,tap(1,1)],{documentId:()=>doc});
  await moved.runtime.start(1,'Tap');await moved.runtime.tick(1);doc='d2';await moved.runtime.tick(1);
  assert.equal(last(await moved.runtime.get(1)).outcome.code,'POINT_NO_SCREENSHOT');assert.equal(moved.executed.length,0);

  let time=1000;const old=fixture([look,tap(1,1)],{clock:()=>time});
  await old.runtime.start(1,'Tap');await old.runtime.tick(1);time+=60001;await old.runtime.tick(1);
  assert.equal(last(await old.runtime.get(1)).outcome.code,'POINT_NO_SCREENSHOT');assert.equal(old.executed.length,0);

  const outside=fixture([look,tap(800,10)]);
  await outside.runtime.start(1,'Tap');await outside.runtime.tick(1);await outside.runtime.tick(1);
  assert.equal(last(await outside.runtime.get(1)).outcome.code,'POINT_OUTSIDE');assert.equal(outside.executed.length,0);

  const element=fixture([{reply:'look',action:'view_image',id:'t0'},tap(1,1)]);
  await element.runtime.start(1,'Tap');await element.runtime.tick(1);
  assert.equal((await element.runtime.get(1)).lastView,null,'element screenshots do not define click coordinates');
  await element.runtime.tick(1);
  assert.equal(last(await element.runtime.get(1)).outcome.code,'POINT_NO_SCREENSHOT');assert.equal(element.executed.length,0);
});

// browser-tools: geometry check against the screenshot, then move/press/release through the debugger.
function browser({viewport={documentId:'d1',url:'https://a.test/',viewport:{width:1600,height:1200},scroll:{x:0,y:300}},send=null}={}){
  const log=[],messages=[],attached=new Set();
  const chrome={permissions:{async contains(){return true;}},
    debugger:{onDetach:{addListener(){}},async attach({tabId}){attached.add(tabId);},async detach({tabId}){attached.delete(tabId);},
      async sendCommand({tabId},method,p){log.push([method,p.type,p.x,p.y]);if(send)await send(p);return {};}},
    tabs:{async get(){return {url:'https://a.test/',status:'complete'};},async sendMessage(id,m){messages.push(m);return m.type==='agent:viewport'?{ok:true,value:structuredClone(viewport)}:{ok:false,error:'unexpected'};}}};
  return {tools:createBrowserTools(chrome),log,messages};
}
const policy={taskId:'task-1',origin:'https://a.test',allowedOrigins:['https://a.test']};
const pending={operationId:'op1',documentId:'d1',snapshotId:'s1',url:'https://a.test/',label:'坐标 (100,50)',plan:{action:'click_point',value:{x:100,y:50},reply:'x'},expected:[],point:{x:200,y:100},view:{viewport:{width:1600,height:1200},scroll:{x:0,y:300}}};

test('browser-tools click_point: checks the page still matches the screenshot, then sends one real click',async()=>{
  const f=browser(),r=await f.tools.execute(1,structuredClone(pending),policy,async()=>true);
  assert.deepEqual(f.messages.map(m=>m.type),['agent:viewport']);assert.equal(f.messages[0].expectedOrigin,'https://a.test');
  assert.deepEqual(f.log,[['Input.dispatchMouseEvent','mouseMoved',200,100],['Input.dispatchMouseEvent','mousePressed',200,100],['Input.dispatchMouseEvent','mouseReleased',200,100]]);
  assert.equal(r.code,'POINT_CLICKED');assert.equal(r.dispatch,'sent');assert.equal(r.status,'unknown');assert.equal(r.recovery,'observe');
  assert.deepEqual(r.observed,{input:'cdp',target:'point',x:100,y:50});
});

test('browser-tools click_point: scroll, resize or a new document voids the point; a failure after the press is unknown, never resent',async()=>{
  for(const [name,view] of [['scrolled',{scroll:{x:0,y:900}}],['resized',{viewport:{width:1200,height:1200}}],['new document',{documentId:'d2'}]]){
    const f=browser({viewport:{documentId:'d1',url:'https://a.test/',viewport:{width:1600,height:1200},scroll:{x:0,y:300},...view}});
    const r=await f.tools.execute(1,structuredClone(pending),policy,async()=>true);
    assert.equal(r.code,'POINT_STALE',name);assert.equal(r.dispatch,'not_sent',name);assert.deepEqual(f.log,[],name);
  }
  const cancelled=browser(),c=await cancelled.tools.execute(1,structuredClone(pending),policy,async()=>false);
  assert.equal(c.dispatch,'not_sent');assert.deepEqual(cancelled.log,[]);
  const broken=browser({send:p=>{if(p.type==='mousePressed')throw Error('gone');}});
  const r=await broken.tools.execute(1,structuredClone(pending),policy,async()=>true);
  assert.equal(r.status,'unknown');assert.equal(r.dispatch,'unknown');assert.equal(r.recovery,'observe');
  assert.deepEqual(broken.log.map(e=>e[1]),['mouseMoved','mousePressed'],'nothing is resent');
});

test('backend passes the vision capability through to the native tools of the request',async()=>{
  const backend=require('../extension/backend.js');
  const data={config:{endpoint:'https://api.test/v1',key:'K',model:'m',language:'English'}},bodies=[];
  const chrome={runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p},storage:{local:{async setAccessLevel(){},async get(k){return {[k]:structuredClone(data[k])};},async set(v){Object.assign(data,structuredClone(v));}}},permissions:{async contains(){return true;}}};
  const reply=()=>new Response(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:'c',type:'function',function:{name:'observe',arguments:'{"reply":"x"}'}}]}}]}));
  const s=backend.createService(chrome,async(url,opts)=>{bodies.push(JSON.parse(opts.body));return reply();});
  await s.generateAgent('observe',null,{vision:true});await s.generateAgent('observe',null,{});
  assert.ok(bodies[0].tools.some(t=>t.function.name==='click_point'));assert.match(bodies[0].messages[0].content,/click_point/);
  assert.ok(!bodies[1].tools.some(t=>t.function.name==='click_point'));assert.doesNotMatch(bodies[1].messages[0].content,/click_point/);
});
