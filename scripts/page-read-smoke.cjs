'use strict';
// Real DOM in Chromium with a Chrome messaging stub; no model or loaded extension.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PAGE_AGENT_CHROMIUM});
 try{
  const page=await browser.newPage({viewport:{width:800,height:500}});
  const html=('<main>'+Array.from({length:245},(_,i)=>`<button style="display:block;height:30px" onclick="window.lastClicked=${i}">Entry ${i}</button>`).join('')+'<input type="password" aria-label="Private"><p>'+'a'.repeat(16000)+'TAIL</p></main>');
  await page.route('https://fixture.test/**',route=>route.fulfill({contentType:'text/html',body:html}));
  await page.goto('https://fixture.test/');
  await page.evaluate(()=>{globalThis.chrome={runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,onMessage:{addListener(fn){globalThis.readListener=fn;}},sendMessage:async()=>({ok:true})}};});
  for(const file of ['tool-protocol.js','conditions.js','core.js','content.js'])await page.addScriptTag({path:path.join(__dirname,'../extension',file)});
  const result=await page.evaluate(async()=>{
   const sender={id:'test',url:'chrome-extension://test/background.js'};
   const send=message=>new Promise(resolve=>readListener(message,sender,resolve));
   const first=await send({type:'agent:observe'});
   const paged=await send({type:'agent:observe',textOffset:{elementOffset:240}});
   const found=await send({type:'agent:observe',textOffset:{query:'Entry 244'}});
   const command={type:'agent:execute',url:found.value.url,documentId:found.value.documentId,snapshotId:found.value.snapshotId,plan:{reply:'Click late entry',action:'click',id:found.value.page.elements[0].id}};
   const old=await send({...command,snapshotId:paged.value.snapshotId});
   const clicked=await send(command);
   const replay=await send(command);
   const secret=await send({type:'agent:observe',textOffset:{query:'Private'}});
   const invalid=await send({type:'agent:observe',textOffset:{selector:'button'}});
   return {first:first.value.page.elementRange.nextOffset,last:paged.value.page.elements.map(e=>e.label),found:found.value.page.elements.length,old:old.code,clicked:clicked.value.dispatch,lastClicked:window.lastClicked,replay:replay.code,secret:secret.value.page.elements.length,invalid:invalid.ok};
  });
  assert.equal(result.first,120);assert.deepEqual(result.last,['Entry 240','Entry 241','Entry 242','Entry 243','Entry 244']);assert.equal(result.found,1);assert.equal(result.old,'STALE');assert.equal(result.clicked,'sent');assert.equal(result.lastClicked,244);assert.equal(result.replay,'STALE');assert.equal(result.secret,0);assert.equal(result.invalid,false);
  console.log('Page reading browser checks passed: paging, literal lookup, offscreen click, old snapshot and replay rejection, private field exclusion, invalid scope rejection.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
