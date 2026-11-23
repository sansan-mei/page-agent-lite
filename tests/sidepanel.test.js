const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const {parseHTML}=require('linkedom');
const flush=()=>new Promise(r=>setImmediate(r));
async function fixture(granted,hook=()=>undefined,management=false,contains=async()=>false){
 const {document,window}=parseHTML(fs.readFileSync(management?'extension/options.html':'extension/sidepanel.html','utf8'));
 const calls=[];let updated,added,removed;const chrome={tabs:{async query(){return [{id:9,url:'https://example.test/task',title:'Homework'}];},onRemoved:{addListener(){}},onActivated:{addListener(){}},onUpdated:{addListener(fn){updated=fn;}}},permissions:{contains,onAdded:{addListener(fn){added=fn;}},onRemoved:{addListener(fn){removed=fn;}},request(p){calls.push(['permission',p]);return Promise.resolve(granted);}},runtime:{async sendMessage(m){calls.push(['message',m]);const result=hook(m);if(result!==undefined)return await result;return {ok:true,value:m.type==='task:get'?null:{connected:true}};},async openOptionsPage(){}},storage:{onChanged:{addListener(){}}}};
 vm.runInNewContext(fs.readFileSync(management?'extension/management.js':'extension/sidepanel.js','utf8'),{chrome,document,window,URL,Date});await flush();
 return {document,window,calls,updated,added,removed};
}
test('sidepanel requests only current origin directly from gesture, then connects',async()=>{
 const f=await fixture(true);assert.equal(f.document.getElementById('grant').disabled,false);
 assert.match(f.document.getElementById('target').textContent,/Homework/);
 f.calls.length=0;f.document.getElementById('grant').dispatchEvent(new f.window.Event('click'));
 assert.equal(f.calls[0][0],'permission');assert.equal(f.calls[0][1].origins[0],'https://example.test/*');
 await flush();assert.equal(f.calls[1][1].type,'task:connect');assert.equal(f.calls[1][1].tabId,9);
 assert.match(f.document.getElementById('status').textContent,/已授权并连接/);
});

test('successful send clears submitted text but preserves new edits and failed drafts',async()=>{
 let resolve;const f=await fixture(true,m=>m.type==='task:submit'?new Promise(r=>resolve=r):undefined);
 const input=f.document.getElementById('instruction'),form=f.document.getElementById('chat');
 const task={goal:'任务',status:'running',steps:0,prefs:{maxSteps:50},events:[]};
 input.value='第一条';form.dispatchEvent(new f.window.Event('submit'));resolve({ok:true,value:task});await flush();
 assert.equal(input.value,'');assert.match(f.document.getElementById('start').title,/继续当前任务/);
 input.value='第二条';form.dispatchEvent(new f.window.Event('submit'));input.value='正在写第三条';resolve({ok:true,value:task});await flush();assert.equal(input.value,'正在写第三条');
 form.dispatchEvent(new f.window.Event('submit'));resolve({ok:false,error:'连接失败'});await flush();assert.equal(input.value,'正在写第三条');
});
test('denied website grant never injects or starts a task',async()=>{
 const f=await fixture(false);f.calls.length=0;
 f.document.getElementById('grant').dispatchEvent(new f.window.Event('click'));await flush();
 assert.equal(f.calls.length,1);assert.match(f.document.getElementById('status').textContent,/取消/);
});

test('all-site button requests HTTP and HTTPS optional hosts explicitly before connecting',async()=>{
 const f=await fixture(true,()=>undefined,true);f.calls.length=0;
 f.document.getElementById('grant-all').dispatchEvent(new f.window.Event('click'));
 assert.deepEqual(Array.from(f.calls[0][1].origins),['http://*/*','https://*/*']);
 await flush();assert.match(f.document.getElementById('management-status').textContent,/所有普通网站已授权/);
});


test('sidepanel shows task summary as text without interpreting page HTML',async()=>{
 const task={goal:'任务',status:'running',steps:15,prefs:{maxSteps:50},events:[],contextSummary:{through:7,updatedAt:Date.now(),content:{completed:['<img src=x onerror=alert(1)>'],remaining:['待核对'],facts:[],failed:[],uncertain:['不能重复提交']}}};
 const f=await fixture(true,m=>m.type==='task:get'?{ok:true,value:task}:undefined);
 assert.equal(f.document.getElementById('context-panel').hidden,false);assert.match(f.document.getElementById('context-meta').textContent,/7/);assert.match(f.document.getElementById('context-summary').textContent,/不能重复提交/);assert.equal(f.document.getElementById('context-summary').querySelector('img'),null);
});


