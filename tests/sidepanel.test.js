const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const {parseHTML}=require('linkedom');
const flush=()=>new Promise(r=>setImmediate(r));
async function fixture(granted,hook=()=>undefined){
 const {document,window}=parseHTML(fs.readFileSync('extension/sidepanel.html','utf8'));
 const calls=[];let updated;const chrome={tabs:{async query(){return [{id:9,url:'https://example.test/task',title:'Homework'}];},onActivated:{addListener(){}},onUpdated:{addListener(fn){updated=fn;}}},permissions:{request(p){calls.push(['permission',p]);return Promise.resolve(granted);}},runtime:{async sendMessage(m){calls.push(['message',m]);const result=hook(m);if(result!==undefined)return await result;return {ok:true,value:m.type==='task:get'?null:{connected:true}};},async openOptionsPage(){}},storage:{onChanged:{addListener(){}}}};
 vm.runInNewContext(fs.readFileSync('extension/sidepanel.js','utf8'),{chrome,document,URL,Date});await flush();
 return {document,window,calls,updated};
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
 assert.equal(input.value,'');assert.match(f.document.getElementById('start').textContent,/继续当前任务/);
 input.value='第二条';form.dispatchEvent(new f.window.Event('submit'));input.value='正在写第三条';resolve({ok:true,value:task});await flush();assert.equal(input.value,'正在写第三条');
 form.dispatchEvent(new f.window.Event('submit'));resolve({ok:false,error:'连接失败'});await flush();assert.equal(input.value,'正在写第三条');
});
test('denied website grant never injects or starts a task',async()=>{
 const f=await fixture(false);f.calls.length=0;
 f.document.getElementById('grant').dispatchEvent(new f.window.Event('click'));await flush();
 assert.equal(f.calls.length,1);assert.match(f.document.getElementById('status').textContent,/取消/);
});

test('all-site button requests HTTP and HTTPS optional hosts explicitly before connecting',async()=>{
 const f=await fixture(true);f.calls.length=0;
 f.document.getElementById('grant-all').dispatchEvent(new f.window.Event('click'));
 assert.deepEqual(Array.from(f.calls[0][1].origins),['http://*/*','https://*/*']);
 await flush();assert.equal(f.calls[1][1].type,'task:connect');
 assert.match(f.document.getElementById('status').textContent,/所有普通网站已授权/);
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
 });
 await flush();assert.match(f.document.getElementById('site-memories').textContent,/workflow/);assert.equal(f.document.getElementById('site-memories').querySelector('img'),null);
 const id=f.document.getElementById('site-memory-id'),text=f.document.getElementById('site-memory-text');id.value='workflow';text.value='corrected';
 f.document.getElementById('site-memory-form').dispatchEvent(new f.window.Event('submit'));text.value='new draft';await flush();
 assert.equal(mutation.origin,'https://example.test');assert.equal(mutation.expectedVersion,2);assert.equal(text.value,'new draft');
});
