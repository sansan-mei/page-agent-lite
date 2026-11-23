'use strict';
// Local deterministic DOM/visual regression; no model or external website.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PAGE_AGENT_CHROMIUM});
 try{
  const page=await browser.newPage({viewport:{width:800,height:500}});
  await page.setContent('<style>body{padding:60px;font:16px sans-serif}button{padding:15px;margin:20px}#menu{display:none}</style><button id="first">Open menu</button><button id="second">Save</button><p id="menu">Menu revealed</p>');
  for(const file of ['core.js','page-pointer.js'])await page.addScriptTag({path:path.join(__dirname,'../extension',file)});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const result=await page.evaluate(()=>{
   let clicks=0;const button=document.getElementById('first');
   button.addEventListener('mouseenter',()=>document.getElementById('menu').style.display='block');
   button.addEventListener('click',()=>clicks++);
   const before=PageAgentCore.agentSnapshot(document);
   const id=before.page.elements.find(e=>e.label==='Open menu').id;
   PageAgentCore.agentExecute({action:'hover',id},before,document);
   const host=document.querySelector('[data-page-agent="pointer"]');
   const hover={clicks,visible:getComputedStyle(document.getElementById('menu')).display,overlay:!!host,hit:document.elementFromPoint(120,110)?.closest('[data-page-agent]')===null};
   const after=PageAgentCore.agentSnapshot(document);
   const stable=JSON.stringify(after.page)===JSON.stringify((PageAgentPointer.clear(),PageAgentCore.agentSnapshot(document).page));
   PageAgentCore.agentExecute({action:'click',id},after,document);
   return {hover,stable,clicks};
  });
  assert.deepEqual(result,{hover:{clicks:0,visible:'block',overlay:true,hit:true},stable:true,clicks:1});
  await page.evaluate(()=>PageAgentPointer.show(document.getElementById('second'),document));
  await page.screenshot({path:path.join(__dirname,'../tests/browser-output/page-pointer.png')});
  await page.evaluate(()=>PageAgentPointer.clear());
  assert.equal(await page.locator('[data-page-agent="pointer"]').count(),0);
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.evaluate(()=>{PageAgentPointer.show(document.getElementById('first'),document);PageAgentPointer.show(document.getElementById('second'),document);PageAgentPointer.click();});
  assert.equal(await page.evaluate(()=>document.getAnimations().length),0);
  await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));
  assert.equal(await page.locator('[data-page-agent="pointer"]').count(),0);
  console.log('Pointer browser checks passed: hover, single click, snapshot isolation, hit testing, cleanup, reduced motion.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
