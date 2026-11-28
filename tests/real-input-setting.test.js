const {test}=require('node:test');const assert=require('node:assert/strict');
const {create}=require('../extension/cdp-tools.js');
const {createBrowserTools}=require('../extension/browser-tools.js');
const {createRuntime}=require('../extension/runtime.js');
const P=require('../extension/prompts.js');

// The settings switch "Real input & screenshots" (storage.local debuggerEnabled, default off) gates every chrome.debugger use.
function storage(initial={}){
 const local={...initial},listeners=[];
 return {local,listeners,api:{local:{async get(k){return k in local?{[k]:local[k]}:{};},async set(v){const changes={};for(const [k,n] of Object.entries(v)){changes[k]={oldValue:local[k],newValue:n};local[k]=n;}for(const fn of listeners)fn(changes,'local');}},onChanged:{addListener(fn){listeners.push(fn);}}}};
}
function fakeDebugger(){
 const log=[],attached=new Set();
 const api={onDetach:{addListener(){}},
  async attach({tabId}){log.push(['attach',tabId]);attached.add(tabId);},
  async detach({tabId}){log.push(['detach',tabId]);if(!attached.delete(tabId))throw Error('not attached');},
  async sendCommand({tabId},method,p){log.push(['send',method,p.type]);if(!attached.has(tabId))throw Error('Detached');return method==='Page.captureScreenshot'?{data:'SlBFRw=='}:{};}};
 return {api,log,attached};
}
const flush=()=>new Promise(r=>setImmediate(r));
const clip={x:0,y:0,width:10,height:10,scale:1};

test('switch off (missing key, false or unreadable storage): nothing attaches, input and capture report REAL_INPUT_DISABLED',async()=>{
 for(const chromeStorage of [storage().api,storage({debuggerEnabled:false}).api,{local:{async get(){throw Error('no storage');}}},undefined]){
  const d=fakeDebugger(),cdp=create({debugger:d.api,storage:chromeStorage});
  assert.equal(await cdp.enabled(),false);
  await assert.rejects(()=>cdp.input(1,'t','click',{x:1,y:1}),e=>e.code==='REAL_INPUT_DISABLED'&&e.dispatch==='not_sent'&&/设置/.test(e.message));
  await assert.rejects(()=>cdp.capture(1,'t',clip),e=>e.code==='REAL_INPUT_DISABLED');
  assert.deepEqual(d.log,[],'never attached');
 }
});

test('turning the switch off mid-task detaches at once; turning it on again works',async()=>{
 const s=storage({debuggerEnabled:true}),d=fakeDebugger(),cdp=create({debugger:d.api,storage:s.api});
 assert.equal((await cdp.input(3,'task','click',{x:5,y:5})).dispatch,'sent');assert.equal(cdp.attached(3),true);
 await s.api.local.set({goalMode:true});await flush();
 assert.equal(cdp.attached(3),true,'other keys do not detach');
 await s.api.local.set({debuggerEnabled:false});await flush();await flush();
 assert.equal(cdp.attached(3),false);assert.deepEqual(d.log.at(-1),['detach',3]);assert.equal(d.attached.has(3),false);
 await assert.rejects(()=>cdp.input(3,'task','click',{x:5,y:5}),e=>e.code==='REAL_INPUT_DISABLED');
 assert.equal(d.log.filter(e=>e[0]==='attach').length,1);
 await s.api.local.set({debuggerEnabled:true});
 assert.equal((await cdp.capture(3,'task',clip)),'SlBFRw==');assert.equal(d.log.filter(e=>e[0]==='attach').length,2);
});

// browser-tools with a scripted content script; the switch is off unless the test turns it on.
function browser({on=false,execute}={}){
 const s=storage(on?{debuggerEnabled:true}:{}),d=fakeDebugger(),messages=[];
 const chrome={storage:s.api,debugger:d.api,permissions:{async contains(){return true;}},
  tabs:{async get(){return {url:'https://a.test/',status:'complete'};},async sendMessage(id,m){messages.push(m.type);
   if(m.type==='agent:execute')return execute?execute(m):{ok:true,value:{version:2,status:'unknown',dispatch:'sent',scope:'dispatch',code:'NO_CHANGE',recovery:'observe',message:'无变化',pageChange:'NO_CHANGE'}};
   if(m.type==='agent:viewport')return {ok:true,value:{documentId:'d1',url:'https://a.test/',viewport:{width:800,height:600},scroll:{x:0,y:0}}};
   return {ok:true,value:{x:5,y:5}};}}};
 return {tools:createBrowserTools(chrome),messages,debug:d,storage:s};
}
const policy={taskId:'task-1',origin:'https://a.test',allowedOrigins:['https://a.test']};
const pending=(plan={action:'click',id:'t0',reply:'x'},extra={})=>({operationId:'op1',documentId:'d1',snapshotId:'s1',url:'https://a.test/',label:'Go',plan,expected:[],...extra});
const unreachable=()=>({ok:false,code:'SYNTHETIC_UNREACHABLE',error:'嵌入文档',result:{version:2,operationId:'op1',documentId:'d1',status:'unsupported',dispatch:'not_sent',scope:'dispatch',code:'SYNTHETIC_UNREACHABLE',observed:{input:'none'},evidence:[],recovery:'replan',message:'嵌入文档'}});

