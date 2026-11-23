'use strict';
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PAGE_AGENT_CHROMIUM});
 try{
  const page=await browser.newPage();
  await page.route('https://fixture.test/**',route=>route.fulfill({contentType:'text/html',body:'<div contenteditable="true" aria-label="Editor">old<br>line</div><div contenteditable="plaintext-only" aria-label="Cancel">original</div><div contenteditable="true" aria-label="Complex"><span id="preserve">formatted</span></div><div contenteditable="true" aria-label="Rollback">old</div><div contenteditable="true" aria-label="Replace">old</div>'}));
  await page.goto('https://fixture.test/');
  await page.evaluate(()=>{
   globalThis.chrome={runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,onMessage:{addListener(fn){globalThis.editorListener=fn;}},sendMessage:async()=>({ok:true})}};
   document.querySelector('[aria-label="Cancel"]').addEventListener('beforeinput',e=>e.preventDefault());
   document.querySelector('[aria-label="Rollback"]').addEventListener('input',e=>setTimeout(()=>e.target.textContent='old',0));
   document.querySelector('[aria-label="Replace"]').addEventListener('beforeinput',e=>e.target.replaceWith(e.target.cloneNode(true)));
   globalThis.original=document.getElementById('preserve');globalThis.changes=0;original.parentElement.addEventListener('input',()=>changes++);
  });
  for(const file of ['tool-protocol.js','conditions.js','core.js','content.js'])await page.addScriptTag({path:path.join(__dirname,'../extension',file)});
  const r=await page.evaluate(async()=>{
   const send=m=>new Promise(resolve=>editorListener(m,{id:'test',url:'chrome-extension://test/background.js'},resolve));
   const fill=async(label,value)=>{const snap=(await send({type:'agent:observe'})).value;return send({type:'agent:execute',url:snap.url,documentId:snap.documentId,snapshotId:snap.snapshotId,plan:{reply:'Write text',action:'fill',id:snap.page.elements.find(e=>e.label===label).id,value}});};
   const text='<img src=x onerror=alert(1)>\nsecond line',written=await fill('Editor',text),cancel=await fill('Cancel','new'),complex=await fill('Complex','new'),rollback=await fill('Rollback','new'),replace=await fill('Replace','new');
   return {written,cancel,complex,rollback,replace,text:document.querySelector('[aria-label="Editor"]').textContent,images:document.querySelectorAll('img').length,kept:original.isConnected,changes,cancelText:document.querySelector('[aria-label="Cancel"]').textContent};
  });
  assert.equal(r.written.value.status,'success');assert.equal(r.text,'<img src=x onerror=alert(1)>\nsecond line');assert.equal(r.images,0);assert.equal(r.cancel.code,'INPUT_CANCELLED');assert.equal(r.cancelText,'original');assert.equal(r.complex.code,'UNSUPPORTED_EDITABLE');assert.equal(r.complex.result.status,'unsupported');assert.equal(r.complex.result.dispatch,'not_sent');assert.equal(r.kept,true);assert.equal(r.changes,0);assert.equal(r.rollback.value.status,'not_satisfied');assert.equal(r.replace.code,'TARGET_CHANGED');
  console.log('Editable browser checks passed: plain text/newlines, HTML stays literal, cancellation, complex nodes preserved, asynchronous rollback, replacement boundary.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
