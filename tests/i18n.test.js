const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {parseHTML}=require('linkedom');const {messages,chromeI18n,runUi}=require('./i18n-helper.js');
const ext=path.join(__dirname,'../extension');const flush=()=>new Promise(r=>setImmediate(r));
const CJK=/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;
const placeholders=text=>[...text.matchAll(/\{[1-9]\}/g)].map(m=>m[0]).sort();

test('locales are valid JSON with identical keys and placeholders, and manifest messages resolve',()=>{
 const zh=messages('zh_CN'),en=messages('en');
 assert.deepEqual(Object.keys(en).sort(),Object.keys(zh).sort());
 for(const key of Object.keys(zh)){
  for(const [locale,data] of [['zh_CN',zh],['en',en]]){
   assert.equal(typeof data[key].message,'string',locale+':'+key);assert.ok(data[key].message.trim(),locale+':'+key);
   // chrome.i18n treats "$" as substitution syntax; i18n.js uses {n} placeholders instead.
   assert.ok(!data[key].message.includes('$'),locale+':'+key);
  }
  assert.deepEqual(placeholders(en[key].message),placeholders(zh[key].message),key);
  assert.doesNotMatch(en[key].message,CJK,'en:'+key);
 }
 const manifest=JSON.parse(fs.readFileSync(path.join(ext,'manifest.json'),'utf8'));
 assert.equal(manifest.default_locale,'zh_CN');
 for(const value of [manifest.name,manifest.description,manifest.action.default_title]){
  const key=/^__MSG_(\w+)__$/.exec(value)?.[1];assert.ok(key&&zh[key]&&en[key],value);
 }
 assert.equal(zh.extName.message,'Page Agent Lite · 浏览器助手');assert.equal(en.extName.message,'Page Agent Lite · Browser Assistant');
 assert.ok(zh.extName.message.length<=75&&en.extName.message.length<=75);
 assert.ok(zh.extDescription.message.length<=132&&en.extDescription.message.length<=132);
});

test('every UI message key used by pages and scripts exists',()=>{
 const zh=messages('zh_CN'),used=new Set();
 for(const file of fs.readdirSync(ext).filter(name=>/\.(html|js)$/.test(name))){
  const source=fs.readFileSync(path.join(ext,file),'utf8');
  if(file.endsWith('.html'))for(const m of source.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g))used.add(m[1]);
  if(file.endsWith('.js'))for(const m of source.matchAll(/\bt\('([A-Za-z0-9_]+)'/g))used.add(m[1]);
 }
 assert.ok(used.size>100);
 for(const key of used)assert.ok(zh[key],key);
});

test('i18n placeholders substitute and missing keys fall back to the key',()=>{
 const ctx=runUi('extension/welcome-image.js',{chrome:{i18n:chromeI18n('en'),storage:{local:{async get(){return {};}},onChanged:{addListener(){}}}},document:parseHTML('<p></p>').document});
 assert.equal(ctx.PageAgentI18n.t('spProgress','Running',3,100),'Running · 3 / 100 rounds');
 assert.equal(ctx.PageAgentI18n.t('commonLabelValue','id','{2} literal'),'id: {2} literal');
 assert.equal(ctx.PageAgentI18n.t('missingKey'),'missingKey');
 const d=ctx.PageAgentI18n.defaultReplyLanguage;
 assert.equal(d('en-US'),'English');assert.equal(d('zh-CN'),'简体中文');assert.equal(d('zh'),'简体中文');assert.equal(d('zh-TW'),'繁體中文');assert.equal(d('zh_HK'),'繁體中文');assert.equal(d(''),'English');
 assert.equal(d('ja'),'日本語');
});

function sidepanel(locale){
 const {document,window}=parseHTML(fs.readFileSync(path.join(ext,'sidepanel.html'),'utf8'));
 const listener={addListener(){}};
 const chrome={i18n:chromeI18n(locale),tabs:{async query(){return [{id:9,url:'https://example.test/',title:'Example'}];},onActivated:listener,onUpdated:listener},
  permissions:{async contains(){return false;},onAdded:listener,onRemoved:listener,async request(){return true;}},
  runtime:{async sendMessage(m){return {ok:true,value:m.type==='task:get'?null:m.type==='agentPreferences'?{inputChars:2000}:{}};},async openOptionsPage(){}},storage:{onChanged:listener}};
 runUi('extension/sidepanel.js',{chrome,document,window,URL,Date});
 return {document,window};
}
function visibleCjk(document){
 const found=[];
 for(const node of document.querySelectorAll('body *')){
  if(['SCRIPT','STYLE'].includes(node.tagName))continue;
  for(const child of node.childNodes)if(child.nodeType===3&&CJK.test(child.textContent))found.push(child.textContent.trim());
  for(const name of ['title','placeholder','aria-label','alt'])if(CJK.test(node.getAttribute(name)||''))found.push(name+'='+node.getAttribute(name));
 }
 if(CJK.test(document.title))found.push('title='+document.title);
 return found;
}

