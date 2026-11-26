const {test}=require('node:test');
const assert=require('node:assert/strict');
const {create}=require('../extension/frame-tools.js');
const T=require('../extension/tool-protocol.js');
function fixture(){
 let actions=0,permitted=true,cancelled=false,failReply=false;
 const route={frameId:2,origin:'https://pay.test',url:'https://pay.test/form',parentKey:'node1',documentId:'child-doc',snapshotId:'child-snapshot',id:'t0'};
 const chrome={permissions:{contains:async()=>permitted},webNavigation:{getAllFrames:async()=>[{frameId:2,parentFrameId:0,url:route.url}]},tabs:{sendMessage:async(tab,message,options)=>{assert.equal(options.frameId,2);assert.equal(message.id,undefined);assert.equal(message.plan.id,'t0');assert.equal(message.documentId,'child-doc');actions++;if(failReply)throw Error('Disconnected');return {ok:true,value:T.result({status:'unknown',dispatch:'sent'})};}}};
 const policy={origin:'https://shop.test',allowedOrigins:['https://shop.test','https://pay.test']};
 const pending={frameRoute:route,plan:{action:'fill',id:'t7',value:'test',reply:'fill'},url:'https://shop.test',documentId:'parent-doc',snapshotId:'parent-snapshot'};
 const helpers={checkOrigin:async()=>{},call:async(tab,m)=>{if(m.type==='agent:consume'){assert.equal(m.snapshotId,'parent-snapshot');if(cancelled)throw Object.assign(Error('stale'),{code:'STALE'});}return {};},observe:async()=>{throw Error('not needed');}};
 return {run:()=>create(chrome,T).execute(1,pending,policy,async()=>!cancelled,helpers),get actions(){return actions;},set permitted(v){permitted=v;},set cancelled(v){cancelled=v;},set failReply(v){failReply=v;},pending,policy,chrome};
}
test('a lost child-frame reply is unknown and never replays the side effect',async()=>{
 const f=fixture();f.failReply=true;const r=await f.run();assert.equal(r.dispatch,'unknown');assert.equal(r.code,'FRAME_RESPONSE_LOST');assert.equal(f.actions,1);
});
test('child route requires host permission and task scope independently',async()=>{
 const f=fixture();f.permitted=false;await assert.rejects(f.run,e=>e.code==='PERMISSION_DENIED');assert.equal(f.actions,0);
 f.permitted=true;f.policy.allowedOrigins=['https://shop.test'];await assert.rejects(f.run,e=>e.code==='PERMISSION_DENIED');assert.equal(f.actions,0);
});
test('stale parent snapshot prevents child-frame dispatch',async()=>{
 const f=fixture();f.cancelled=true;await assert.rejects(f.run,e=>e.code==='STALE');assert.equal(f.actions,0);
});
test('frame moved below another frame is rejected before dispatch',async()=>{
 const f=fixture();f.chrome.webNavigation.getAllFrames=async()=>[{frameId:2,parentFrameId:9,url:f.pending.frameRoute.url}];await assert.rejects(f.run,e=>e.code==='STALE');assert.equal(f.actions,0);
});