test('switch off: unreachable fallback, trusted:true, click_point and screenshots return the stable not_sent code without the debugger',async()=>{
 const f=browser({execute:unreachable});
 assert.equal(await f.tools.realInputEnabled(),false);
 const r=await f.tools.execute(1,pending(),policy,async()=>true);
 assert.equal(r.code,'REAL_INPUT_DISABLED');assert.equal(r.dispatch,'not_sent');assert.equal(r.recovery,'replan');assert.match(r.message,/合成事件无法到达目标.*设置中开启/);
 assert.deepEqual(f.messages,['agent:execute'],'no agent:point measurement');
 const trusted=await f.tools.execute(1,pending({action:'hover',id:'t0',reply:'x',trusted:true}),policy,async()=>true);
 assert.equal(trusted.code,'REAL_INPUT_DISABLED');assert.equal(trusted.dispatch,'not_sent');assert.doesNotMatch(trusted.message,/合成事件/);
 const point=await f.tools.execute(1,pending({action:'click_point',value:{x:1,y:1},reply:'x'},{point:{x:1,y:1},view:{viewport:{width:800,height:600},scroll:{x:0,y:0}}}),policy,async()=>true);
 assert.equal(point.code,'REAL_INPUT_DISABLED');assert.equal(point.dispatch,'not_sent');
 await assert.rejects(()=>f.tools.screenshot(1,{operationId:'s',snapshotId:'s1',url:'https://a.test/'},policy),e=>e.code==='REAL_INPUT_DISABLED');
 assert.deepEqual(f.messages,['agent:execute'],'nothing measured, aimed or masked');assert.deepEqual(f.debug.log,[]);
 // NO_CHANGE hint does not suggest trusted:true while the switch is off.
 const plain=browser();assert.doesNotMatch((await plain.tools.execute(1,pending(),policy,async()=>true)).message,/trusted/);
});

test('switch on: the unreachable fallback uses real input only under a task-scope approval',async()=>{
 for(const inputApproval of [undefined,'action']){
  const asked=browser({on:true,execute:unreachable}),r=await asked.tools.execute(1,pending(),{...policy,inputApproval},async()=>true);
  assert.equal(r.code,'REAL_INPUT_APPROVAL_REQUIRED');assert.equal(r.dispatch,'not_sent');assert.match(r.message,/trusted:true/);assert.deepEqual(asked.debug.log,[],'nothing attached');
 }
 const f=browser({on:true,execute:unreachable});
 const r=await f.tools.execute(1,pending(),{...policy,inputApproval:'task'},async()=>true);
 assert.equal(r.observed.input,'cdp');assert.equal(r.observed.fallback,'unreachable');
 assert.deepEqual(f.debug.log.filter(e=>e[0]==='send').map(e=>e[2]),['mouseMoved','mousePressed','mouseReleased']);
 assert.match((await browser({on:true}).tools.execute(1,pending(),policy,async()=>true)).message,/trusted:true/);
});

test('prompt and native tools: page screenshots, click_point and trusted:true exist only with the switch on',()=>{
 const names=caps=>P.agentTools(caps).map(t=>t.function.name),props=(caps,name)=>P.agentTools(caps).find(t=>t.function.name===name).function.parameters.properties;
 for(const caps of [{},{vision:true},{scripts:true,vision:true}]){
  const prompt=P.agentSystem('English','native',caps),json=P.agentSystem('English','json',caps);
  assert.ok(!names(caps).includes('click_point'));assert.equal(props(caps,'click').trusted,undefined);assert.equal(props(caps,'hover').trusted,undefined);
  assert.equal(props(caps,'view_image').id.description,'imageN');
  assert.doesNotMatch(prompt+json,/click_point|trusted:true|id=viewport/);assert.match(prompt,/view_image on imageN/);
  assert.ok(prompt.startsWith('You are Page Agent Lite'));
 }
 const on={vision:true,realInput:true};
 assert.ok(names(on).includes('click_point'));assert.deepEqual(props(on,'click').trusted,{type:'boolean'});
 assert.match(P.agentSystem('English','native',on),/id=viewport[\s\S]*click_point[\s\S]*trusted:true once/);
 assert.ok(P.estimateTokens(P.agentSystem('简体中文','native'))<P.estimateTokens(P.agentSystem('简体中文','native',{realInput:true})));
});

