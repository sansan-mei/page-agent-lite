const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const vm=require('node:vm');const {parseHTML}=require('linkedom');
const {createRuntime}=require('../extension/runtime.js');
const G=require('../extension/conditions.js'),P=require('../extension/prompts.js');
const {runUi,chromeI18n}=require('./i18n-helper.js');
const chrome_i18n=chromeI18n('zh_CN');
const flush=()=>new Promise(r=>setImmediate(r));

function fixture(overrides={}){
 const data=new Map(),executed=[];let seq=0,observed=0;
 const store={async get(id){return structuredClone(data.get(id)||null);},async set(id,t){data.set(id,structuredClone(t));},async remove(id){data.delete(id);},async list(){return [...data.values()].map(t=>structuredClone(t));},async getMemory(){return [];},async setMemory(){},async removeMemory(){}};
 const tools={async tab(id){return {id,url:'https://example.test/1',status:'complete'};},async observe(){observed++;return {url:'https://example.test/1',documentId:'doc',snapshotId:'snap'+observed,page:{text:'Resume',elements:[{id:'t0',key:'k0',label:'Answer',tag:'input'}]}};},async execute(id,p){executed.push(p);return {version:2,status:'success',dispatch:'sent',scope:'ui',code:'CONDITIONS_MATCH',recovery:'none',message:'Matched'};},...overrides.tools};
 const deps={store,tools,summarize:async()=>({text:'{}'}),schedule:()=>{},cancelSchedule:async()=>{},uuid:()=>String(++seq),preferences:async()=>({maxSteps:50,contextTokens:32768}),model:async()=>({text:'{"reply":"完成","action":"done"}'}),...overrides,tools};
 return {data,store,deps,executed,runtime:createRuntime(deps)};
}
const pending={version:2,status:'pending',dispatch:'sent',scope:'ui',code:'WAITING_CONDITIONS',recovery:'wait',message:'操作已发出，正在等待预期结果'};
const mismatch={version:2,status:'not_satisfied',dispatch:'not_sent',scope:'page',code:'CONDITIONS_UNMET',evidence:[{kind:'field_equals',matched:false,code:'FIELD_OBSERVED'}]};
const unknown={version:2,status:'unknown',dispatch:'not_sent',scope:'page',code:'CONDITIONS_UNMET',evidence:[{code:'TARGET_MISSING'}]};

test('unverified fill replans with fresh evidence instead of pausing, may be rewritten, and is bounded',async()=>{
 let clock=0;const f=fixture({now:()=>clock,model:async()=>({text:JSON.stringify({reply:'Move text',action:'fill',id:'t0',value:'成果'})}),tools:{async execute(id,p){f.executed.push(p);return pending;},async verify(){return mismatch;}}});
 await f.runtime.submit(1,'Move text');await f.runtime.tick(1);
 assert.equal((await f.runtime.get(1)).phase,'verifying');
 for(const round of [1,2]){
  clock+=20000;await f.runtime.tick(1);
  const t=await f.runtime.get(1);
  assert.equal(t.status,'running');assert.equal(t.check,null);assert.equal(t.lastOutcome.recovery,'replan');assert.equal(t.lastOutcome.code,'CONDITION_TIMEOUT');
  assert.equal(t.verificationRecoveries,round);assert.deepEqual(t.uncertainClicks||[],[]);
  assert.match(t.events.at(-1).text,/预期结果与页面不符.*未自动重发原操作/);
  assert.equal(f.executed.length,round,'the runtime itself never re-sends');
  await f.runtime.tick(1);assert.equal(f.executed.length,round+1,'the model may rewrite an observed mismatch');
 }
 clock+=20000;await f.runtime.tick(1);
 const t=await f.runtime.get(1);assert.equal(t.status,'paused');assert.equal(t.reason,'verification');assert.equal(f.executed.length,3);
});

test('unknown fill evidence is guarded like a click outside goal mode',async()=>{
 let clock=0;const f=fixture({now:()=>clock,model:async()=>({text:JSON.stringify({reply:'Fill',action:'fill',id:'t0',value:'x'})}),tools:{async execute(id,p){f.executed.push(p);return pending;},async verify(){return unknown;}}});
 await f.runtime.submit(1,'Fill');await f.runtime.tick(1);clock=20000;await f.runtime.tick(1);
 assert.equal((await f.runtime.get(1)).uncertainClicks.length,1);
 await f.runtime.tick(1);const t=await f.runtime.get(1);assert.equal(t.reason,'uncertain');assert.equal(f.executed.length,1);
});

