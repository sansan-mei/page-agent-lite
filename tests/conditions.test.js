const {test}=require('node:test');const assert=require('node:assert/strict');const {parseHTML}=require('linkedom');
const C=require('../extension/core.js'),G=require('../extension/conditions.js');
const capture=(document,documentId='d1',url='https://example.test/form')=>({...C.agentSnapshot(document),documentId,url});

test('field verification relocates uniquely after DOM replacement without writing again',()=>{
 const {document}=parseHTML('<html><body><label>Name<input name="name" type="text" value="old"></label></body></html>');
 const before=capture(document),conditions=G.bind([{kind:'field_equals',id:'t0',value:'Alice'}],before);
 document.querySelector('input').outerHTML='<input name="name" type="text" value="Alice">';
 assert.equal(G.evaluate(conditions,capture(document)).status,'success');
 document.body.insertAdjacentHTML('beforeend','<label>Name<input name="name" type="text" value="Alice"></label>');
 const result=G.evaluate(conditions,capture(document));assert.equal(result.status,'unknown');assert.equal(result.evidence[0].code,'AMBIGUOUS_TARGET');
});

test('save message must match requested region, unrelated success text does not satisfy it',()=>{
 const {document}=parseHTML('<html><body><section aria-label="Save result"><p>Waiting</p></section><section aria-label="Advertisement">Saved successfully</section></body></html>');
 const before=capture(document),region=before.page.regions.find(r=>r.label==='Save result');
 const conditions=G.bind([{kind:'text_present',id:region.id,value:'Saved successfully'}],before);
 assert.equal(G.evaluate(conditions,before).status,'not_satisfied');
 document.querySelector('p').textContent='Saved successfully';
 assert.equal(G.evaluate(conditions,capture(document)).status,'success');
});

test('missing targets in truncated or hidden scopes are unknown, never proof of absence',()=>{
 const target={category:'element',role:'button',label:'Save'};
 const snapshot={documentId:'d1',url:'https://example.test',page:{elements:[],regions:[],coverage:{elementsComplete:false}}};
 assert.equal(G.evaluate([{kind:'element_absent',target}],snapshot).status,'unknown');
 snapshot.page.coverage.elementsComplete=true;snapshot.page.coverage.absenceComplete=false;
 assert.equal(G.evaluate([{kind:'element_absent',target}],snapshot).status,'unknown');
 snapshot.page.coverage.absenceComplete=true;
 assert.equal(G.evaluate([{kind:'element_absent',target}],snapshot).status,'success');
 assert.equal(G.evaluate([{kind:'element_absent',target,documentId:'old'}],snapshot).status,'unknown');
});

test('text truncation and unnamed node identity cannot turn missing evidence into success',()=>{
 const {document}=parseHTML('<html><body><section aria-label="Result">'+('a'.repeat(1100))+' END</section><input type="text" value="A"></body></html>');
 const before=capture(document),region=before.page.regions[0];
 assert.equal(G.evaluate(G.bind([{kind:'text_present',id:region.id,value:'END'}],before),before).status,'unknown');
 const conditions=G.bind([{kind:'field_equals',id:'t0',value:'A'}],before);
 assert.equal(G.evaluate(conditions,before).status,'success');
 document.querySelector('input').outerHTML='<input type="text" value="A">';
 assert.equal(G.evaluate(conditions,capture(document)).status,'unknown');
});

test('same-origin URLs compare exactly and invalid expressions or selectors are rejected',()=>{
 const snapshot={url:'https://example.test/1',documentId:'d1',page:{elements:[]}};
 const c=G.bind([{kind:'url_changed'}],snapshot);
 assert.equal(G.evaluate(c,{...snapshot,url:'https://example.test/2'}).status,'success');
 assert.throws(()=>G.bind([{kind:'url_equals',value:'https://other.test/'}],snapshot),/站点/);
 for(const x of [[],Array(6).fill({kind:'url_changed'}),[{kind:'eval',value:'alert(1)'}],[{kind:'element_visible',target:{category:'element',label:'Save',selector:'button'}}]])assert.throws(()=>G.validate(x));
});

test('ARIA groups and disabled fields are observable for verification',()=>{
 const {document}=parseHTML('<html><body><fieldset><legend>Account</legend><label>Email<input name="email" type="email" value="a@example.test" disabled></label></fieldset><section role="status" aria-label="Save status">Saved</section></body></html>');
 const snap=capture(document);assert.equal(snap.page.elements[0].disabled,true);assert.equal(snap.page.groups[0].label,'Account');
 assert.equal(G.evaluate(G.bind([{kind:'field_equals',id:'t0',value:'a@example.test'}],snap),snap).status,'success');
});


test('dialog controls survive page limits and same-label confirmation is scoped uniquely',()=>{
 const {document}=parseHTML('<html><body>'+Array.from({length:130},()=>'<button>Submit</button>').join('')+'<div role="dialog" aria-labelledby="confirm-title"><h2 id="confirm-title">Confirm changes</h2><form><button>Submit</button></form></div></body></html>');
 const snap=capture(document),first=snap.page.elements[0];
 assert.equal(first.label,'Submit');assert.equal(snap.page.groups.find(g=>g.id===first.group).label,'Confirm changes');
 assert.equal(snap.page.regions[0].role,'dialog');assert.equal(snap.page.coverage.elementsComplete,false);
 const c=G.bind([{kind:'element_visible',id:first.id}],snap);
 const out=G.evaluate(c,snap);assert.equal(out.status,'success');assert.equal(out.evidence[0].expected,true);
});


test('background Submit cannot be mistaken for new dialog Submit after original removal',()=>{
 const {document}=parseHTML('<html><body><button id="open">Submit</button><div role="dialog" aria-label="Confirm changes" hidden><button>Submit</button></div></body></html>');
 const before=capture(document),bound=G.bind([{kind:'element_visible',id:'t0'}],before);
 document.getElementById('open').remove();document.querySelector('[role="dialog"]').removeAttribute('hidden');
 assert.equal(G.evaluate(bound,capture(document)).status,'unknown');
});

test('selection and expansion checks use unique popup groups and preserve missing ARIA as unknown',()=>{
 const {document}=parseHTML('<html><body><div role="combobox" aria-label="From" aria-controls="from" aria-expanded="false"></div><div role="combobox" aria-label="To" aria-controls="to"></div><div role="listbox" id="from"><div role="option" aria-selected="false">Paris</div></div><div role="listbox" id="to"><div role="option" aria-selected="true">Paris</div></div></body></html>');
 const before=capture(document),option=before.page.elements.find(e=>e.role==='option'&&!e.selected),combo=before.page.elements.find(e=>e.label==='From');
 const checks=G.bind([{kind:'selected_equals',id:option.id,value:true},{kind:'expanded_equals',id:combo.id,value:true}],before);
 assert.equal(G.evaluate(checks,before).status,'not_satisfied');
 document.querySelector('#from [role="option"]').setAttribute('aria-selected','true');document.querySelector('[aria-controls="from"]').setAttribute('aria-expanded','true');
 assert.equal(G.evaluate(checks,capture(document)).status,'success');
 document.querySelector('#from [role="option"]').setAttribute('aria-selected','mixed');
 assert.equal(G.evaluate(checks,capture(document)).status,'unknown');
 document.querySelector('#from').setAttribute('hidden','');assert.equal(G.evaluate(checks,capture(document)).status,'unknown');
 assert.throws(()=>G.validate([{kind:'expanded_equals',id:combo.id,value:'false'}]));
 assert.throws(()=>G.validate([{kind:'selected_equals',id:option.id,value:0}]));
});