const {preapprove}=require('./real-input-helper.js');
// Runtime: capabilities.realInput follows tools.realInputEnabled() every turn.
function fixture(replies,{on=false}={}){
 const data=new Map(),models=[],shots=[],executed=[];let seq=0;
 const store={async get(id){return structuredClone(data.get(id)||null);},async set(id,t){data.set(id,structuredClone(t));},async remove(id){data.delete(id);},async list(){return [...data.values()].map(t=>structuredClone(t));}};
 const tools={async tab(id){return {id,url:'https://a.test/',status:'complete'};},
  async observe(){return {url:'https://a.test/',documentId:'d1',snapshotId:'s'+(++seq),page:{text:'page',elements:[{id:'t0',key:'k0',label:'Chart',tag:'canvas'}]}};},
  async screenshot(...args){shots.push(args);return {data:'SlBFRw==',masked:0,width:800,height:600};},
  async execute(id,p){executed.push(p);return {version:2,status:'success',dispatch:'sent',scope:'ui',code:'CONDITIONS_MATCH',recovery:'none',message:'ok'};},
  async realInputEnabled(){return on;},async releaseInput(){return true;}};
 const service={mode:async()=>'supported',async claim(ids){return ids.map(id=>({id,type:'image/jpeg',width:10,height:10,size:9}));},async recognize(){return 'TEXT';},async saveShot(){return 'shot_00000001';},async dropShots(){},async present(ids){return ids;},async remove(){},async prune(){}};
 const runtime=preapprove(createRuntime({store,tools,images:service,schedule:()=>{},cancelSchedule:async()=>{},uuid:()=>'id'+(++seq),preferences:async()=>({maxSteps:50}),
  model:async(text,signal,capabilities)=>{models.push(capabilities);return {text:JSON.stringify(replies.shift()||{reply:'ok',action:'done'})};}}),store);
 return {runtime,models,shots,executed};
}

test('runtime with the switch off: no page screenshot or click_point, attached images still work',async()=>{
 const f=fixture([{reply:'look',action:'view_image',id:'viewport'},{reply:'attached',action:'view_image',id:'image1'},{reply:'click',action:'click_point',value:{x:10,y:10}}]);
 await f.runtime.submit(1,'Read the chart',{attachments:['img_00000001']});
 await f.runtime.tick(1);let task=await f.runtime.get(1);
 assert.equal(f.models[0].realInput,false);assert.equal(f.models[0].vision,true);
 assert.equal(task.results.at(-1).outcome.code,'REAL_INPUT_DISABLED');assert.equal(task.results.at(-1).outcome.dispatch,'not_sent');assert.match(task.results.at(-1).outcome.message,/设置/);
 assert.equal(f.shots.length,0,'no screenshot requested');
 await f.runtime.tick(1);task=await f.runtime.get(1);
 assert.equal(task.results.at(-1).outcome.code,'IMAGE_IN_REQUEST','attachments need no debugger');
 await f.runtime.tick(1);task=await f.runtime.get(1);
 assert.equal(task.results.at(-1).outcome.code,'REAL_INPUT_DISABLED');assert.equal(task.results.at(-1).action,'click_point');
 assert.equal(f.executed.length,0);
});

test('runtime with the switch on offers real input and takes page screenshots as before',async()=>{
 const f=fixture([{reply:'look',action:'view_image',id:'viewport'}],{on:true});
 await f.runtime.submit(1,'Read the chart');await f.runtime.tick(1);
 const task=await f.runtime.get(1);
 assert.equal(f.models[0].realInput,true);assert.equal(f.shots.length,1);assert.equal(task.results.at(-1).outcome.code,'IMAGE_NEXT_TURN');
});

// UI: settings row and the goal-mode hint in the side panel share the same storage.local key.
const fs=require('node:fs');const {parseHTML}=require('linkedom');const {runUi,chromeI18n}=require('./i18n-helper.js');
const tr=key=>chromeI18n('zh_CN').getMessage(key);