test('goal mode lets the model redo an uncertain click after a fresh read; default blocks it',async()=>{
 for(const goalMode of [false,true]){
  let clock=0;const f=fixture({now:()=>clock,model:async()=>({text:JSON.stringify({reply:'Save',action:'click',id:'t0',expected:[{kind:'element_visible',id:'t0'}],timeoutMs:100})}),tools:{async execute(id,p){f.executed.push(p);return {version:2,status:'unknown',dispatch:'sent',code:'CONDITIONS_UNMET'};},async verify(){return unknown;}}});
  await f.runtime.submit(1,'Save',{goalMode});await f.runtime.tick(1);clock=101;await f.runtime.tick(1);await f.runtime.tick(1);
  const t=await f.runtime.get(1);
  if(goalMode){assert.equal(f.executed.length,2);assert.notEqual(t.reason,'uncertain');}
  else{assert.equal(f.executed.length,1);assert.equal(t.reason,'uncertain');}
 }
});

test('goal mode replans unverified completion instead of pausing',async()=>{
 for(const goalMode of [false,true]){
  const f=fixture({model:async()=>({text:JSON.stringify({reply:'完成',action:'done',expected:[{kind:'field_equals',id:'t0',value:'成果'}]})})});
  await f.runtime.submit(1,'Move',{goalMode});await f.runtime.tick(1);
  const t=await f.runtime.get(1);
  if(goalMode){assert.equal(t.status,'running');assert.equal(t.lastOutcome.recovery,'replan');assert.equal(t.verificationRecoveries,1);assert.match(t.events.at(-1).text,/完成条件尚未核实/);}
  else{assert.equal(t.status,'paused');assert.equal(t.reason,'verification');}
 }
});

test('goal mode keeps blocked replans at three while raising stale-target and no-progress limits',async()=>{
 const blocked=fixture({model:async()=>({text:JSON.stringify({action:'pause',reply:'入口尚未找到'})})});
 await blocked.runtime.submit(1,'查找',{goalMode:true});
 for(let i=0;i<3;i++){await blocked.runtime.tick(1);assert.equal(blocked.data.get(1).status,'running');}
 await blocked.runtime.tick(1);assert.equal(blocked.data.get(1).status,'paused');assert.equal(blocked.data.get(1).helpAttempts,3);
 const user=fixture({model:async()=>({text:JSON.stringify({action:'pause',pauseReason:'user',reply:'需要账号'})})});
 await user.runtime.submit(1,'查找',{goalMode:true});await user.runtime.tick(1);assert.equal(user.data.get(1).status,'paused');
 const still=fixture({model:async()=>({text:'{"reply":"滚动","action":"scroll","value":"down"}'}),tools:{async execute(){return {version:2,status:'unknown',dispatch:'sent',scope:'dispatch',code:'NO_CHANGE',recovery:'observe',message:'Unchanged'};}}});
 await still.runtime.submit(1,'滚动',{goalMode:true});
 for(let i=0;i<5;i++)await still.runtime.tick(1);assert.equal(still.data.get(1).status,'running');
 await still.runtime.tick(1);assert.equal(still.data.get(1).reason,'no_progress');
 const T=require('../extension/tool-protocol.js');let attempts=0;
 const stale=fixture({tools:{async execute(){attempts++;const error=Object.assign(new Error('Gone'),{code:'STALE'});error.result=T.failure(error);throw error;}},model:async()=>({text:JSON.stringify({reply:'Save',action:'click',id:'t0'})})});
 await stale.runtime.submit(1,'Save',{goalMode:true});for(let i=0;i<6;i++)await stale.runtime.tick(1);
 assert.equal(stale.data.get(1).reason,'recovery');assert.equal(attempts,6);
});

