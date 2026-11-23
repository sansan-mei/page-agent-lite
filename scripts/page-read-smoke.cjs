'use strict';
// Real DOM in Chromium with a Chrome messaging stub; no model or loaded extension.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PAGE_AGENT_CHROMIUM});
 try{
  const page=await browser.newPage({viewport:{width:800,height:500}});
  const html=('<main>'+Array.from({length:245},(_,i)=>`<button style="display:block;height:30px" onclick="window.lastClicked=${i}">Entry ${i}</button>`).join('')+'<input type="password" aria-label="Private"><p>'+'a'.repeat(16000)+'TAIL</p>'+Array.from({length:65},(_,i)=>`<section aria-label="Result ${i}">${'x'.repeat(1000)}</section>`).join('')+'</main>');
  await page.route('https://fixture.test/**',route=>route.fulfill({contentType:'text/html',body:html}));
  await page.goto('https://fixture.test/');
  await page.evaluate(()=>{globalThis.chrome={runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,onMessage:{addListener(fn){globalThis.readListener=fn;}},sendMessage:async()=>({ok:true})}};});
  for(const file of ['tool-protocol.js','conditions.js','core.js','content.js'])await page.addScriptTag({path:path.join(__dirname,'../extension',file)});
  const result=await page.evaluate(async()=>{
   const sender={id:'test',url:'chrome-extension://test/background.js'};
   const send=message=>new Promise(resolve=>readListener(message,sender,resolve));
   const first=await send({type:'agent:observe'});
   const controlsOnly=await send({type:'agent:observe',textOffset:{includeText:false,query:'Entry 244'}});
   if(controlsOnly.value.page.text!==''||controlsOnly.value.page.textRange.omitted!==true||controlsOnly.value.page.coverage.textComplete!==false||controlsOnly.value.page.elements[0].label!=='Entry 244')throw Error('Controls-only observation contract failed');
   const paged=await send({type:'agent:observe',textOffset:{elementOffset:240}});
   const found=await send({type:'agent:observe',textOffset:{query:'Entry 244'}});
   const command={type:'agent:execute',url:found.value.url,documentId:found.value.documentId,snapshotId:found.value.snapshotId,plan:{reply:'Click late entry',action:'click',id:found.value.page.elements[0].id}};
   const old=await send({...command,snapshotId:paged.value.snapshotId});
   const clicked=await send(command);
   const replay=await send(command);
   const secret=await send({type:'agent:observe',textOffset:{query:'Private'}});
   const invalid=await send({type:'agent:observe',textOffset:{selector:'button'}});
   const firstRegions=(await send({type:'agent:observe'})).value.page.regionRange;
   const regionPage=(await send({type:'agent:observe',textOffset:{regionOffset:65}})).value;
   const region=(await send({type:'agent:observe',textOffset:{regionQuery:'Result 64'}})).value;
   const checks=PageAgentConditions.bind([{kind:'text_present',id:region.page.regions[0].id,value:'Saved'}],region);
   document.querySelector('section[aria-label="Result 64"]').textContent='Saved';
   const verified=await send({type:'agent:verify',expected:checks});
   document.querySelector('main').insertAdjacentHTML('beforeend','<section aria-label="Result 64">Saved</section>');
   const ambiguous=await send({type:'agent:verify',expected:checks});
   return {regionFirst:firstRegions,regionLast:regionPage.page.regions[0].label,regionStatus:verified.value.status,ambiguous:ambiguous.value.status,first:first.value.page.elementRange.nextOffset,last:paged.value.page.elements.map(e=>e.label),found:found.value.page.elements.length,old:old.code,clicked:clicked.value.dispatch,lastClicked:window.lastClicked,replay:replay.code,secret:secret.value.page.elements.length,invalid:invalid.ok};
  });
  assert.equal(result.first,120);assert.deepEqual(result.last,['Entry 240','Entry 241','Entry 242','Entry 243','Entry 244']);assert.equal(result.found,1);assert.equal(result.old,'STALE');assert.equal(result.clicked,'sent');assert.equal(result.lastClicked,244);assert.equal(result.replay,'STALE');assert.equal(result.secret,0);assert.equal(result.invalid,false);
  assert.equal(result.regionFirst.total,66);assert.equal(result.regionFirst.nextOffset,5);assert.equal(result.regionLast,'Result 64');assert.equal(result.regionStatus,'success');assert.equal(result.ambiguous,'unknown');
  console.log('Page reading browser checks passed: control/region paging, late-region verification and ambiguity, literal lookup, offscreen click, old snapshot and replay rejection, private field exclusion, invalid scope rejection.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
