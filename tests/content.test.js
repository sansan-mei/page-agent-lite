const {test}=require('node:test');const assert=require('node:assert/strict');const {parseHTML}=require('linkedom');const vm=require('node:vm');const fs=require('node:fs');const path=require('node:path');

const flush=()=>new Promise(r=>setImmediate(r));

async function fixture(records=[],enabled=true, hook=()=>undefined, timer=setTimeout){
    const {document,window}=parseHTML('<html><body><article><h1>Test article</h1><p>Hello paragraph</p></article></body></html>');
    window.scrollBy=()=>{};
    let shadow;
    const oldAttachShadow=window.Element.prototype.attachShadow;
    window.Element.prototype.attachShadow=function(opts){const s=oldAttachShadow.call(this,opts);shadow=s;return s;};
    const sent=[];
    const _doc=document;
    // Load core first, then expose it explicitly in context
    const corePath=path.join(__dirname,'../extension/core.js');
    const coreSrc=fs.readFileSync(corePath,'utf8');
    const chrome={runtime:{async sendMessage(m){sent.push(structuredClone(m));const override=hook(m);if(override!==undefined)return await override;if(m.type==='load')return {ok:true,value:{records,enabled}};if(m.task==='edit'){try{const snap=PageAgentCore.collect(_doc);const idx=snap.outline.findIndex(n=>n.text.includes('Hello'));return {ok:true,value:{text:idx>=0?JSON.stringify({operations:[{id:snap.outline[idx].id,action:'style',property:'color',value:'#123456'}]}):JSON.stringify({operations:[]})}};}catch(e){console.log('[STUB ERR]',e.message);return {ok:true,value:{text:JSON.stringify({operations:[]})}};}}return {ok:true,value:{text:'<b>纯文本结果</b>'}};}}};
    // Create context WITH PageAgentCore already available from Node require
    const context=vm.createContext({document,window,chrome,console,URL,setTimeout:timer,clearTimeout,location:{href:'https://news.test/a'},getSelection:()=>window.getSelection?.()});
    // Execute core in context, then pass PageAgentCore into context globals
    vm.runInContext(coreSrc,context);
    Object.defineProperty(context,'PageAgentCore',{value:PageAgentCore,writable:true,configurable:true});
    const cjsPath=path.join(__dirname,'../extension/article-tools.js');
    if(fs.existsSync(cjsPath))vm.runInContext(fs.readFileSync(cjsPath,'utf8'),context);await flush();
    return {document,window,context,sent,get ui(){return shadow;},async click(id){const ev=new window.Event('click');Object.defineProperty(ev,'isTrusted',{value:true});shadow.getElementById(id).dispatchEvent(ev);await flush();await flush();}};
}

// Require core at top-level for the stub (it has no DOM deps)
const PageAgentCore=fs.existsSync(path.join(__dirname,'../extension/core.js'))?require('../extension/core.js'):{};

