'use strict';
// Native DOM + messaging stub. Controlled-value fixtures emulate tracking, not React.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PAGE_AGENT_CHROMIUM});
 try{
  const page=await browser.newPage();
  await page.route('https://fixture.test/**',route=>route.fulfill({contentType:'text/html',body:'<input id="controlled" aria-label="Controlled" value="old"><textarea id="area" aria-label="Area">old</textarea><input id="cancel" aria-label="Cancel" value="old"><input id="rollback" aria-label="Rollback" value="old"><input id="replace" aria-label="Replace" value="old"><input id="replaceInput" aria-label="ReplaceInput" value="old"><input type="number" id="number" aria-label="Number" value="7"><input type="date" id="date" aria-label="Date" value="2026-11-23">'}));
  await page.goto('https://fixture.test/');
  await page.evaluate(()=>{
   globalThis.chrome={runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,onMessage:{addListener(fn){globalThis.formListener=fn;}},sendMessage:async()=>({ok:true})}};
   globalThis.accepted={};globalThis.events=[];
   for(const id of ['controlled','area']){
    const n=document.getElementById(id),proto=id==='area'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,descriptor=Object.getOwnPropertyDescriptor(proto,'value');let tracked=n.value;
    Object.defineProperty(n,'value',{configurable:true,get(){return descriptor.get.call(this);},set(value){tracked=value;descriptor.set.call(this,value);}});
    n.addEventListener('input',e=>{if(n.value!==tracked){accepted[id]=n.value;tracked=n.value;}events.push({id,type:e.type,data:e.data,inputType:e.inputType,composed:e.composed,isComposing:e.isComposing,focused:document.activeElement===n});});
   }
   const cancelled=document.getElementById('cancel');cancelled.addEventListener('beforeinput',e=>e.preventDefault());cancelled.addEventListener('input',()=>events.push({id:'cancel'}));
   document.getElementById('rollback').addEventListener('input',e=>setTimeout(()=>e.target.value='old',0));
   for(const [id,type] of [['replace','focus'],['replaceInput','input']]){
    const n=document.getElementById(id);n.addEventListener(type,()=>{const next=n.cloneNode();next.value='replacement';n.replaceWith(next);});n.addEventListener('change',()=>events.push({id}));
   }
  });
  for(const file of ['tool-protocol.js','conditions.js','core.js','content.js'])await page.addScriptTag({path:path.join(__dirname,'../extension',file)});
  const results=await page.evaluate(async()=>{
   const send=message=>new Promise(resolve=>formListener(message,{id:'test',url:'chrome-extension://test/background.js'},resolve));
   const fill=async(label,value)=>{const snap=(await send({type:'agent:observe'})).value;return send({type:'agent:execute',url:snap.url,documentId:snap.documentId,snapshotId:snap.snapshotId,plan:{reply:'Fill',action:'fill',id:snap.page.elements.find(e=>e.label===label).id,value}});};
   const input=await fill('Controlled','accepted'),area=await fill('Area','line one\nline two'),cancel=await fill('Cancel','rejected'),rollback=await fill('Rollback','new'),replace=await fill('Replace','new'),replaceInput=await fill('ReplaceInput','new'),invalidDate=await fill('Date','23/11/2026');
   const keptDate=document.getElementById('date').value;
   const date=await fill('Date','2026-12-01');
   const invalidNumber=await fill('Number','not a number'),keptNumber=document.getElementById('number').value,number=await fill('Number','42.5');
   return {input,area,cancel,rollback,replace,replaceInput,invalidDate,keptDate,date,invalidNumber,keptNumber,number,accepted,events,cancelValue:document.getElementById('cancel').value};
  });
  assert.equal(results.input.value.status,'success');assert.equal(results.area.value.status,'success');assert.deepEqual(results.accepted,{controlled:'accepted',area:'line one\nline two'});
  for(const event of results.events){assert.equal(event.type,'input');assert.equal(event.inputType,'insertReplacementText');assert.equal(event.composed,true);assert.equal(event.focused,true);assert.equal(event.isComposing,false);assert.equal(event.data,results.accepted[event.id]);}
  assert.equal(results.events.length,2);assert.equal(results.cancel.code,'INPUT_CANCELLED');assert.equal(results.cancel.result.dispatch,'unknown');assert.equal(results.cancelValue,'old');assert.equal(results.rollback.value.status,'not_satisfied');
  assert.equal(results.replace.code,'TARGET_CHANGED');assert.equal(results.replaceInput.code,'TARGET_CHANGED');assert.equal(results.invalidDate.code,'INVALID_FIELD_VALUE');assert.equal(results.invalidDate.result.dispatch,'not_sent');assert.equal(results.keptDate,'2026-11-23');assert.equal(results.date.value.status,'success');
  assert.equal(results.invalidNumber.code,'INVALID_FIELD_VALUE');assert.equal(results.keptNumber,'7');assert.equal(results.number.value.status,'success');
  const sensitive=await page.evaluate(async()=>{
   const send=message=>new Promise(resolve=>formListener(message,{id:'test',url:'chrome-extension://test/background.js'},resolve));
   const input=document.createElement('input');input.type='password';input.setAttribute('aria-label','Sensitive password');input.value='old';document.body.append(input);
   const before=(await send({type:'agent:observe'})).value;
   const snap=(await send({type:'agent:observe',sensitiveFields:true})).value;
   const id=snap.page.elements.find(e=>e.label==='Sensitive password').id;
   const operation={type:'agent:execute',url:snap.url,documentId:snap.documentId,snapshotId:snap.snapshotId,plan:{reply:'Fill',action:'fill',id,value:'example-only'}};
   const denied=await send(operation);
   const filled=await send({...operation,sensitiveFields:true});
   const after=(await send({type:'agent:observe'})).value;
   return {before:before.page.elements.some(e=>e.label==='Sensitive password'),denied,filled,value:input.value,after:after.page.elements.some(e=>e.label==='Sensitive password')};
  });
  assert.equal(sensitive.before,false);assert.equal(sensitive.denied.code,'STALE');assert.equal(sensitive.denied.result.dispatch,'not_sent');assert.equal(sensitive.filled.value.status,'success');assert.equal(sensitive.value,'example-only');assert.equal(sensitive.after,false);
  console.log('Form browser checks passed: native setters, controlled input/textarea, InputEvent payload, focus, cancellation, asynchronous rollback, replacement boundaries, valid/invalid dates.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
