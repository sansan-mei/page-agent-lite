'use strict';
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
const {createBrowserTools}=require('../extension/browser-tools.js');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PAGE_AGENT_CHROMIUM||undefined});
 try{
 const page=await browser.newPage();
 await page.route('https://**/*',r=>r.fulfill({contentType:'text/html',body:r.request().url().startsWith('https://merchant.test')?'<h1>Checkout</h1><iframe title="Payment" src="https://payment.test/form" style="width:500px;height:300px"></iframe><div id="cover" style="display:none;position:fixed;inset:0;background:white;z-index:9"></div>':'<label>Name<input aria-label="Name"></label><input aria-label="Card" autocomplete="cc-number"><button onclick="window.paid=true">Pay</button>'}));
 await page.goto('https://merchant.test/');
 const frames=new Map([[0,page.mainFrame()],[1,page.frames().find(f=>f.parentFrame())]]);
 const sender={id:'test',url:'chrome-extension://test/background.js'};
 const chrome={permissions:{contains:async()=>true},webNavigation:{getAllFrames:async()=>[...frames].filter(([,f])=>!f.isDetached()).map(([frameId,f])=>({frameId,parentFrameId:frameId===0?-1:0,url:f.url()}))},tabs:{get:async()=>({url:page.url(),status:'complete'}),sendMessage:async(id,m,{frameId=0}={})=>frames.get(frameId).evaluate(({m,sender})=>new Promise(resolve=>readListener(m,sender,resolve)),{m,sender})},scripting:{executeScript:async({target,files})=>{
  for(const id of target.frameIds){const f=frames.get(id);await f.evaluate(()=>{globalThis.chrome={runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,onMessage:{addListener(fn){globalThis.readListener=fn;}},sendMessage:async()=>({})}};});for(const file of files)await f.addScriptTag({path:path.join(__dirname,'../extension',file)});}
 }}};
 const tools=createBrowserTools(chrome),policy={origin:'https://merchant.test',allowedOrigins:['https://merchant.test'],sensitiveFields:false};
 let s=await tools.observe(1,0,policy);
 assert(!s.page.elements.some(e=>e.label==='Name'));assert.equal(s.page.frames[0].reason,'permission_required');
 policy.allowedOrigins.push('https://payment.test');s=await tools.observe(1,0,policy);
 assert(s.page.elements.some(e=>e.label==='Name'));assert(!s.page.elements.some(e=>e.label==='Card'));
 const G=require('../extension/conditions.js');
 const pending=(s,label,value)=>{const e=s.page.elements.find(e=>e.label===label),plan={action:'fill',reply:'Fill',id:e.id,value};return {operationId:'op',url:s.url,snapshotId:s.snapshotId,documentId:s.documentId,frameRoute:s.frameRoutes[e.id],plan,expected:G.bind(G.automatic(plan),s)};};
 let p=pending(s,'Name','Test Customer');let r=await tools.execute(1,p,policy,async()=>true);assert.equal(r.status,'success');
 assert.equal(await frames.get(1).locator('input[aria-label="Name"]').inputValue(),'Test Customer');
 assert.equal((await tools.verify(1,{expected:p.expected},policy)).status,'success');
 await assert.rejects(()=>tools.execute(1,p,policy,async()=>true),e=>e.code==='STALE');
 policy.sensitiveFields=true;s=await tools.observe(1,0,policy);p=pending(s,'Card','4242424242424242');
 await assert.rejects(()=>tools.execute(1,p,policy,async()=>false),e=>e.code==='CANCELLED');
 assert.equal(await frames.get(1).locator('input[aria-label="Card"]').inputValue(),'');
 s=await tools.observe(1,0,policy);p=pending(s,'Card','4242424242424242');
 await page.locator('#cover').evaluate(e=>e.style.display='block');
 await assert.rejects(()=>tools.execute(1,p,policy,async()=>true),e=>e.code==='TARGET_BLOCKED');
 await page.locator('#cover').evaluate(e=>e.style.display='none');
 r=await tools.execute(1,p,policy,async()=>true);assert.equal(r.status,'success');
 s=await tools.observe(1,0,policy);p=pending(s,'Name','Should not fill');
 policy.allowedOrigins.pop();await assert.rejects(()=>tools.execute(1,p,policy,async()=>true),e=>e.code==='PERMISSION_DENIED');policy.allowedOrigins.push('https://payment.test');
 await frames.get(1).goto('https://payment.test/replaced');await assert.rejects(()=>tools.execute(1,p,policy,async()=>true),e=>e.code==='STALE');
 assert.equal(await frames.get(1).evaluate(()=>window.paid===true),false);
 console.log('Cross-origin iframe browser component smoke passed: authorization, fill, verify, stale, cancellation, overlay, permission removal, navigation; Pay untouched.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