test('goal mode can be toggled on a live task, persists through supplements and reaches the model',async()=>{
 let payload;const f=fixture({model:async text=>{payload=JSON.parse(text);return {text:'{"reply":"Look","action":"observe"}'};}});
 const task=await f.runtime.submit(1,'Work');assert.equal(task.goalMode,false);
 await assert.rejects(()=>f.runtime.setGoalMode(1,'other',true),/任务已变化/);
 await assert.rejects(()=>f.runtime.setGoalMode(1,task.taskId,'yes'),/参数无效/);
 const on=await f.runtime.setGoalMode(1,task.taskId,true);assert.equal(on.goalMode,true);assert.match(on.events.at(-1).text,/已开启目标模式/);
 await f.runtime.submit(1,'More');assert.equal((await f.runtime.get(1)).goalMode,true);
 await f.runtime.tick(1);assert.equal(payload.goalMode,true);
 await f.runtime.submit(1,'Calm down',{goalMode:false});assert.equal((await f.runtime.get(1)).goalMode,false);
 const done=await f.runtime.get(1);done.status='completed';await f.store.set(1,done);
 assert.equal((await f.runtime.setGoalMode(1,task.taskId,true)).goalMode,true);
 await f.runtime.finish(1);
 await assert.rejects(()=>f.runtime.setGoalMode(1,task.taskId,false),/任务已变化/);
 assert.match(P.agentSystem('中文'),/goalMode=true/);
});

test('field and text checks ignore editor whitespace rewrites but not real content changes',()=>{
 const snap={documentId:'d1',url:'https://example.test',page:{elements:[{id:'t0',key:'k',label:'Achievements',value:'负责\u00a0 IM 架构\r\n\r\n  提升 30%  '}],regions:[{id:'r0',label:'Project results',text:'Anyone IM\n\n 主要贡献与成果：负责  IM 架构'}]}};
 const check=(c)=>G.evaluate(G.bind([c],snap),snap).status;
 assert.equal(check({kind:'field_equals',id:'t0',value:'负责 IM 架构\n提升 30%'}),'success');
 assert.equal(check({kind:'field_equals',id:'t0',value:'负责 IM 架构 提升 30%'}),'not_satisfied');
 assert.equal(check({kind:'field_equals',id:'t0',value:'负责 IM 架构\n提升 40%'}),'not_satisfied');
 assert.equal(check({kind:'text_present',id:'r0',value:'主要贡献与成果：负责 IM 架构'}),'success');
 assert.equal(check({kind:'text_present',id:'r0',value:'\t'}),'not_satisfied','whitespace-only text never matches loosely');
});

const panelSender={id:'test',url:'chrome-extension://test/sidepanel.html',frameId:0};
test('background validates goal-mode commands and forwards the submit flag only when given',async()=>{
 let listener;const calls=[];
 const runtime={async recover(){},async submit(...args){calls.push(['submit',...args]);return {taskId:'t'};},async setGoalMode(...args){calls.push(['goal',...args]);return {taskId:'t',goalMode:args[2]};},async resolve(id){return id;},async tick(){}};
 const chrome={runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,onMessage:{addListener(fn){listener=fn;}}},permissions:{onRemoved:{addListener(){}}},storage:{local:{async get(){return {};}},onChanged:{addListener(){}}},sidePanel:{async setPanelBehavior(){}},scripting:{async getRegisteredContentScripts(){return [];},async unregisterContentScripts(){}},alarms:{async create(){},async clear(){},onAlarm:{addListener(){}}},tabs:{onUpdated:{addListener(){}},onRemoved:{addListener(){}}},action:{onClicked:{addListener(){}}}};
 vm.runInNewContext(fs.readFileSync('extension/background.js','utf8'),{chrome,URL,setTimeout,clearTimeout,importScripts(){},PageAgentCore:{},PageAgentSiteMemory:{createSiteMemory(){return {};}},PageAgentHistoryStore:{createHistoryStore(){return {async list(){return [];},async get(){return null;},async save(){},async remove(){},async interrupt(){}};},snapshot:v=>v},PageAgentBackend:{createService(){return {async init(){},async handle(){return null;}};}},PageAgentTaskStore:{createTaskStore(){return {async migrate(){}};}},PageAgentBrowserTools:{createBrowserTools(){return {};}},PageAgentRuntime:{createRuntime(){return runtime;}}});await flush();
 const send=(m,s=panelSender)=>new Promise(r=>listener(m,s,r));
 assert.equal((await send({type:'task:goal-mode',tabId:1,taskId:'t',enabled:true})).value.goalMode,true);
 assert.equal((await send({type:'task:goal-mode',tabId:1,taskId:'t',enabled:'1'})).ok,false);
 assert.equal((await send({type:'task:goal-mode',tabId:1,taskId:'t',enabled:true},{id:'test',url:'https://example.test',frameId:0,tab:{id:1}})).ok,false);
 await send({type:'task:submit',tabId:1,goal:'x',goalMode:true});await send({type:'task:submit',tabId:1,goal:'y'});
 assert.equal(JSON.stringify(calls),JSON.stringify([['goal',1,'t',true],['submit',1,'x',{goalMode:true}],['submit',1,'y']]));
});