test('editing previews before explicit apply; clear persists empty state and reload restores no model calls',async()=>{
    const f=await fixture();assert.ok(f.ui.getElementById('prompt'),'editing prompt exists');assert.ok(f.ui.getElementById('propose'));f.ui.getElementById('prompt').value='让段落变蓝';await f.click('propose');assert.equal(f.document.querySelector('p').style.color,undefined);assert.match(f.ui.getElementById('preview').textContent,/#123456/);await f.click('apply');assert.equal(f.document.querySelector('p').style.color,'#123456');const saved=f.sent.filter(m=>m.type==='save').at(-1).records;
    const reloaded=await fixture(saved);assert.equal(reloaded.document.querySelector('p').style.color,'#123456');assert.equal(reloaded.sent.filter(m=>m.type==='model').length,0);await reloaded.click('clear');assert.equal(reloaded.document.querySelector('p').getAttribute('style'),null);assert.deepEqual(reloaded.sent.filter(m=>m.type==='save').at(-1).records,[]);
    const again=await fixture([]);assert.equal(again.document.querySelector('p').getAttribute('style'),null);
});

test('translation captures selected article paragraph, excludes form selections, inserts beside it',async()=>{
    const f=await fixture();assert.ok(f.ui.getElementById('translate'));const p=f.document.querySelector('p');
    f.window.getSelection=()=>({rangeCount:1,anchorNode:p.firstChild,focusNode:p.firstChild,toString:()=> 'Hello',getRangeAt:()=>({cloneContents:()=>f.document.createDocumentFragment()})});
    f.document.dispatchEvent(new f.window.Event('selectionchange'));
    await f.click('translate');
    const ns=p.nextElementSibling;
    assert.equal(ns?.getAttribute('data-page-agent'),'translation','Translation element should be inserted after selected paragraph');
    assert.equal(ns?.textContent,'<b>纯文本结果</b>');assert.equal(ns.querySelector('b'),null);assert.equal(f.sent.find(m=>m.task==='translate').text,'Hello');
});

test('pending model disables controls, async errors surface, navigation never applies stale responses',async()=>{
    let resolve;
    const f=await fixture([],true,m=>m.type==='model'?new Promise(r=>resolve=r):undefined);
    await f.click('summary');assert.equal(f.ui.getElementById('clear').disabled,true);
    await f.click('summary');assert.equal(f.sent.filter(m=>m.type==='model').length,1);
    resolve({ok:false,error:'API 请求失败'});await flush();await flush();
    assert.match(f.ui.querySelector('[role=status]').textContent,/API 请求失败/);
    assert.equal(f.ui.getElementById('clear').disabled,false);
    await f.click('summary');f.context.location.href='https://news.test/other';
    resolve({ok:true,value:{text:'stale'}});await flush();await flush();
    assert.equal(f.document.querySelector('[data-page-agent=summary]'),null);
    assert.match(f.ui.querySelector('[role=status]').textContent,/地址已变化/);
});

test('rejected network promise is handled; save stays busy and failure does not change DOM',async()=>{
 let rejectNetwork;
 const f=await fixture([],true,m=>m.type==='model'?new Promise((_,reject)=>{rejectNetwork=reject;}):undefined);
 await f.click('summary');rejectNetwork(Error('网络中断'));await flush();await flush();
 assert.match(f.ui.querySelector('[role=status]').textContent,/网络中断/);
 assert.equal(f.ui.getElementById('summary').disabled,false);
 let finishSave;
 const g=await fixture([],true,m=>m.type==='save'?new Promise(resolve=>{finishSave=resolve;}):undefined);
 await g.click('summary');assert.equal(g.ui.getElementById('undo').disabled,true);
 assert.equal(g.document.querySelector('[data-page-agent=summary]'),null);
 finishSave({ok:false,error:'存储失败'});await flush();await flush();
 assert.match(g.ui.querySelector('[role=status]').textContent,/存储失败/);
 assert.equal(g.document.querySelector('[data-page-agent=summary]'),null);
});
test('form selection makes no request and temporary mode refuses more than 30 records',async()=>{
 const f=await fixture([],false);const form=f.document.createElement('form');form.innerHTML='<p>private</p>';f.document.body.append(form);
 const node=form.querySelector('p').firstChild;
 f.window.getSelection=()=>({rangeCount:1,anchorNode:node,focusNode:node,toString:()=> 'private',getRangeAt:()=>({cloneContents:()=>f.document.createDocumentFragment()})});
 f.document.dispatchEvent(new f.window.Event('selectionchange'));await f.click('translate');
 assert.equal(f.sent.filter(m=>m.type==='model').length,0);
 const target=PageAgentCore.describe(f.document.querySelector('h1'));
 const g=await fixture(Array(30).fill({kind:'summary',target,text:'old'}),false);
 await g.click('summary');assert.match(g.ui.querySelector('[role=status]').textContent,/30/);
 assert.equal(g.document.querySelectorAll('[data-page-agent=summary]').length,30);
});
module.exports={fixture,flush};