test('durable note viewer escapes HTML, sends origin and revision, and retains edited drafts',async()=>{
 let current={origin:'https://example.test',version:2,notes:[{id:'workflow',text:'<img src=x onerror=alert(1)>',source:'user'}]},mutation;
 const f=await fixture(true,m=>{
  if(m.type==='task:site-memory')return {ok:true,value:current};
  if(m.type==='task:site-memory-change'){mutation=m;current={...current,version:3,notes:[{id:m.id,text:m.text}]};return {ok:true,value:current};}
 },true);
 await flush();assert.match(f.document.getElementById('site-memories').textContent,/workflow/);assert.equal(f.document.getElementById('site-memories').querySelector('img'),null);
 const id=f.document.getElementById('site-memory-id'),text=f.document.getElementById('site-memory-text');id.value='workflow';text.value='corrected';
 f.document.getElementById('site-memory-form').dispatchEvent(new f.window.Event('submit'));text.value='new draft';await flush();
 assert.equal(mutation.origin,'https://example.test');assert.equal(mutation.expectedVersion,2);assert.equal(text.value,'new draft');
});

test('task result cards escape page data and keep expandable outcome details',async()=>{
 const task={goal:'检查',status:'paused',phase:'observe',steps:3,prefs:{maxSteps:50},events:[],results:[{action:'click',label:'<img src=x>',result:'等待结果',outcome:{status:'unknown',code:'RECEIPT_LOST',evidence:[{actual:'<script>bad</script>'}]}}]};
 const f=await fixture(true,m=>m.type==='task:get'?{ok:true,value:task}:undefined);
 const results=f.document.getElementById('results');assert.match(results.textContent,/RECEIPT_LOST/);assert.match(results.textContent,/<script>bad/);assert.equal(results.querySelector('img,script'),null);assert.ok(results.querySelector('details pre'));
 assert.equal(f.document.getElementById('site-memory-panel'),null);assert.notEqual(f.document.getElementById('grant-all'),null);
});


test('chat shows chronological text messages and keeps operational details collapsed',async()=>{
 const task={taskId:'chat',goal:'<img src=x> original',status:'running',phase:'thinking',steps:4,prefs:{maxSteps:50},events:[{time:1,text:'你：<img src=x> original'},{time:2,text:'任务已开始'},{time:3,text:'First reply'},{time:4,text:'你（补充指令）：New requirement'},{time:5,text:'Second reply'}]};
 const f=await fixture(true,m=>m.type==='task:get'?{ok:true,value:task}:undefined),d=f.document;
 assert.equal(d.getElementById('run-details').hasAttribute('open'),false);
 assert.equal(d.getElementById('empty-state').hidden,true);
 assert.deepEqual([...d.querySelectorAll('#timeline .message p')].map(p=>p.textContent),['First reply','New requirement','Second reply']);
 assert.equal(d.getElementById('goal').querySelector('img'),null);
 assert.equal(d.getElementById('stop').hidden,false);assert.equal(d.getElementById('resume').hidden,true);
 assert.match(d.getElementById('progress').textContent,/正在思考/);
});

test('Enter submits while Shift Enter and composing Chinese text do not',async()=>{
 const f=await fixture(true),input=f.document.getElementById('instruction');let submissions=0;
 f.document.getElementById('chat').requestSubmit=()=>submissions++;
 const key=(props={})=>{const e=new f.window.Event('keydown',{cancelable:true});Object.assign(e,{key:'Enter',...props});input.dispatchEvent(e);return e;};
 key({shiftKey:true});key({isComposing:true});key({keyCode:229});assert.equal(submissions,0);
 input.dispatchEvent(new f.window.Event('compositionstart'));key();assert.equal(submissions,0);
 input.dispatchEvent(new f.window.Event('compositionend'));assert.equal(key().defaultPrevented,true);assert.equal(submissions,1);
});

test('paused tasks expose continuation while completed tasks keep new task input available',async()=>{
 for(const status of ['paused','completed']){
  const task={taskId:'one',goal:'Work',status,steps:2,prefs:{maxSteps:50},events:[{time:1,text:'Explain current outcome'}]};
  const f=await fixture(true,m=>m.type==='task:get'?{ok:true,value:task}:undefined),d=f.document;
  assert.equal(d.getElementById('stop').hidden,true);assert.equal(d.getElementById('resume').hidden,false);
  assert.equal(d.getElementById('start').disabled,false);
  assert.equal(d.getElementById('run-details').hasAttribute('open'),false);
 }
});


