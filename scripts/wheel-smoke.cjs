'use strict';
// Real DOM + extension messaging stub. No live model or extension worker.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PAGE_AGENT_CHROMIUM});
 try{
  const page=await browser.newPage();
  await page.route('https://fixture.test/**',r=>r.fulfill({contentType:'text/html',body:'<style>body{margin:0;overflow:hidden}button{width:300px;height:300px}</style><button aria-label="Viewer"><span>Item 1</span></button>'}));
  await page.goto('https://fixture.test/');
  await page.evaluate(()=>{globalThis.chrome={runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,onMessage:{addListener(fn){globalThis.listener=fn;}},sendMessage:async()=>({ok:true})}};});
  for(const f of ['tool-protocol.js','conditions.js','core.js','content.js'])await page.addScriptTag({path:path.join(__dirname,'../extension',f)});
  const r=await page.evaluate(async()=>{
   const send=m=>new Promise(resolve=>listener(m,{id:'test',url:'chrome-extension://test/background.js'},resolve));
   let count=0,metadata;
   document.querySelector('button').addEventListener('wheel',e=>{count++;metadata={dy:e.deltaY,mode:e.deltaMode,trusted:e.isTrusted};e.preventDefault();document.querySelector('span').textContent='Item '+(count+1);},{passive:false});
   const observe=()=>send({type:'agent:observe'});
   const execute=(s,plan)=>send({type:'agent:execute',snapshotId:s.value.snapshotId,documentId:s.value.documentId,url:s.value.url,plan});
   const s=await observe(),plan={reply:'wheel',action:'wheel',id:s.value.page.elements[0].id,value:'down'};
   const invalid=[];
   for(const p of [{...plan,id:'invented'},{...plan,id:undefined},{...plan,value:'code()'}]){try{PageAgentCore.agentPlan(JSON.stringify(p),PageAgentCore.agentSnapshot(document));invalid.push(false);}catch{invalid.push(true);}}
   const scroll=await execute(s,{reply:'scroll',action:'scroll',value:'down'});
   const fresh=await observe(),wheel=await execute(fresh,plan),replay=await execute(fresh,plan);
   const next=await observe();
   const cover=document.createElement('div');cover.style='position:fixed;inset:0;z-index:9999';document.body.append(cover);
   const blocked=await execute(next,plan);cover.remove();
   const old=await observe();document.querySelector('button').setAttribute('aria-label','Changed');
   const stale=await execute(old,plan);
   return {scroll:scroll.value.observed,wheel:wheel.value,metadata,count,replay:replay.code,blocked:blocked.result,stale:stale.code,invalid,text:document.querySelector('span').textContent};
  });
  assert.equal(r.scroll.delta,0);assert.equal(r.count,1);assert.equal(r.text,'Item 2');
  assert.deepEqual(r.metadata,{dy:600,mode:0,trusted:false});assert.equal(r.wheel.dispatch,'sent');assert.equal(r.wheel.status,'unknown');
  assert.equal(r.wheel.observed.defaultPrevented,true);assert.equal(r.replay,'STALE');assert.equal(r.stale,'STALE');
  assert.equal(r.blocked.code,'TARGET_BLOCKED');assert.equal(r.blocked.dispatch,'not_sent');assert.deepEqual(r.invalid,[true,true,true]);
  console.log('Wheel checks passed: zero native scroll, listener changed item once, unknown result, blocked/stale/replayed/invalid targets rejected.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
