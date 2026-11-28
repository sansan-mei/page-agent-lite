const {test}=require('node:test');const assert=require('node:assert/strict');
const {create,METHODS}=require('../extension/cdp-tools.js');
// Fake chrome.debugger: records attach/detach/commands; hooks let a test fail or detach at any step.
function fakeDebugger(hooks={}){
 const log=[];let onDetach=null;const attached=new Set();
 const api={
  onDetach:{addListener(fn){onDetach=fn;}},
  async attach({tabId},version){log.push(['attach',tabId,version]);if(hooks.attach)await hooks.attach(tabId);attached.add(tabId);},
  async detach({tabId}){log.push(['detach',tabId]);if(hooks.detach)await hooks.detach(tabId);if(!attached.delete(tabId))throw Error('Debugger is not attached to the tab with id: '+tabId);},
  async sendCommand({tabId},method,params){log.push(['send',tabId,method,params.type]);if(hooks.send)await hooks.send(tabId,method,params);if(!attached.has(tabId))throw Error('Detached while handling command.');return {};}
 };
 return {chrome:{debugger:api},log,attached,detach:(tabId,reason)=>{attached.delete(tabId);onDetach({tabId},reason);}};
}
const sends=log=>log.filter(e=>e[0]==='send').map(e=>e[3]);

test('attaches on first use, keeps one session per task and only sends allow-listed mouse input',async()=>{
 const f=fakeDebugger(),cdp=create(f.chrome);
 assert.deepEqual(f.log,[],'nothing attaches before real input is needed');
 assert.deepEqual(await cdp.input(7,'task-a','click',{x:10.004,y:20}),{dispatch:'sent',input:'cdp'});
 await cdp.input(7,'task-a','hover',{x:11,y:21});
 assert.deepEqual(f.log.filter(e=>e[0]==='attach'),[['attach',7,'1.3']]);
 assert.deepEqual(sends(f.log),['mouseMoved','mousePressed','mouseReleased','mouseMoved']);
 assert.ok(f.log.filter(e=>e[0]==='send').every(e=>e[2]==='Input.dispatchMouseEvent'));
 assert.deepEqual(Object.keys(METHODS),['Input.dispatchMouseEvent']);
 assert.equal(METHODS['Input.dispatchMouseEvent']({type:'mouseWheel',x:1,y:1,button:'none',buttons:0,clickCount:0,pointerType:'mouse'}),false);
 assert.equal(METHODS['Input.dispatchMouseEvent']({type:'mouseMoved',x:1,y:1,button:'none',buttons:0,clickCount:0,pointerType:'mouse',text:'x'}),false);
 await assert.rejects(()=>cdp.input(7,'task-a','double_click',{x:1,y:1}),e=>e.code==='CDP_METHOD_DENIED'&&e.dispatch==='not_sent');
 await assert.rejects(()=>cdp.input(7,'task-a','click',{x:NaN,y:1}),e=>e.code==='CDP_METHOD_DENIED');
 // A new task on the same tab detaches the old session before attaching its own.
 await cdp.input(7,'task-b','hover',{x:1,y:1});
 assert.deepEqual(f.log.filter(e=>e[0]!=='send').slice(-2),[['detach',7],['attach',7,'1.3']]);
 assert.equal(await cdp.release(7),true);assert.equal(f.attached.has(7),false);assert.equal(cdp.attached(7),false);
});

test('release while attaching never dispatches; stale own sessions are reclaimed, DevTools is reported busy',async()=>{
 let open;const gate=new Promise(r=>open=r);
 const f=fakeDebugger({attach:()=>gate}),cdp=create(f.chrome);
 const pending=cdp.input(3,'t','click',{x:5,y:5});
 const released=cdp.release(3);open();
 await assert.rejects(pending,e=>e.code==='CDP_DETACHED'&&e.dispatch==='not_sent');await released;
 assert.deepEqual(sends(f.log),[]);assert.equal(f.attached.has(3),false);
 // Worker restart left our own session attached: detach it and attach once more before any input.
 let first=true;const stale=fakeDebugger({attach:()=>{if(first){first=false;throw Error('Another debugger is already attached to the tab with id: 4.');}}});
 stale.attached.add(4);
 assert.equal((await create(stale.chrome).input(4,'t','hover',{x:1,y:1})).dispatch,'sent');
 assert.deepEqual(stale.log.map(e=>e[0]),['attach','detach','attach','send']);
 // DevTools (or another extension) holds the tab: our detach fails, so report CDP_BUSY and send nothing.
 const busy=fakeDebugger({attach:()=>{throw Error('Another debugger is already attached to the tab with id: 5.');},detach:()=>{throw Error('not attached');}});
 await assert.rejects(()=>create(busy.chrome).input(5,'t','click',{x:1,y:1}),e=>e.code==='CDP_BUSY'&&e.dispatch==='not_sent');
 assert.deepEqual(sends(busy.log),[]);
 await assert.rejects(()=>create({}).input(5,'t','click',{x:1,y:1}),e=>e.code==='CDP_UNAVAILABLE');
});

test('user cancelling the debug infobar stops real input for that task without reconnecting',async()=>{
 const f=fakeDebugger(),cdp=create(f.chrome);
 await cdp.input(9,'task-a','hover',{x:1,y:1});
 f.detach(9,'canceled_by_user');assert.equal(cdp.attached(9),false);
 await assert.rejects(()=>cdp.input(9,'task-a','click',{x:1,y:1}),e=>e.code==='CDP_CANCELLED'&&e.dispatch==='not_sent');
 assert.equal(f.log.filter(e=>e[0]==='attach').length,1,'no automatic re-attach after the user cancelled');
 // A later task is a new decision.
 await cdp.input(9,'task-b','hover',{x:1,y:1});
 assert.equal(f.log.filter(e=>e[0]==='attach').length,2);
});

test('disconnect mid-click reports unknown dispatch and is never retried; cancelled run sends nothing',async()=>{
 let f;f=fakeDebugger({send:(tabId,method,p)=>{if(p.type==='mousePressed')f.detach(tabId,'target_closed');}});
 const cdp=create(f.chrome);
 await assert.rejects(()=>cdp.input(2,'t','click',{x:1,y:1}),e=>e.code==='CDP_DETACHED'&&e.dispatch==='unknown');
 assert.deepEqual(sends(f.log),['mouseMoved','mousePressed']);
 assert.equal(f.log.filter(e=>e[0]==='attach').length,1);
 // Failure before the press: the click was not sent.
 const g=fakeDebugger({send:()=>{throw Error('boom');}});
 await assert.rejects(()=>create(g.chrome).input(2,'t','click',{x:1,y:1}),e=>e.code==='CDP_COMMAND_FAILED'&&e.dispatch==='not_sent');
 // Run token rotated (stop/takeover/supplement) after attaching: nothing is dispatched.
 const h=fakeDebugger(),late=create(h.chrome);
 await assert.rejects(()=>late.input(2,'t','click',{x:1,y:1},async()=>false),e=>e.code==='CANCELLED'&&e.dispatch==='not_sent');
 assert.deepEqual(sends(h.log),[]);
});