test('settings row flips the stored switch without any permission prompt and survives reopening',async()=>{
 const s=storage();
 const open=async()=>{
  const {document,window}=parseHTML(fs.readFileSync('extension/options.html','utf8'));
  runUi('extension/real-input-settings.js',{document,window,chrome:{storage:s.api}});await flush();await flush();
  const $=id=>document.getElementById(id);
  return {$,click:async()=>{$('real-input-toggle').dispatchEvent(new window.Event('click'));await flush();await flush();}};
 };
 assert.match(fs.readFileSync('extension/options.html','utf8'),/id="scripts"[\s\S]*id="real-input"[\s\S]*id="more"/,'row sits right after script execution');
 let page=await open();
 assert.equal(page.$('real-input-badge').getAttribute('data-state'),'off');assert.equal(page.$('real-input-badge').textContent,tr('optScriptsBadgeOff'));
 assert.equal(page.$('real-input-toggle').textContent,tr('optRealInputEnable'));assert.equal(s.local.debuggerEnabled,undefined,'default off, nothing written');
 await page.click();
 assert.equal(s.local.debuggerEnabled,true);assert.equal(page.$('real-input-badge').getAttribute('data-state'),'on');assert.equal(page.$('real-input-toggle').textContent,tr('optRealInputDisable'));
 page=await open();
 assert.equal(page.$('real-input-badge').getAttribute('data-state'),'on','reopened page shows the saved state');
 await page.click();assert.equal(s.local.debuggerEnabled,false);assert.equal(page.$('real-input-badge').textContent,tr('optScriptsBadgeOff'));
 // Changed elsewhere (side panel "Turn on"): the row follows.
 await s.api.local.set({debuggerEnabled:true});assert.equal(page.$('real-input-badge').getAttribute('data-state'),'on');
});

test('goal mode on with the switch off shows one compact hint whose button turns it on directly',async()=>{
 const open=async(s,scripts=null)=>{
  const {document,window}=parseHTML(fs.readFileSync('extension/sidepanel.html','utf8'));
  const state={granted:true,api:false};
  const chrome={tabs:{async query(){return [{id:9,url:'https://example.test/cv',title:'CV'}];},create(){return Promise.resolve({});},onRemoved:{addListener(){}},onActivated:{addListener(){}},onUpdated:{addListener(){}}},
   permissions:{async contains(q){return q.permissions?state.granted:true;},onAdded:{addListener(){}},onRemoved:{addListener(){}},request(){return Promise.resolve(true);}},
   runtime:{id:'abcdef',async sendMessage(){return {ok:true,value:null};},async openOptionsPage(){}},storage:s.api};
  Object.defineProperty(chrome,'userScripts',{get:()=>state.api?{execute(){},async getScripts(){return [];}}:undefined});
  runUi('extension/sidepanel.js',{chrome,document,window,URL,Date,...(scripts?{PageAgentScriptTools:scripts}:{})});await flush();await flush();
  const $=id=>document.getElementById(id),fire=async el=>{el.dispatchEvent(new window.Event('click'));await flush();await flush();};
  return {$,fire,goal:()=>fire($('goal-mode'))};
 };
 const s=storage();let p=await open(s);
 assert.equal(p.$('script-setup').hidden,true);
 await p.goal();
 assert.equal(p.$('goal-mode').getAttribute('aria-pressed'),'true');
 assert.equal(p.$('script-setup').hidden,false);assert.equal(p.$('real-input-setup').hidden,false);assert.equal(p.$('script-toggle-setup').hidden,true);
 assert.equal(p.$('real-input-setup').querySelector('span').textContent,tr('spRealInputSetup'));assert.equal(p.$('real-input-enable').textContent,tr('spRealInputEnable'));
 await p.fire(p.$('real-input-enable'));
 assert.equal(s.local.debuggerEnabled,true,'one click turns the setting on');assert.equal(p.$('script-setup').hidden,true);
 await p.goal();await p.goal();assert.equal(p.$('script-setup').hidden,true,'no hint once enabled');
 // Off again (settings page): next enable shows it once more; dismiss hides it until the next enable.
 await s.api.local.set({debuggerEnabled:false});await p.goal();await p.goal();
 assert.equal(p.$('real-input-setup').hidden,false);
 await p.fire(p.$('script-setup-close'));assert.equal(p.$('script-setup').hidden,true);
 // Turned on elsewhere while the hint is up: it hides.
 await p.goal();await p.goal();assert.equal(p.$('script-setup').hidden,false);
 await s.api.local.set({debuggerEnabled:true});assert.equal(p.$('script-setup').hidden,true);
 // Both needs at once fit in the same single hint line with one dismiss.
 const both=storage();p=await open(both,require('../extension/script-tools.js'));
 await p.goal();
 assert.equal(p.$('script-setup').hidden,false);assert.equal(p.$('real-input-setup').hidden,false);assert.equal(p.$('script-toggle-setup').hidden,false);
 assert.equal(p.$('script-setup').querySelectorAll('#script-setup-close').length,1);
 await p.fire(p.$('real-input-enable'));
 assert.equal(p.$('real-input-setup').hidden,true);assert.equal(p.$('script-toggle-setup').hidden,false);assert.equal(p.$('script-setup').hidden,false,'script part stays');
 await p.goal();assert.equal(p.$('script-setup').hidden,true,'goal mode off hides the hint');
});
