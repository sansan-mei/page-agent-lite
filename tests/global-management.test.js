const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const {parseHTML}=require('linkedom');const {runUi}=require('./i18n-helper.js');
const flush=()=>new Promise(r=>setImmediate(r));
test('global memory can be viewed and edited without tabs; HTML is text and failures retain drafts',async()=>{
 const {document,window}=parseHTML(fs.readFileSync('extension/options.html','utf8'));let current={scope:'global',version:2,notes:[{id:'pref',text:'<img src=x onerror=alert(1)>'}]},fail=false;const calls=[];
 const chrome={runtime:{async sendMessage(m){calls.push(m);if(m.type==='task:skills')return {ok:true,value:{scope:'skills',version:0,notes:[]}};if(m.type==='task:global-memory')return {ok:true,value:current};if(fail)return {ok:false,error:'长期记忆已更新，请刷新后重试'};current={scope:'global',version:3,notes:[{id:m.id,text:m.text}]};return {ok:true,value:current};}}};
 runUi('extension/global-management.js',{chrome,document,URL,Blob,setTimeout});await flush();
 assert.equal(document.querySelector('#global-memories img'),null);assert.match(document.getElementById('global-memories').textContent,/<img/);
 document.querySelector('#global-memories button').click();assert.equal(document.getElementById('global-memory-id').value,'pref');assert.equal(document.getElementById('global-memory-text').value,current.notes[0].text);
 document.getElementById('global-memory-text').value='Chinese tables';document.getElementById('global-memory-form').dispatchEvent(new window.Event('submit'));await flush();
 const write=calls.find(m=>m.type==='task:global-memory-change');assert.equal(write.expectedVersion,2);assert.equal(write.text,'Chinese tables');assert.equal(write.tabId,undefined);assert.equal(current.notes[0].text,'Chinese tables');
 fail=true;document.getElementById('global-memory-id').value='pref';document.getElementById('global-memory-text').value='my draft';document.getElementById('global-memory-form').dispatchEvent(new window.Event('submit'));await flush();assert.equal(document.getElementById('global-memory-text').value,'my draft');assert.equal(document.getElementById('global-memory-save').disabled,true);
 document.getElementById('global-memory-refresh').click();await flush();assert.equal(document.getElementById('global-memory-text').value,'my draft');assert.equal(document.getElementById('global-memory-save').disabled,false);
});

test('the skill library is listed without a tab, shows each skill\'s sites as text and deletes with the read version',async()=>{
 const {document}=parseHTML(fs.readFileSync('extension/options.html','utf8'));const calls=[];
 let current={scope:'skills',version:3,notes:[{id:'export',description:'<b>Export</b> orders',sites:['https://shop.test'],text:'1. Open Orders\n2. Click Export'},{id:'paging',description:'Collect a paged list',sites:[],text:'1. Read rows\n2. Next page'}]};
 const chrome={runtime:{async sendMessage(m){calls.push(m);if(m.type==='task:global-memory')return {ok:true,value:{scope:'global',version:0,notes:[]}};
  if(m.type==='task:skills')return {ok:true,value:current};
  if(m.type==='task:skill-change'){current={scope:'skills',version:current.version+1,notes:m.action==='clear'?[]:current.notes.filter(n=>n.id!==m.id)};return {ok:true,value:current};}
  throw new Error('unexpected '+m.type);}}};
 runUi('extension/global-management.js',{chrome,document,URL,Blob,setTimeout});await flush();
 const list=document.getElementById('skills');
 assert.equal(list.querySelector('b'),null);assert.match(list.textContent,/<b>Export<\/b> orders/);assert.match(list.textContent,/Click Export/);
 assert.match(list.textContent,/https:\/\/shop\.test/);assert.equal(list.children.length,2);
 assert.equal(document.getElementById('skill-clear').disabled,false);
 list.querySelector('button').click();await flush();
 const change=calls.find(m=>m.type==='task:skill-change');
 assert.deepEqual({action:change.action,id:change.id,expectedVersion:change.expectedVersion,tabId:change.tabId},{action:'delete',id:'export',expectedVersion:3,tabId:undefined});
 assert.equal(list.children.length,1);
 document.getElementById('skill-clear').click();await flush();
 assert.equal(list.children.length,0);assert.equal(document.getElementById('skill-clear').disabled,true);
});
