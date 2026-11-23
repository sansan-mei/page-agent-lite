const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {parseHTML}=require('linkedom');
test('DOM outline excludes private/interactive regions and applies validated edits with exact undo',()=>{
 assert.equal(typeof core.collect,'function');
 const {document}=parseHTML('<html><body><article><p style="color:red!important">Hello world</p><p>Second</p><form><p>secret</p></form><div contenteditable><p>private</p></div><nav><p>menu</p></nav><script>secret</script></article></body></html>');
 const snap=core.collect(document);
 assert.deepEqual(snap.outline.map(x=>x.text),['Hello world','Second']);
 const p=document.querySelector('p'), original=p.getAttribute('style');
 const ops=core.proposal(JSON.stringify({operations:[{id:snap.outline[0].id,action:'style',property:'color',value:'#123456'},{id:snap.outline[1].id,action:'hide'}]}),snap);
 const undo=core.apply(ops,snap);assert.equal(p.style.color,'#123456');assert.equal(document.querySelectorAll('p')[1].style.display,'none');undo();assert.equal(p.getAttribute('style'),original);assert.equal(document.querySelectorAll('p')[1].getAttribute('style'),null);
 for(const op of [{id:'bad',action:'hide'},{id:snap.outline[0].id,action:'style',property:'background-image',value:'url(x)'},{id:snap.outline[0].id,action:'style',property:'color',value:'red;display:none'},{id:snap.outline[0].id,action:'html',value:'<script>'},{id:snap.outline[0].id,action:'hide',selector:'body'}]) assert.throws(()=>core.proposal(JSON.stringify({operations:[op]}),snap));
 assert.throws(()=>core.proposal('```json\n{}\n```',snap));
});
const core=fs.existsSync(require('node:path').join(__dirname,'../extension/core.js'))?require('../extension/core.js'):{};
test('saved edits restore after reload, skip changed or ambiguous targets, undo removes replay',()=>{
 assert.equal(typeof core.describe,'function');
 const html='<html><body><article><p>Hello unique</p><p>Other</p></article></body></html>';
 const doc=()=>parseHTML(html).document;
 const d1=doc(), target=core.describe(d1.querySelector('p'));
 const record={kind:'translation',target,text:'译文'};
 const d2=doc(), result=core.restore(d2,[record]);assert.equal(result.skipped,0);assert.equal(d2.querySelector('[data-page-agent]').textContent,'译文');assert.equal(d2.querySelector('img'),null);
 result.undos[0]();assert.equal(d2.querySelector('[data-page-agent]'),null);
 assert.equal(core.restore(doc(),[]).undos.length,0);
 const changed=doc();changed.querySelector('p').textContent='Changed';assert.equal(core.restore(changed,[record]).skipped,1);
 const dup=doc();dup.body.appendChild(dup.querySelector('p').cloneNode(true));assert.equal(core.restore(dup,[record]).skipped,1);
 const layout={kind:'edit',target,action:'style',property:'font-size',value:'20px'};const d3=doc();const r=core.restore(d3,[layout]);assert.equal(d3.querySelector('p').style.fontSize,'20px');r.undos[0]();assert.equal(d3.querySelector('p').getAttribute('style'),null);
});
test('serialized size limits count UTF-8 bytes rather than JavaScript characters',()=>{
 assert.equal(core.byteSize('中文'),6);
 assert.equal(core.byteSize('abc'),3);
 assert.ok(core.byteSize(JSON.stringify({text:'译'.repeat(50000)}))>120000);
});
test('site origins accept HTTP websites but reject path and credentials',()=>{
 assert.equal(core.siteOrigin('http://news.test'),'http://news.test');
 for(const value of ['https://a.test/path','https://u:p@a.test','https://a.test/?x','file:///'])assert.throws(()=>core.siteOrigin(value));
});
test('endpoint accepts HTTPS and loopback only, strips trailing slash',()=>{
 assert.equal(typeof core.endpoint,'function');
 assert.equal(core.endpoint('https://api.example.com/v1/'),'https://api.example.com/v1');
 assert.equal(core.endpoint('http://127.0.0.1:1234/v1'),'http://127.0.0.1:1234/v1');
 for(const x of ['http://evil.test','javascript:alert(1)','https://u:secret@a.test','https://a.test/?key=x','https://a.test/#x','https://a.test/?','https://a.test/#']) assert.throws(()=>core.endpoint(x));
});

test('long text segments reach beyond the prefix without claiming full coverage',()=>{
 const {document}=parseHTML('<html><body><p>'+ 'a'.repeat(16000)+'TAIL</p><input type="password" value="secret"><script>private-script</script><p hidden>private-hidden</p></body></html>');
 const first=core.agentSnapshot(document).page;
 assert.equal(first.text.length,16000);assert.equal(first.textRange.nextOffset,16000);
 const last=core.agentSnapshot(document,16000).page;
 assert.equal(last.text,'TAIL');assert.equal(last.textRange.nextOffset,null);
 assert.equal(last.coverage.textComplete,false);assert.equal(last.truncated,true);
 assert.equal(core.agentSnapshot(document,999999).page.text,'');
 document.querySelector('p').textContent='changed';
 assert.equal(core.agentSnapshot(document,0).page.text,'changed');
 for(const value of [-1,1.5,'0',Number.MAX_SAFE_INTEGER+1]){
  assert.throws(()=>core.agentSnapshot(document,value));
  assert.throws(()=>core.agentPlan(JSON.stringify({reply:'read',action:'observe',value}),{nodes:new Map()}));
 }
});
