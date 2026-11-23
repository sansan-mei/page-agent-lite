const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const {parseHTML}=require('linkedom');
const flush=()=>new Promise(r=>setImmediate(r));
test('global memory can be viewed and edited without tabs; HTML is text and failures retain drafts',async()=>{
 const {document,window}=parseHTML(fs.readFileSync('extension/options.html','utf8'));let current={scope:'global',version:2,notes:[{id:'pref',text:'<img src=x onerror=alert(1)>'}]},fail=false;const calls=[];
 const chrome={runtime:{async sendMessage(m){calls.push(m);if(m.type==='task:global-memory')return {ok:true,value:current};if(fail)return {ok:false,error:'长期记忆已更新，请刷新后重试'};current={scope:'global',version:3,notes:[{id:m.id,text:m.text}]};return {ok:true,value:current};}}};
 vm.runInNewContext(fs.readFileSync('extension/global-management.js','utf8'),{chrome,document,URL,Blob,setTimeout});await flush();
 assert.equal(document.querySelector('#global-memories img'),null);assert.match(document.getElementById('global-memories').textContent,/<img/);
 document.querySelector('#global-memories button').click();assert.equal(document.getElementById('global-memory-id').value,'pref');assert.equal(document.getElementById('global-memory-text').value,current.notes[0].text);
 document.getElementById('global-memory-text').value='Chinese tables';document.getElementById('global-memory-form').dispatchEvent(new window.Event('submit'));await flush();
 const write=calls.find(m=>m.type==='task:global-memory-change');assert.equal(write.expectedVersion,2);assert.equal(write.text,'Chinese tables');assert.equal(write.tabId,undefined);assert.equal(current.notes[0].text,'Chinese tables');
 fail=true;document.getElementById('global-memory-id').value='pref';document.getElementById('global-memory-text').value='my draft';document.getElementById('global-memory-form').dispatchEvent(new window.Event('submit'));await flush();assert.equal(document.getElementById('global-memory-text').value,'my draft');assert.equal(document.getElementById('global-memory-save').disabled,true);
 document.getElementById('global-memory-refresh').click();await flush();assert.equal(document.getElementById('global-memory-text').value,'my draft');assert.equal(document.getElementById('global-memory-save').disabled,false);
});