test('sidepanel all-site grant requests both schemes from gesture then connects only current tab',async()=>{
 for(const granted of [true,false]){
  const f=await fixture(granted);f.calls.length=0;
  f.document.getElementById('grant-all').dispatchEvent(new f.window.Event('click'));
  assert.equal(f.calls[0][0],'permission');assert.deepEqual(Array.from(f.calls[0][1].origins),['http://*/*','https://*/*']);
  await flush();
  if(granted){assert.equal(f.calls[1][1].type,'task:connect');assert.equal(f.calls[1][1].tabId,9);assert.match(f.document.getElementById('status').textContent,/所有普通网站已授权/);}
  else{assert.equal(f.calls.length,1);assert.match(f.document.getElementById('status').textContent,/取消/);}
 }
});


test('header history is read-only and new dialogue resets the view while retaining ended records',async()=>{
 const task={origin:'https://example.test',taskId:'dialogue',goal:'Current goal',status:'running',steps:2,prefs:{maxSteps:50},events:[{time:1,text:'Recent reply'}]};
 const f=await fixture(true,m=>m.type==='task:get'?{ok:true,value:task}:m.type==='task:finish'?{ok:true,value:{...task,status:'ended'}}:m.type==='task:history'?{ok:true,value:[task]}:m.type==='task:history-get'?{ok:true,value:task}:undefined),d=f.document;
 assert.deepEqual([...d.querySelectorAll('.app-header button')].map(el=>el.id),['history','finish','settings']);
 assert.equal(d.querySelector('.app-header img'),null);assert.equal(d.getElementById('task-menu'),null);
 assert.equal(d.getElementById('chat').contains(d.getElementById('finish')),false);
 f.calls.length=0;d.getElementById('history').click();
 assert.equal(d.getElementById('history-view').hidden,false);assert.equal(d.getElementById('conversation').hidden,true);
 await flush();d.querySelector('.conversation-item').click();await flush();
 assert.equal(d.getElementById('history-goal').textContent,'Current goal');assert.match(d.getElementById('event-log').textContent,/Recent reply/);
 assert.deepEqual(f.calls.map(c=>c[1].type),['task:history','task:history-get']);f.calls.length=0;
 d.getElementById('history-back').click();assert.equal(d.getElementById('conversation').hidden,false);
 d.getElementById('instruction').value='Old draft';d.getElementById('finish').click();await flush();assert.equal(f.calls[0][1].type,'task:finish');assert.equal(d.getElementById('finish').disabled,true);
 assert.equal(d.getElementById('empty-state').hidden,false);assert.equal(d.getElementById('timeline').hidden,true);assert.equal(d.getElementById('instruction').value,'');
 d.getElementById('history').click();await flush();d.querySelector('.conversation-item').click();await flush();assert.equal(d.getElementById('history-goal').textContent,'Current goal');
 assert.equal(d.getElementById('grant-all').disabled,false);
});


test('failed new dialogue retains the task and input draft',async()=>{
 const task={taskId:'old',goal:'Keep task',status:'running',steps:1,prefs:{maxSteps:50},events:[]};
 const f=await fixture(true,m=>m.type==='task:get'?{ok:true,value:task}:m.type==='task:finish'?{ok:false,error:'结束失败'}:undefined),d=f.document;
 d.getElementById('instruction').value='Keep draft';d.getElementById('finish').click();await flush();
 assert.equal(d.getElementById('instruction').value,'Keep draft');assert.equal(d.getElementById('empty-state').hidden,true);assert.match(d.getElementById('status').textContent,/结束失败/);
});


test('conversation tool cards show safe parameters, outcomes and legacy parameter gaps',async()=>{
 const task={taskId:'calls',goal:'Work',status:'running',phase:'executing',steps:2,prefs:{maxSteps:50},events:[{time:1,text:'Prepare'}],results:[{time:2,request:{action:'fill',id:'t0',value:'<img src=x>'},action:'fill',outcome:{status:'unknown',dispatch:'sent',code:'REPLY_LOST'}},{time:3,action:'observe',outcome:{status:'success',code:'PAGE_OBSERVED'}}],pending:{time:4,plan:{action:'click',id:'t1'},label:'Save'}};
 const f=await fixture(true,m=>m.type==='task:get'?{ok:true,value:task}:undefined),cards=f.document.querySelectorAll('#timeline .tool-call');
 assert.equal(cards.length,3);assert.match(cards[0].textContent,/请求参数/);assert.match(cards[0].textContent,/REPLY_LOST/);assert.match(cards[0].textContent,/结果未知/);
 assert.equal(cards[0].querySelector('img'),null);assert.equal(cards[0].hasAttribute('open'),false);
 assert.match(cards[1].textContent,/旧记录未保存完整参数/);assert.match(cards[2].textContent,/执行中/);
});


