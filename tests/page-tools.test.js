const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const {parseHTML}=require('linkedom');
const C=require('../extension/core.js');
test('page exposes tools without chat UI, uses one-shot snapshots and rejects stale documents',async()=>{
 const {window,document}=parseHTML('<html><body><p>Question</p><input type="text"></body></html>');
 let listener;const chrome={runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,onMessage:{addListener(fn){listener=fn;}},async sendMessage(){return {ok:true};}}};
 let cleared=0;const PageAgentPointer={clear(){cleared++;}};
 let time=0;const clock={now:()=>time+=700};
 vm.runInNewContext(fs.readFileSync('extension/content.js','utf8'),{PageAgentPointer,PageAgentCore:C,PageAgentConditions:require('../extension/conditions.js'),PageAgentProtocol:require('../extension/tool-protocol.js'),chrome,document,location:{href:'https://example.test/'},crypto,Date:clock,setTimeout:fn=>setImmediate(fn)});
 const sender={id:'test',url:'chrome-extension://test/background.js'};
 const send=(m)=>new Promise(r=>listener(m,sender,r));
 assert.equal(document.querySelector('[data-page-agent]'),null);
 assert.equal(listener({type:'agent:clear-pointer'},{...sender,url:'https://example.test',tab:{id:1}},()=>{}),undefined);
 assert.equal(cleared,0);await send({type:'agent:clear-pointer'});assert.equal(cleared,1);
 assert.equal(listener({type:'agent:observe'},{...sender,url:'https://example.test',tab:{id:1}},()=>{}),undefined);
 const snap=(await send({type:'agent:observe'})).value;
 const command={type:'agent:execute',snapshotId:snap.snapshotId,url:snap.url,plan:{reply:'填写',action:'fill',id:'t0',value:'4'}};
 const filled=await send(command);assert.equal(filled.ok,true);assert.equal(filled.value.verification.verified,true);assert.equal(document.querySelector('input').value,'4');
 assert.equal((await send(command)).code,'STALE');
 document.querySelector('input').addEventListener('change',()=>{document.querySelector('input').value='rejected';});
 const next=(await send({type:'agent:observe'})).value;
 const rejected=await send({...command,snapshotId:next.snapshotId,plan:{reply:'填写',action:'fill',id:'t0',value:'5'}});
 assert.equal(rejected.value.verification.verified,false);assert.equal(rejected.value.verification.actual,'rejected');
});

test('checks locate late named regions read-only without reusing old region IDs or guessing absence',async()=>{
 const {document}=parseHTML('<html><body>'+Array.from({length:45},(_,i)=>`<section aria-label="Result ${i}">Waiting</section>`).join('')+'</body></html>');
 let listener;const chrome={runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,onMessage:{addListener(fn){listener=fn;}},sendMessage:async()=>({ok:true})}};
 vm.runInNewContext(fs.readFileSync('extension/content.js','utf8'),{PageAgentCore:C,PageAgentConditions:require('../extension/conditions.js'),PageAgentProtocol:require('../extension/tool-protocol.js'),chrome,document,location:{href:'https://example.test/'},crypto,Date,setTimeout});
 const send=m=>new Promise(r=>listener(m,{id:'test',url:'chrome-extension://test/background.js'},r));
 const snap=(await send({type:'agent:observe',textOffset:{regionQuery:'Result 44'}})).value;
 const check=require('../extension/conditions.js').bind([{kind:'text_present',id:snap.page.regions[0].id,value:'Saved'}],snap);
 document.querySelectorAll('section')[44].textContent='Saved';
 assert.equal((await send({type:'agent:verify',expected:check})).value.status,'success');
 document.body.insertAdjacentHTML('beforeend','<section aria-label="Result 44">Saved</section>');
 assert.equal((await send({type:'agent:verify',expected:check})).value.status,'unknown');
 for(const n of document.querySelectorAll('section[aria-label="Result 44"]'))n.remove();
 const absent=[{kind:'element_absent',target:{category:'region',label:'Result 44'}}];
 assert.equal((await send({type:'agent:verify',expected:absent})).value.status,'unknown');
 document.body.innerHTML='<section aria-label="Other">Complete scope</section>';
 assert.equal((await send({type:'agent:verify',expected:absent})).value.status,'success');
});

test('navigation preparation consumes the current content snapshot without changing the page',async()=>{
 const {document}=parseHTML('<html><body><p>Source</p></body></html>');let listener;
 const chrome={runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,onMessage:{addListener(fn){listener=fn;}},sendMessage:async()=>({ok:true})}};
 vm.runInNewContext(fs.readFileSync('extension/content.js','utf8'),{PageAgentCore:C,PageAgentConditions:require('../extension/conditions.js'),PageAgentProtocol:require('../extension/tool-protocol.js'),chrome,document,location:{href:'https://example.test/'},crypto,Date,setTimeout});
 const send=m=>new Promise(r=>listener(m,{id:'test',url:'chrome-extension://test/background.js'},r));
 const snap=(await send({type:'agent:observe'})).value,command={type:'agent:prepare-navigation',snapshotId:snap.snapshotId,documentId:snap.documentId,url:snap.url,plan:{reply:'Navigate',action:'navigate',value:'https://example.test/next'}};
 assert.equal((await send(command)).value.prepared,true);assert.equal((await send(command)).code,'STALE');assert.equal(document.body.textContent,'Source');
});