test('side panel goal toggle persists across panels, arms every new task and switches live tasks',async()=>{
 const local={};const calls=[];let task=null;
 const openPanel=async()=>{
  const {document,window}=parseHTML(fs.readFileSync('extension/sidepanel.html','utf8'));
  const chrome={tabs:{async query(){return [{id:9,url:'https://example.test/cv',title:'CV'}];},onRemoved:{addListener(){}},onActivated:{addListener(){}},onUpdated:{addListener(){}}},permissions:{async contains(){return true;},onAdded:{addListener(){}},onRemoved:{addListener(){}},request(){return Promise.resolve(true);}},runtime:{async sendMessage(m){calls.push(m);
   if(m.type==='task:get')return {ok:true,value:task};
   if(m.type==='task:submit'){task={taskId:'t'+calls.length,goal:m.goal,goalMode:m.goalMode,status:'running',steps:0,prefs:{maxSteps:50},events:[]};return {ok:true,value:task};}
   if(m.type==='task:goal-mode'){task={...task,goalMode:m.enabled};return {ok:true,value:task};}
   return {ok:true,value:null};},async openOptionsPage(){}},storage:{local:{async get(k){return k in local?{[k]:local[k]}:{};},async set(v){Object.assign(local,v);}},onChanged:{addListener(){}}}};
  runUi('extension/sidepanel.js',{chrome,document,window,URL,Date});await flush();await flush();
  const submit=async text=>{document.getElementById('instruction').value=text;document.getElementById('chat').dispatchEvent(new window.Event('submit',{cancelable:true}));await flush();return calls.filter(m=>m.type==='task:submit').at(-1);};
  return {toggle:document.getElementById('goal-mode'),click:async()=>{document.getElementById('goal-mode').dispatchEvent(new window.Event('click'));await flush();},submit};
 };
 let panel=await openPanel();
 assert.equal(panel.toggle.getAttribute('aria-pressed'),'false');assert.equal(panel.toggle.textContent,'目标模式');
 await panel.click();
 assert.equal(panel.toggle.getAttribute('aria-pressed'),'true');assert.equal(local.goalMode,true);assert.equal(calls.some(m=>m.type==='task:goal-mode'),false);
 assert.equal((await panel.submit('移动成果')).goalMode,true);
 task={...task,status:'ended'};
 panel=await openPanel();
 assert.equal(panel.toggle.getAttribute('aria-pressed'),'true','a reopened panel keeps the saved toggle');
 assert.equal((await panel.submit('下一个任务')).goalMode,true,'later tasks stay in goal mode without re-arming');
 await panel.click();
 assert.equal(local.goalMode,false);assert.equal(panel.toggle.getAttribute('aria-pressed'),'false');
 assert.deepEqual(calls.filter(m=>m.type==='task:goal-mode').map(({enabled})=>enabled),[false],'the live task is switched off too');
 panel=await openPanel();
 assert.equal(panel.toggle.getAttribute('aria-pressed'),'false');assert.equal((await panel.submit('普通任务')).goalMode,false);
});

