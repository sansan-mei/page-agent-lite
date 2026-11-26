const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {parseHTML}=require('linkedom');
const core=fs.existsSync(require('node:path').join(__dirname,'../extension/core.js'))?require('../extension/core.js'):{};
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