test('later verification updates one operation card and preserves its original request',async()=>{
 const task={taskId:'verify',goal:'Work',status:'running',steps:2,prefs:{maxSteps:50},events:[],results:[{time:1,action:'click',request:{action:'click',id:'t0'},outcome:{operationId:'op',status:'unknown'}},{time:2,action:'action',outcome:{operationId:'op',status:'success',code:'CONDITIONS_MATCH'}}]};
 const f=await fixture(true,m=>m.type==='task:get'?{ok:true,value:task}:undefined),cards=f.document.querySelectorAll('#timeline .tool-call');
 assert.equal(cards.length,1);assert.match(cards[0].textContent,/click/);assert.match(cards[0].textContent,/t0/);assert.match(cards[0].textContent,/CONDITIONS_MATCH/);
});

test('history selects one conversation as text, returns to live task and discards a late detail response',async()=>{
 const live={taskId:'live',origin:'https://example.test',goal:'Current work',status:'running',steps:1,prefs:{maxSteps:50},events:[{time:2,text:'Live reply'}],results:[]};
 const old={...live,taskId:'old',goal:'<img src=x> Old work',status:'ended',events:[{time:1,text:'Old reply only'}],results:[]};
 let delayed=false,resolve;
 const f=await fixture(true,m=>m.type==='task:get'?{ok:true,value:live}:m.type==='task:history'?{ok:true,value:[live,old]}:m.type==='task:history-get'?delayed?new Promise(r=>resolve=r):{ok:true,value:old}:undefined),d=f.document;
 d.getElementById('history').click();await flush();
 assert.equal(d.querySelectorAll('.conversation-item').length,2);assert.equal(d.querySelector('#conversation-list img'),null);
 d.querySelector('[data-task-id="old"]').click();await flush();
 assert.match(d.getElementById('history-messages').textContent,/Old reply only/);assert.doesNotMatch(d.getElementById('history-messages').textContent,/Live reply/);
 assert.equal(d.getElementById('composer').hidden,true);assert.equal(d.getElementById('clear').hidden,true);assert.equal(d.getElementById('finish').disabled,false);
 d.getElementById('history-back').click();assert.equal(d.getElementById('goal').textContent,'Current work');assert.match(d.getElementById('timeline').textContent,/Live reply/);
 delayed=true;d.getElementById('history').click();await flush();d.querySelector('[data-task-id="old"]').click();d.getElementById('history-back').click();resolve({ok:true,value:old});await flush();
 assert.equal(d.getElementById('goal').textContent,'Current work');assert.equal(d.getElementById('history-view').hidden,true);
 assert.equal(f.calls.some(c=>['task:submit','task:resume','task:finish'].includes(c[1].type)),false);
});

test('decision form renders escaped options and submits multiple choices once',async()=>{
 const task={taskId:'t',goal:'整理',status:'paused',reason:'question',steps:1,prefs:{maxSteps:50},events:[],question:{id:'q',text:'选择内容',options:['<img src=x>','明细','建议']},notice:'即将提交'};
 const f=await fixture(true,m=>m.type==='task:get'?{ok:true,value:task}:m.type==='task:choose'?{ok:true,value:{...task,status:'running',question:null}}:undefined);
 const form=f.document.getElementById('choice-form');assert.equal(form.hidden,false);assert.equal(form.querySelector('img'),null);
 const inputs=form.querySelectorAll('input');inputs[0].checked=true;inputs[2].checked=true;form.dispatchEvent(new f.window.Event('submit'));await flush();
 const msg=f.calls.find(c=>c[1].type==='task:choose')[1];assert.equal(JSON.stringify(msg.indices),'[0,2]');assert.equal(msg.questionId,'q');assert.equal(form.hidden,true);
 assert.match(f.document.getElementById('important-notice').textContent,/即将提交/);
});


