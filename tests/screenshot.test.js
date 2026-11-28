const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const vm=require('node:vm');const {parseHTML}=require('linkedom');
const C=require('../extension/core.js');
const {create,METHODS}=require('../extension/cdp-tools.js');
const {createBrowserTools}=require('../extension/browser-tools.js');
// Real input & screenshots switch on (settings page); tests of the off state use their own storage.
const ENABLED={local:{async get(){return {debuggerEnabled:true};}}};

// Fake chrome.debugger: records attach/detach and every command with its parameters.
function fakeDebugger({send}={}){
  const log=[];const attached=new Set();
  const api={onDetach:{addListener(){}},
    async attach({tabId}){log.push(['attach',tabId]);attached.add(tabId);},
    async detach({tabId}){log.push(['detach',tabId]);if(!attached.delete(tabId))throw Error('not attached');},
    async sendCommand({tabId},method,params){log.push(['send',tabId,method,structuredClone(params)]);if(send)return send(method,params);return {data:'SlBFRw=='};}};
  return {api,log,commands:()=>log.filter(e=>e[0]==='send')};
}
const URL1='https://example.test/page';
const policy={taskId:'task-1',origin:'https://example.test',allowedOrigins:['https://example.test'],sensitiveFields:false,inputApproval:'action'};

test('cdp: Page.captureScreenshot is allow-listed only as a bounded JPEG clip of the viewport',async()=>{
  const ok={format:'jpeg',quality:70,clip:{x:0,y:100,width:800,height:600,scale:1},captureBeyondViewport:false,fromSurface:true};
  const valid=METHODS['Page.captureScreenshot'];
  assert.equal(valid(ok),true);
  for(const bad of [{...ok,format:'png'},{...ok,captureBeyondViewport:true},{...ok,clip:{...ok.clip,scale:2}},{...ok,clip:{...ok.clip,x:-1}},{...ok,clip:{...ok.clip,width:0}},{...ok,clip:{...ok.clip,selector:'#a'}},{...ok,extra:1},{format:'jpeg'}])assert.equal(valid(bad),false,JSON.stringify(bad));
  const f=fakeDebugger(),cdp=create({storage:ENABLED,debugger:f.api});
  assert.equal(await cdp.capture(4,'task-1',{x:0,y:100,width:800,height:600,scale:1}),'SlBFRw==');
  assert.deepEqual(f.commands().map(e=>[e[2],e[3].format,e[3].clip.y]),[['Page.captureScreenshot','jpeg',100]]);
  await assert.rejects(()=>cdp.capture(4,'task-1',{x:0,y:0,width:10,height:10,scale:1.5}),e=>e.code==='CDP_METHOD_DENIED');
  const slow=create({storage:ENABLED,debugger:fakeDebugger({send:()=>new Promise(()=>{})}).api});
  await assert.rejects(()=>slow.capture(5,'task-1',{x:0,y:0,width:10,height:10,scale:1},null,10),e=>e.code==='CAPTURE_TIMEOUT');
  const junk=create({storage:ENABLED,debugger:fakeDebugger({send:()=>({data:'<svg>'})}).api});
  await assert.rejects(()=>junk.capture(6,'task-1',{x:0,y:0,width:10,height:10,scale:1}),e=>e.code==='CAPTURE_FAILED');
});

// Browser tools with scripted content-script replies; the tab is never activated or focused.
function shotTools({shot=()=>({ok:true,value:{area:{left:0,top:0,width:800,height:600},viewport:{width:800,height:600},scroll:{x:0,y:1000},dpr:2,masked:1}}),debug=fakeDebugger()}={}){
  const messages=[];
  const chrome={storage:ENABLED,debugger:debug.api,permissions:{async contains(){return true;}},
    tabs:{async get(){return {url:URL1,status:'complete',active:false};},async sendMessage(id,m){messages.push(m);
      const reply=m.type==='agent:shot'?shot(m):{ok:true,value:{cleared:true}};if(reply instanceof Error)throw reply;return reply;}}};
  return {tools:createBrowserTools(chrome),messages,debug};
}

