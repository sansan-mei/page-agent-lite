'use strict';
// Real DOM only: no extension worker or model.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PAGE_AGENT_CHROMIUM});
 try{
  const page=await browser.newPage();
  await page.setContent('<button aria-label="Exit fullscreen" style="width:100px;height:100px"><svg width="80" height="80"><rect width="80" height="80" /></svg></button>');
  await page.addScriptTag({path:path.join(__dirname,'../extension/core.js')});
  const result=await page.evaluate(()=>{
   const C=PageAgentCore,button=document.querySelector('button'),rect=document.querySelector('rect');
   let clicks=0,hit=false;
   button.addEventListener('click',e=>{clicks++;hit=e.target===rect;});
   const execute=()=>{const s=C.agentSnapshot(document);C.agentExecute({action:'click',id:s.page.elements[0].id},s,document);};
   const missing=typeof rect.click==='undefined';execute();
   const first={clicks,hit};
   button.addEventListener('mousedown',()=>{const cover=document.createElement('div');cover.style='position:fixed;inset:0;z-index:9999';document.body.append(cover);},{once:true});
   let changed;try{execute();}catch(e){changed=e.code;}
   return {missing,first,changed,clicks};
  });
  assert.equal(result.missing,true);assert.deepEqual(result.first,{clicks:1,hit:true});
  assert.equal(result.changed,'TARGET_CHANGED');assert.equal(result.clicks,1);
  console.log('SVG click passed: bubbled exactly once from hit rect; mid-interaction overlay prevented further click.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