test('side panel renders English static and initial dynamic UI when the browser UI is English',async()=>{
 const {document}=sidepanel('en');await flush();await flush();
 assert.equal(document.documentElement.lang,'en');
 assert.deepEqual(visibleCjk(document),[]);
 assert.equal(document.getElementById('finish').textContent,'New chat');
 assert.equal(document.getElementById('use-current').textContent,'Switch tab');
 assert.equal(document.getElementById('progress').textContent,'Ready');
 assert.equal(document.getElementById('instruction').getAttribute('placeholder'),'Tell me what you want to do…');
 const zh=sidepanel('zh_CN').document;await flush();await flush();
 assert.equal(zh.documentElement.lang,'zh-CN');assert.equal(zh.getElementById('finish').textContent,'新对话');assert.equal(zh.getElementById('progress').textContent,'准备就绪');
});

function options(locale,uiLanguage,config){
 const {document,window}=parseHTML(fs.readFileSync(path.join(ext,'options.html'),'utf8'));
 const listener={addListener(){}};
 const chrome={i18n:chromeI18n(locale,uiLanguage),tabs:{async query(){return [{id:1,url:'https://example.test/',title:'Example'}];},onUpdated:listener,onRemoved:listener},storage:{local:{async get(){return {};}},onChanged:listener},permissions:{async request(){return true;}},
  runtime:{async sendMessage(m){return {ok:true,value:m.type==='settings'?config:m.type==='agentPreferences'?{maxSteps:100}:m.type==='task:site-memory'?{origin:'https://example.test',version:0,notes:[]}:m.type==='task:global-memory'?{scope:'global',version:0,notes:[]}:{}};}}};
 const core=require('../extension/core.js');
 for(const file of ['extension/options.js','extension/management.js','extension/global-management.js','extension/welcome-image.js'])runUi(file,{chrome,document,window,URL,Blob,setTimeout,PageAgentCore:core,Image:class{}});
 return document;
}

test('settings page is English for English UI; reply language defaults to the UI language but keeps saved values',async()=>{
 let document=options('en','en-US',{});for(let i=0;i<4;i++)await flush();
 // Reply-language presets are shown in their own language on purpose.
 assert.deepEqual(visibleCjk(document).filter(text=>!['value=简体中文','简体中文','繁體中文','日本語'].includes(text)),[]);
 assert.equal(document.title,'Page Agent Lite · Settings');
 const choice=document.getElementById('language-choice');
 assert.equal(document.getElementById('language').value,'English');assert.equal(choice.value,'browser');assert.equal(document.getElementById('language').hidden,true);
 assert.equal(choice.querySelector('option[value="browser"]').textContent,'Follow browser (English)');
 // The status bar only appears for save results and errors.
 assert.equal(document.getElementById('status').hidden,true);assert.equal(document.getElementById('status').textContent,'');
 assert.equal(document.getElementById('save-settings').disabled,false);
 assert.equal(document.getElementById('site-memory-status').textContent,'No long-term memory for this site');
 assert.equal(document.getElementById('global-memory-status').textContent,'No global long-term memory');
 document=options('en','en-US',{language:'简体中文'});for(let i=0;i<4;i++)await flush();
 assert.equal(document.getElementById('language').value,'简体中文','saved language must not be replaced');assert.equal(document.getElementById('language-choice').value,'简体中文');
 document=options('en','en-US',{language:'Deutsch'});for(let i=0;i<4;i++)await flush();
 assert.equal(document.getElementById('language-choice').value,'other');assert.equal(document.getElementById('language').hidden,false);assert.equal(document.getElementById('language').value,'Deutsch');
 document=options('zh_CN','zh-CN',{});for(let i=0;i<4;i++)await flush();
 assert.equal(document.getElementById('language').value,'简体中文');assert.equal(document.title,'Page Agent Lite · 设置');
});
