const {test}=require('node:test');const assert=require('node:assert/strict');const {parseHTML}=require('linkedom');
const C=require('../extension/core.js'),G=require('../extension/conditions.js');
// linkedom has no browsing contexts: attach a parsed document as the iframe's contentDocument.
function page(top,frames){
 const {document}=parseHTML(`<html><body>${top}</body></html>`);
 const iframes=[...document.querySelectorAll('iframe')];
 frames.forEach((html,i)=>{const f=iframes[i];if(html===undefined)return;
  const box=html===null||html.box?{width:100,height:80,left:0,top:0,right:100,bottom:80,x:0,y:0}:null;if(box)f.getBoundingClientRect=()=>box;
  const doc=html===null?null:parseHTML(`<html><body>${html.body??html}</body></html>`).document;Object.defineProperty(f,'contentDocument',{configurable:true,get:()=>doc});});
 return {document,iframes};
}
test('same-origin frames are read one level deep with frame ids; cross-origin, nested and hidden frames are not',()=>{
 const {document}=page('<p>Top text</p><button>Save</button><iframe title="Pay"></iframe><iframe title="Ad"></iframe><iframe></iframe><div hidden><iframe title="Hidden"></iframe></div>',
  ['<p>Frame text</p> <input aria-label="Name"><input type="password" aria-label="Pw" value="FRAME_SECRET"><section aria-label="Result">Waiting</section><iframe title="Inner" style="width:9px"></iframe>',null,undefined,'<button>Hidden frame</button>']);
 const inner=document.querySelector('iframe').contentDocument.querySelector('iframe');inner.getBoundingClientRect=()=>({width:50,height:50,left:0,top:0,right:50,bottom:50});
 const snap=C.agentSnapshot(document),p=snap.page;
 assert.deepEqual(p.frames.map(f=>[f.id,f.label,f.read,f.reason]),[['f0','Pay',true,undefined],['f1','Ad',false,'cross_origin'],['f2','Inner',false,'nested']]);
 assert.equal(p.coverage.framesComplete,false);assert.equal(p.coverage.sensitiveExcluded,true);
 assert.deepEqual(p.elements.map(e=>[e.label,e.frame]),[['Save',undefined],['Name','f0']]);
 assert.equal(p.regions.find(r=>r.label==='Result').frame,'f0');
 assert.equal(p.text,'Top text Save [f0 Pay] Frame text Waiting');
 assert.ok(!JSON.stringify(p).includes('FRAME_SECRET')&&!JSON.stringify(p).includes('Hidden frame'));
 assert.equal(new Set([...p.elements,...p.regions].map(e=>e.key)).size,p.elements.length+p.regions.length);
 // An unreadable zero-size frame is ignored; a page with only readable frames is complete.
 const clean=page('<iframe title="Pay"></iframe><iframe></iframe>',['<button>Go</button>']);
 clean.iframes[1].getBoundingClientRect=()=>({width:0,height:0});
 assert.equal(C.agentSnapshot(clean.document).page.coverage.framesComplete,true);
 assert.equal(C.agentSnapshot(parseHTML('<html><body><p>x</p></body></html>').document).page.frames,undefined);
});
test('frame targets execute in the frame document and go stale when the iframe is removed or reloaded',()=>{
 const {document,iframes}=page('<iframe title="Pay"></iframe>',['<input type="text" aria-label="Name"><input type="checkbox" aria-label="Agree">']);
 const fd=iframes[0].contentDocument,events=[];fd.addEventListener('input',()=>events.push('input'));
 let snap=C.agentSnapshot(document);
 C.agentExecute({action:'fill',id:'t0',value:'Ada'},snap,document);
 assert.equal(fd.querySelector('input').value,'Ada');assert.deepEqual(events,['input']);assert.equal(C.agentVerify({action:'fill',id:'t0',value:'Ada'},snap).verified,true);
 snap=C.agentSnapshot(document);
 Object.defineProperty(iframes[0],'contentDocument',{configurable:true,get:()=>parseHTML('<html><body></body></html>').document});
 assert.throws(()=>C.agentExecute({action:'check',id:'t1',value:true},snap,document),e=>e.code==='STALE');
 assert.ok(!fd.querySelectorAll('input')[1].checked);assert.equal(C.agentVerify({action:'fill',id:'t0',value:'Ada'},snap).verified,false);
 const other=page('<iframe title="Pay"></iframe>',['<input type="checkbox" aria-label="Agree">']),s2=C.agentSnapshot(other.document);
 other.iframes[0].remove();
 assert.throws(()=>C.agentExecute({action:'check',id:'t0',value:true},s2,other.document),e=>e.code==='STALE');
});
test('bound conditions keep frame identity so a same-named control in another document is not matched',()=>{
 const {document}=page('<button aria-pressed="false">Save</button><iframe title="Pay"></iframe>',['<button aria-pressed="false">Save</button>']);
 const snap={...C.agentSnapshot(document),documentId:'d1',url:'https://a.test/'},[top,inner]=snap.page.elements;
 assert.equal(inner.frame,'f0');
 const bound=G.bind([{kind:'element_visible',id:top.id},{kind:'element_visible',id:inner.id}],snap);
 assert.equal(bound[0].target.frame,'');assert.equal(bound[1].target.frame,snap.page.frames[0].key);
 assert.equal(G.evaluate(bound,snap).status,'success');
 assert.equal(G.evaluate([{kind:'element_visible',target:{category:'element',label:'Save'}}],snap).evidence[0].code,'AMBIGUOUS_TARGET');
});