test('screenshot: viewport and element clips are computed from the content measurement plus scroll, long edge <= 1568',async()=>{
  let f=shotTools();
  const r=await f.tools.screenshot(1,{operationId:'op1',id:null,snapshotId:'s1',url:URL1},policy,async()=>true);
  assert.equal(r.data,'SlBFRw==');assert.equal(r.masked,1);
  const clip=f.debug.commands()[0][3].clip;
  assert.deepEqual([clip.x,clip.y,clip.width,clip.height],[0,1000,800,600],'document coordinates = viewport area + scroll');
  assert.ok(Math.max(clip.width,clip.height)*clip.scale*2<=1568,'device pixels on the long edge stay within 1568');
  assert.deepEqual(f.messages.map(m=>m.type),['agent:shot','agent:unshot']);
  assert.equal(f.messages[0].expectedOrigin,'https://example.test');assert.equal(f.messages[0].sensitiveFields,false);assert.equal('id' in f.messages[0],false);
  f=shotTools({shot:m=>({ok:true,value:{area:{left:10,top:20,width:3000,height:200},viewport:{width:3200,height:900},scroll:{x:5,y:40},dpr:1,masked:0}})});
  const element=await f.tools.screenshot(1,{operationId:'op2',id:'t3',snapshotId:'s1',url:URL1},policy,async()=>true);
  const c=f.debug.commands()[0][3].clip;
  assert.equal(f.messages[0].id,'t3');assert.deepEqual([c.x,c.y,c.width,c.height],[15,60,3000,200]);
  assert.ok(c.scale<=1568/3000&&element.width<=1568);
  // A measurement outside the viewport is refused before any capture.
  f=shotTools({shot:()=>({ok:true,value:{area:{left:0,top:0,width:900,height:10},viewport:{width:800,height:600},scroll:{x:0,y:0},dpr:1}})});
  await assert.rejects(()=>f.tools.screenshot(1,{operationId:'op3',snapshotId:'s1',url:URL1},policy,async()=>true),e=>e.code==='CAPTURE_FAILED');
  assert.equal(f.debug.commands().length,0);
});

test('screenshot: a failed mask captures nothing; the cover is removed even when the capture fails',async()=>{
  let f=shotTools({shot:()=>({ok:false,code:'MASK_FAILED',error:'无法遮盖敏感字段，未截图'})});
  await assert.rejects(()=>f.tools.screenshot(1,{operationId:'op1',snapshotId:'s1',url:URL1},policy,async()=>true),e=>e.code==='MASK_FAILED');
  assert.deepEqual(f.debug.log,[],'no debugger attach and no capture');
  assert.deepEqual(f.messages.map(m=>m.type),['agent:shot','agent:unshot']);
  f=shotTools({debug:fakeDebugger({send:()=>{throw new Error('Target closed');}})});
  await assert.rejects(()=>f.tools.screenshot(1,{operationId:'op2',snapshotId:'s1',url:URL1},policy,async()=>true),e=>e.code==='CDP_COMMAND_FAILED');
  assert.deepEqual(f.messages.map(m=>m.type),['agent:shot','agent:unshot']);assert.equal(f.messages[1].shotId,'op2');
  // Stopped between the measurement and the capture: nothing is captured, the cover still goes.
  f=shotTools();
  await assert.rejects(()=>f.tools.screenshot(1,{operationId:'op3',snapshotId:'s1',url:URL1},policy,async()=>false),e=>e.code==='CANCELLED');
  assert.equal(f.debug.commands().length,0);assert.equal(f.messages.at(-1).type,'agent:unshot');
});

// Content script + core in linkedom. Mask boxes report their inline position as their layout box.
function page(html,setup){
  const {document,window}=parseHTML(`<html><body>${html}</body></html>`);
  window.innerWidth=800;window.innerHeight=600;window.scrollX=0;window.scrollY=300;window.devicePixelRatio=1;
  window.getComputedStyle=()=>({display:'block',visibility:'visible',opacity:'1'});
  const proto=Object.getPrototypeOf(document.createElement('div'));const original=proto.getBoundingClientRect;
  proto.getBoundingClientRect=function(){
    if(this.parentElement?.getAttribute('data-page-agent')==='mask'){const s=this.style;return {left:parseFloat(s.left),top:parseFloat(s.top),width:parseFloat(s.width),height:parseFloat(s.height)};}
    return original.call(this);
  };
  setup?.(document,window);
  let listener;const chrome={runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,onMessage:{addListener(fn){listener=fn;}},async sendMessage(){return {ok:true};}}};
  vm.runInNewContext(fs.readFileSync('extension/content.js','utf8'),{PageAgentCore:C,PageAgentConditions:require('../extension/conditions.js'),PageAgentProtocol:require('../extension/tool-protocol.js'),chrome,document,location:{href:'https://example.test/'},crypto,Date,setTimeout:(fn,ms)=>ms>1000?0:setImmediate(fn),clearTimeout(){}});
  const send=m=>new Promise(r=>listener(m,{id:'test',url:'chrome-extension://test/background.js'},r));
  return {document,send,restore:()=>{proto.getBoundingClientRect=original;}};
}
const masks=document=>[...document.querySelectorAll('[data-page-agent="mask"] div')].map(b=>[b.style.left,b.style.top,b.style.width,b.style.height]);