test('turning goal mode on requests userScripts in the click and hints once when the Chrome toggle is off',async()=>{
 const S=require('../extension/script-tools.js');
 const openPanel=async({granted=false,answer=true,api=false}={})=>{
  const {document,window}=parseHTML(fs.readFileSync('extension/sidepanel.html','utf8'));
  const log=[],state={granted,api,inClick:false};
  const chrome={tabs:{async query(){return [{id:9,url:'https://example.test/cv',title:'CV'}];},create(o){log.push(['open',o.url]);return Promise.resolve({});},onRemoved:{addListener(){}},onActivated:{addListener(){}},onUpdated:{addListener(){}}},
   permissions:{async contains(q){return q.permissions?state.granted:true;},onAdded:{addListener(){}},onRemoved:{addListener(){}},
    request(q){log.push(['request',JSON.stringify(q),state.inClick]);if(q.permissions&&answer)state.granted=true;return Promise.resolve(answer);},remove(){log.push(['remove']);return Promise.resolve(true);}},
   runtime:{id:'abcdef',async sendMessage(m){return {ok:true,value:null};},async openOptionsPage(){}},
   storage:{local:{async get(){return {};},async set(){}},onChanged:{addListener(){}}}};
  Object.defineProperty(chrome,'userScripts',{get:()=>state.api?{execute(){},async getScripts(){return [];}}:undefined});
  runUi('extension/sidepanel.js',{chrome,document,window,URL,Date,PageAgentScriptTools:S});await flush();await flush();
  const $=id=>document.getElementById(id);
  // inClick marks whether request() ran synchronously inside the click dispatch (user gesture).
  const click=async()=>{state.inClick=true;$('goal-mode').dispatchEvent(new window.Event('click'));state.inClick=false;await flush();await flush();};
  const fire=(el,type='click')=>el.dispatchEvent(new window.Event(type));
  return {$,log,state,click,fire,document,requests:()=>log.filter(e=>e[0]==='request')};
 };
 const tr=key=>chrome_i18n.getMessage(key);
 // Not granted, user allows, toggle still off: one synchronous request, hint shown, its button opens the details page.
 let p=await openPanel();
 assert.equal(p.$('script-setup').hidden,true);
 await p.click();
 assert.equal(p.$('goal-mode').getAttribute('aria-pressed'),'true');
 assert.deepEqual(p.requests(),[['request',JSON.stringify({permissions:['userScripts']}),true]]);
 assert.equal(p.$('script-setup').hidden,false);
 assert.equal(p.$('script-setup').querySelector('span').textContent,tr('spScriptSetup'));
 assert.equal(p.$('script-setup-open').textContent,tr('spScriptSetupOpen'));
 p.fire(p.$('script-setup-open'));
 assert.deepEqual(p.log.at(-1),['open','chrome://extensions/?id=abcdef']);
 p.fire(p.$('script-setup-close'));
 assert.equal(p.$('script-setup').hidden,true,'dismissible');
 // Off keeps the permission and hides nothing new; on again (granted now) asks nothing and hints once more.
 await p.click();
 assert.equal(p.$('goal-mode').getAttribute('aria-pressed'),'false');assert.equal(p.log.some(e=>e[0]==='remove'),false);assert.equal(p.$('script-setup').hidden,true);
 await p.click();
 assert.equal(p.requests().length,1,'granted permission is not requested again');assert.equal(p.$('script-setup').hidden,false);
 // Toggle flipped in Chrome: the hint goes away on re-check and does not come back.
 p.state.api=true;p.fire(p.document,'visibilitychange');await flush();await flush();
 assert.equal(p.$('script-setup').hidden,true);
 await p.click();await p.click();
 assert.equal(p.$('script-setup').hidden,true,'no hint once scripts are available');assert.equal(p.requests().length,1);
 // Already granted and available at startup: no request, no hint.
 p=await openPanel({granted:true,api:true});
 await p.click();
 assert.equal(p.requests().length,0);assert.equal(p.$('script-setup').hidden,true);assert.equal(p.$('goal-mode').getAttribute('aria-pressed'),'true');
 // Denied: goal mode still turns on, no hint.
 p=await openPanel({answer:false});
 await p.click();
 assert.equal(p.requests().length,1);assert.equal(p.requests()[0][2],true);
 assert.equal(p.$('goal-mode').getAttribute('aria-pressed'),'true');assert.equal(p.$('script-setup').hidden,true);
});