test('tool summaries distinguish dispatch, scroll boundaries, stale targets and uncertain effects',async()=>{
 const receipt={status:'unknown',dispatch:'sent',scope:'dispatch',code:'PAGE_CHANGED'};
 const cases=[
  {action:'click',outcome:receipt,label:'已派发，待核对'},
  {action:'wheel',outcome:{...receipt,observed:{input:'wheel',deltaY:600}},label:'已派发，待核对'},
  {action:'click',outcome:{...receipt,scope:'page',code:'CONDITION_TIMEOUT'},label:'结果未知'},
  {action:'click',outcome:{...receipt,dispatch:'not_sent',code:'STALE'},label:'目标过期，未执行'},
  {action:'click',outcome:{...receipt,dispatch:'not_sent',code:'TARGET_BLOCKED'},label:'目标被遮挡，未执行'},
  {action:'scroll',outcome:{...receipt,observed:{delta:300}},label:'已滚动'},
  {action:'scroll',request:{value:'down'},outcome:{...receipt,code:'NO_CHANGE',observed:{delta:0,atEnd:true}},label:'已到边界'},
  {action:'scroll',request:{value:'left'},outcome:{...receipt,observed:{delta:0,atStart:true}},label:'已到边界'},
  {action:'scroll',request:{value:'up'},outcome:{...receipt,observed:{delta:0,atEnd:true}},label:'未观察到滚动'},
  {action:'click',outcome:{...receipt,dispatch:'unknown',code:'REPLY_LOST'},label:'结果未知'},
  {action:'click',outcome:{...receipt,scope:'ui',code:'CONDITIONS_UNMET'},label:'结果未知'},
  {action:'scroll',outcome:{...receipt,code:'REPLY_LOST',observed:{delta:300}},label:'结果未知'},
 ];
 const task={taskId:'outcomes',goal:'Work',status:'running',steps:2,prefs:{maxSteps:50},events:[],results:cases.map((c,i)=>({...c,time:i+1}))};
 const f=await fixture(true,m=>m.type==='task:get'?{ok:true,value:task}:undefined);
 const cards=[...f.document.querySelectorAll('#timeline .tool-call')];
 assert.equal(cards.length,cases.length);
 cards.forEach((card,i)=>{assert.ok(card.querySelector('summary').textContent.endsWith(cases[i].label));assert.equal(card.dataset.status,'unknown');});
});


test('authorization buttons follow existing grants and permission revocation',async()=>{
 let site=true,all=true;
 const f=await fixture(true,()=>undefined,false,async p=>p.origins.length===2?all:site),d=f.document;
 assert.equal(d.getElementById('grant').hidden,true);assert.equal(d.getElementById('grant-all').hidden,true);
 all=false;f.removed();await flush();
 assert.equal(d.getElementById('grant').hidden,true);assert.equal(d.getElementById('grant-all').hidden,false);
 site=false;f.removed();await flush();assert.equal(d.getElementById('grant').hidden,false);
 site=true;all=true;f.added();await flush();
 assert.equal(d.getElementById('grant').hidden,true);assert.equal(d.getElementById('grant-all').hidden,true);
});

test('sidepanel exposes takeover and labels its fresh-observation continuation',async()=>{
 let state={taskId:'t',goal:'Work',status:'running',steps:3,prefs:{maxSteps:50},events:[],results:[]};
 const f=await fixture(true,m=>{
  if(m.type==='task:get')return {ok:true,value:state};
  if(m.type==='task:takeover'){state={...state,status:'paused',reason:'user_takeover'};return {ok:true,value:state};}
  if(m.type==='task:resume'){state={...state,status:'running',reason:null};return {ok:true,value:state};}
 });
 assert.equal(f.document.getElementById('takeover').hidden,false);
 f.document.getElementById('takeover').dispatchEvent(new f.window.Event('click'));await flush();
 assert.equal(f.document.getElementById('resume').textContent,'操作完成，重新观察');assert.equal(f.document.getElementById('takeover').hidden,true);
 f.document.getElementById('resume').dispatchEvent(new f.window.Event('click'));await flush();
 assert.equal(f.calls.filter(c=>c[0]==='message'&&c[1].type==='task:takeover').length,1);
 assert.equal(f.calls.filter(c=>c[0]==='message'&&c[1].type==='task:resume').length,1);
});

test('milestone UI shows historical verification and renders untrusted titles as text',async()=>{
 const f=await fixture(true,m=>m.type==='task:get'?{ok:true,value:{taskId:'t',goal:'Work',status:'running',steps:1,prefs:{maxSteps:50},events:[],results:[],taskPlan:[{id:'one',title:'<img src=x onerror=alert(1)>',status:'completed',verification:{status:'success'}},{id:'two',title:'Save',status:'active',verification:{status:'unknown'}}]}}:undefined);
 assert.equal(f.document.getElementById('task-plan').hidden,false);assert.match(f.document.getElementById('task-plan-items').textContent,/曾核对通过/);assert.match(f.document.getElementById('task-plan-items').textContent,/unknown/);assert.equal(f.document.getElementById('task-plan-items').querySelector('img'),null);
});