test('content: sensitive fields and unreadable frames are covered during the capture and uncovered afterwards',async()=>{
  const f=page('<label>Name <input id="n" type="text"></label><input id="pw" type="password"><input id="otp" autocomplete="one-time-code"><iframe id="pay" src="https://pay.test/"></iframe>',d=>{
    d.getElementById('pw').getBoundingClientRect=()=>({left:10,top:20,width:100,height:30});
    d.getElementById('otp').getBoundingClientRect=()=>({left:10,top:60,width:100,height:30});
    d.getElementById('n').getBoundingClientRect=()=>({left:10,top:100,width:100,height:30});
    d.getElementById('pay').getBoundingClientRect=()=>({left:200,top:0,width:300,height:200});
  });
  try{
    const snap=(await f.send({type:'agent:observe'})).value;
    const shot=await f.send({type:'agent:shot',shotId:'op1',snapshotId:snap.snapshotId,url:snap.url});
    assert.equal(shot.ok,true,shot.error);
    assert.equal(JSON.stringify(shot.value.area),'{"left":0,"top":0,"width":800,"height":600}');assert.equal(JSON.stringify(shot.value.scroll),'{"x":0,"y":300}');assert.equal(shot.value.masked,3);
    assert.deepEqual(masks(f.document),[['8px','18px','104px','34px'],['8px','58px','104px','34px'],['198px','0px','304px','202px']],'password, one-time code and the cross-origin frame; the plain field stays visible');
    assert.equal(f.document.querySelector('[data-page-agent="mask"]').parentElement,f.document.documentElement);
    assert.equal((await f.send({type:'agent:unshot',shotId:'other'})).ok,true);assert.equal(masks(f.document).length,3,'another shot id cannot remove the cover');
    await f.send({type:'agent:unshot',shotId:'op1'});
    assert.equal(f.document.querySelector('[data-page-agent]'),null);
    // With the sensitive-field grant only file inputs would be covered.
    const granted=await f.send({type:'agent:shot',shotId:'op2',snapshotId:snap.snapshotId,url:snap.url,sensitiveFields:true});
    assert.equal(granted.value.masked,0);assert.equal(f.document.querySelector('[data-page-agent]'),null);
    // A stale snapshot is refused.
    assert.equal((await f.send({type:'agent:shot',shotId:'op3',snapshotId:'old',url:snap.url})).code,'STALE');
  }finally{f.restore();}
});

test('content: a cover that cannot be measured or placed fails closed and leaves nothing behind',async()=>{
  let f=page('<input id="pw" type="password">');
  try{
    const snap=(await f.send({type:'agent:observe'})).value;
    f.document.getElementById('pw').getBoundingClientRect=()=>{throw new Error('detached');};
    const r=await f.send({type:'agent:shot',shotId:'op1',snapshotId:snap.snapshotId,url:snap.url});
    assert.equal(r.ok,false);assert.equal(r.code,'MASK_FAILED');assert.equal(f.document.querySelector('[data-page-agent="mask"]'),null);
  }finally{f.restore();}
  // The page moves or hides the cover (e.g. a stylesheet or transform): the measured box does not match.
  f=page('<input id="pw" type="password">',(d,w)=>{d.getElementById('pw').getBoundingClientRect=()=>({left:10,top:20,width:100,height:30});w.getComputedStyle=n=>({display:n.parentElement?.getAttribute?.('data-page-agent')==='mask'?'none':'block',visibility:'visible',opacity:'1'});});
  try{
    const snap=(await f.send({type:'agent:observe'})).value;
    const r=await f.send({type:'agent:shot',shotId:'op1',snapshotId:snap.snapshotId,url:snap.url});
    assert.equal(r.code,'MASK_FAILED');assert.equal(f.document.querySelector('[data-page-agent="mask"]'),null);
  }finally{f.restore();}
});

test('content: an element target is scrolled into view and measured from the snapshot node',async()=>{
  let scrolled=0,top=900;
  const f=page('<button id="b">Chart</button>',d=>{const b=d.getElementById('b');b.getBoundingClientRect=()=>({left:40,top,right:240,bottom:top+100,width:200,height:100});b.scrollIntoView=()=>{scrolled++;top=250;};});
  try{
    const snap=(await f.send({type:'agent:observe'})).value;
    const id=snap.page.elements.find(e=>e.label==='Chart').id;
    const r=await f.send({type:'agent:shot',shotId:'op1',snapshotId:snap.snapshotId,url:snap.url,id});
    assert.equal(r.ok,true,r.error);assert.equal(scrolled,1);
    assert.equal(JSON.stringify(r.value.area),'{"left":40,"top":250,"width":200,"height":100}');
    assert.equal((await f.send({type:'agent:shot',shotId:'op2',snapshotId:snap.snapshotId,url:snap.url,id:'t99'})).code,'STALE');
    f.document.getElementById('b').remove();
    assert.equal((await f.send({type:'agent:shot',shotId:'op3',snapshotId:snap.snapshotId,url:snap.url,id})).code,'STALE');
  }finally{f.restore();}
});


test('screenshot without an approval from the runtime measures, masks and attaches nothing',async()=>{
  const f=shotTools();
  await assert.rejects(()=>f.tools.screenshot(1,{operationId:'op1',id:null,snapshotId:'s1',url:URL1},{...policy,inputApproval:undefined},async()=>true),e=>e.code==='REAL_INPUT_APPROVAL_REQUIRED');
  assert.deepEqual(f.debug.log,[]);assert.deepEqual(f.messages,[]);
});
