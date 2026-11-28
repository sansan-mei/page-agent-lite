const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const {parseHTML}=require('linkedom');
const C=require('../extension/core.js');
const {createBrowserTools}=require('../extension/browser-tools.js');
const {createRuntime}=require('../extension/runtime.js');

// Image-grid tile whose selection changes only class/style (neal.fun "select all squares" style): the text snapshot
// stays identical, so the receipt must not say NO_CHANGE (that made the model re-click and deselect the tile).
const policy={taskId:'task-1',origin:'https://example.test',allowedOrigins:['https://example.test']};
function page(html,onClick){
 const {document,window}=parseHTML(`<html><body>${html}</body></html>`);
 window.innerWidth=800;window.innerHeight=600;window.MouseEvent=window.Event;
 const tile=document.querySelector('[data-tile]');
 tile.getBoundingClientRect=()=>({left:10,right:110,top:20,bottom:120,width:100,height:100});
 document.elementFromPoint=()=>tile;tile.addEventListener('click',()=>onClick(tile,document));
 let listener;const chrome={runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,onMessage:{addListener(fn){listener=fn;}},async sendMessage(){return {ok:true};}}};
 vm.runInNewContext(fs.readFileSync('extension/content.js','utf8'),{PageAgentCore:C,PageAgentConditions:require('../extension/conditions.js'),PageAgentProtocol:require('../extension/tool-protocol.js'),chrome,document,location:{href:'https://example.test/'},crypto,Date,setTimeout:fn=>setImmediate(fn)});
 const send=m=>new Promise(r=>listener(m,{id:'test',url:'chrome-extension://test/background.js'},r));
 const tools=createBrowserTools({storage:{local:{async get(){return {debuggerEnabled:true};}}},permissions:{async contains(){return true;}},tabs:{async get(){return {url:'https://example.test/',status:'complete'};},sendMessage:(id,m)=>send(m)}});
 return {document,send,async click(action='click'){
  const snap=(await send({type:'agent:observe'})).value;
  return tools.execute(1,{operationId:'op1',documentId:snap.documentId,snapshotId:snap.snapshotId,url:snap.url,label:'Tile',plan:{action,id:'t0',reply:'x'},expected:[]},policy,async()=>true);
 }};
}
const TILE='<div data-tile tabindex="0" class="tile" aria-label="Tile 1"><img alt="" class="img"></div><p>Select all squares with a stop sign</p>';

test('regression: a tile click that only toggles a class reports TARGET_VISUAL_CHANGED, not NO_CHANGE',async()=>{
 let clicks=0;const f=page(TILE,tile=>{clicks++;tile.classList.toggle('selected');});
 const r=await f.click();
 assert.equal(clicks,1);assert.equal(r.code,'TARGET_VISUAL_CHANGED');assert.equal(r.dispatch,'sent');assert.equal(r.status,'unknown');
 assert.match(r.message,/不要重复点击/);assert.doesNotMatch(r.message,/trusted:true/);assert.equal(r.pageChange,undefined);
});

test('style-attribute and child-decoration changes on a tile also count as a visual change',async()=>{
 const styled=page(TILE,tile=>{tile.setAttribute('style','outline:3px solid blue');});
 assert.equal((await styled.click()).code,'TARGET_VISUAL_CHANGED');
 const child=page(TILE,tile=>{tile.querySelector('img').className='img checked';});
 assert.equal((await child.click()).code,'TARGET_VISUAL_CHANGED');
 const pressed=page(TILE,tile=>{tile.setAttribute('aria-pressed','true');});
 assert.notEqual((await pressed.click()).code,'NO_CHANGE');
});

test('a no-op click is still NO_CHANGE and its hint asks for verification before any trusted retry',async()=>{
 const f=page(TILE,()=>{});
 const r=await f.click();
 assert.equal(r.code,'NO_CHANGE');
 assert.match(r.message,/再点会撤销/);assert.match(r.message,/先截图或观察核实/);assert.doesNotMatch(r.message,/重新观察后仍无效/);
});

test('a real-input (trusted:true) click that only restyles the target settles as TARGET_VISUAL_CHANGED',async()=>{
 const f=page(TILE,()=>{});
 const snap=(await f.send({type:'agent:observe'})).value;
 const aimed=await f.send({type:'agent:aim',operationId:'op1',snapshotId:snap.snapshotId,url:snap.url,plan:{action:'click',id:'t0',reply:'x',trusted:true}});
 assert.equal(aimed.ok,true);
 f.document.querySelector('[data-tile]').classList.add('selected'); // what the real click did
 const settled=await f.send({type:'agent:settle',operationId:'op1',url:snap.url});
 assert.equal(settled.value.code,'TARGET_VISUAL_CHANGED');
});

test('the prompt no longer tells the model to retry with trusted:true right after observe',()=>{
 const P=require('../extension/prompts.js');
 for(const caps of [{realInput:true},{realInput:true,vision:true}]){
  const s=P.agentSystem('简体中文','native',caps);
  assert.doesNotMatch(s,/still had none after observe, retry once with trusted:true/);
  assert.match(s,/re-clicking undoes them/);assert.match(s,/trusted:true once only after a screenshot/);
 }
});

test('visual-change clicks on same-label tiles do not trip the no-progress pause',async()=>{
 const data=new Map();let seq=0;
 const store={async get(id){return structuredClone(data.get(id)||null);},async set(id,t){data.set(id,structuredClone(t));},async remove(id){data.delete(id);},async list(){return [...data.values()].map(t=>structuredClone(t));}};
 const tools={async tab(id){return {id,url:'https://example.test/1',status:'complete'};},
  async observe(){return {url:'https://example.test/1',documentId:'d1',snapshotId:'s'+(++seq),page:{text:'',elements:[{id:'t0',key:'node'+seq,label:'Tile',tag:'div'}],regions:[]}};},
  async execute(){return {version:2,status:'unknown',dispatch:'sent',scope:'dispatch',code:'TARGET_VISUAL_CHANGED',recovery:'observe',message:'x'};},async realInputEnabled(){return true;},async releaseInput(){return true;}};
 const runtime=createRuntime({store,tools,summarize:async()=>({text:'{}'}),schedule(){},cancelSchedule:async()=>{},uuid:()=>'u'+(++seq),preferences:async()=>({maxSteps:50,contextTokens:32768}),model:async()=>({text:'{"reply":"Click","action":"click","id":"t0"}'})});
 await runtime.start(1,'Select tiles');for(let i=0;i<4;i++)await runtime.tick(1);
 const t=await runtime.get(1);assert.equal(t.results.length,4);assert.notEqual(t.reason,'no_progress');assert.equal(t.status,'running');
});
