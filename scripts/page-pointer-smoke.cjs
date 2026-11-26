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
  // Test-only handle to the closed shadow root for rendered-position assertions.
  await page.evaluate(()=>{const attach=Element.prototype.attachShadow;Element.prototype.attachShadow=function(options){const shadow=attach.call(this,options);if(this.getAttribute('data-page-agent')==='pointer')globalThis.pointerShadow=shadow;return shadow;};});
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
  const motion=await page.evaluate(async()=>{
   PageAgentPointer.clear();PageAgentPointer.start(document);
   const first=document.getElementById('first'),second=document.getElementById('second');
   PageAgentPointer.show(first,document);
   const arrow=pointerShadow.children[2],ring=pointerShadow.children[1];
   const flight=arrow.getAnimations()[0];await flight.ready;flight.pause();
   const duration=flight.effect.getTiming().duration;flight.currentTime=duration*.35;
   const middle=arrow.getBoundingClientRect().left,firstEnd=first.getBoundingClientRect();
   PageAgentPointer.show(first,document);
   const sameFlight=arrow.getAnimations()[0]===flight;
   PageAgentPointer.show(second,document);
   const redirected=arrow.getAnimations()[0];await redirected.ready;redirected.pause();redirected.currentTime=0;
   const restart=arrow.getBoundingClientRect().left;
   redirected.play();PageAgentPointer.click();const ringBefore=ring.style.display;
   redirected.finish();await redirected.finished;await Promise.resolve();
   const destination=arrow.getBoundingClientRect().left,expected=second.getBoundingClientRect();
   const ringAfter=ring.style.display;
   PageAgentPointer.show(first,document);PageAgentPointer.click();PageAgentPointer.clear();await Promise.resolve();
   return {duration,intermediate:middle>24&&middle<(firstEnd.left+firstEnd.right)/2,sameFlight,continuous:Math.abs(restart-middle)<1,arrived:Math.abs(destination-(expected.left+expected.right)/2)<1,ringBefore,ringAfter,cleared:!document.querySelector('[data-page-agent="pointer"]')};
  });
  assert(motion.duration>=240&&motion.duration<=600);
  assert.deepEqual({...motion,duration:undefined},{duration:undefined,intermediate:true,sameFlight:true,continuous:true,arrived:true,ringBefore:'none',ringAfter:'block',cleared:true});
  await page.evaluate(()=>PageAgentPointer.show(document.getElementById('second'),document));
  await page.screenshot({path:path.join(__dirname,'../tests/browser-output/page-pointer.png')});
  await page.waitForTimeout(1200);
  assert.equal(await page.locator('[data-page-agent="pointer"]').count(),1,'arrow survives highlight timeout');
  await page.evaluate(()=>window.dispatchEvent(new Event('scroll')));
  assert.equal(await page.locator('[data-page-agent="pointer"]').count(),1,'scroll keeps parked arrow');
  await page.setViewportSize({width:500,height:400});
  assert.equal(await page.locator('[data-page-agent="pointer"]').count(),1,'resize keeps arrow');
  await page.evaluate(()=>PageAgentPointer.clear());
  assert.equal(await page.locator('[data-page-agent="pointer"]').count(),0);
  await page.evaluate(()=>PageAgentPointer.start(document));
  assert.equal(await page.locator('[data-page-agent="pointer"]').count(),1,'observation can show pointer before any action');
  await page.evaluate(()=>PageAgentPointer.clear());
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.evaluate(()=>{PageAgentPointer.show(document.getElementById('first'),document);PageAgentPointer.show(document.getElementById('second'),document);PageAgentPointer.click();});
  assert.equal(await page.evaluate(()=>document.getAnimations().length),0);
  await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));
  assert.equal(await page.locator('[data-page-agent="pointer"]').count(),0);
  console.log('Pointer browser checks passed: hover, single click, snapshot isolation, hit testing, persistent arrow, scroll/resize, start, cleanup, continuous movement/retargeting/click feedback, reduced motion.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
