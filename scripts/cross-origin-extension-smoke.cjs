'use strict';
// Real unpacked MV3 extension and real cross-origin frames; no model API or payment service.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
(async()=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'page-agent-frame-'));
 let context;
 try{
 const ext=path.join(tmp,'extension');await fs.cp(path.join(__dirname,'../extension'),ext,{recursive:true});
 const manifest=JSON.parse(await fs.readFile(path.join(ext,'manifest.json'),'utf8'));
 manifest.host_permissions=['https://merchant.test/*','https://payment.test/*'];await fs.writeFile(path.join(ext,'manifest.json'),JSON.stringify(manifest));
 context=await chromium.launchPersistentContext(path.join(tmp,'profile'),{headless:true,channel:'chromium',executablePath:process.env.PAGE_AGENT_CHROMIUM||undefined,args:['--disable-extensions-except='+ext,'--load-extension='+ext]});
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 await context.route('https://**/*',r=>r.fulfill({contentType:'text/html',body:r.request().url().startsWith('https://merchant.test')?'<h1>Checkout</h1><iframe title="Payment" src="https://payment.test/form" style="width:500px;height:300px"></iframe>':'<input aria-label="Name"><input aria-label="Card" autocomplete="cc-number"><button onclick="window.paid=true">Pay</button>'}));
 const page=await context.newPage();await page.goto('https://merchant.test/');
 await worker.evaluate(async()=>{globalThis.frameTestTools=PageAgentBrowserTools.createBrowserTools(chrome);globalThis.frameTestTab=(await chrome.tabs.query({url:'https://merchant.test/*'}))[0].id;globalThis.frameTestPolicy={origin:'https://merchant.test',allowedOrigins:['https://merchant.test'],sensitiveFields:false};});
 let s=await worker.evaluate(()=>frameTestTools.observe(frameTestTab,0,frameTestPolicy));assert.equal(s.page.frames[0].reason,'permission_required');
 await worker.evaluate(()=>chrome.scripting.executeScript({target:{tabId:frameTestTab,frameIds:[0]},world:'ISOLATED',func:()=>{globalThis.pointerMoves=0;const show=PageAgentPointer.show;PageAgentPointer.show=(...args)=>{pointerMoves++;return show(...args);};}}));
 const moveCount=()=>worker.evaluate(async()=>(await chrome.scripting.executeScript({target:{tabId:frameTestTab,frameIds:[0]},world:'ISOLATED',func:()=>pointerMoves}))[0].result);
 s=await worker.evaluate(()=>{frameTestPolicy.allowedOrigins.push('https://payment.test');return frameTestTools.observe(frameTestTab,0,frameTestPolicy);});
 assert(s.page.elements.some(e=>e.label==='Name'));assert(!s.page.elements.some(e=>e.label==='Card'));
 assert.equal(await moveCount(),0,'read-only frame observation must not move the pointer');
 const r=await worker.evaluate(async()=>{
  frameTestPolicy.sensitiveFields=true;
  const s=await frameTestTools.observe(frameTestTab,0,frameTestPolicy),e=s.page.elements.find(e=>e.label==='Card'),plan={action:'fill',id:e.id,value:'4242424242424242',reply:'Test fill'};
  globalThis.frameTestPending={frameRoute:s.frameRoutes[e.id],operationId:'test',plan,snapshotId:s.snapshotId,documentId:s.documentId,url:s.url,expected:PageAgentConditions.bind(PageAgentConditions.automatic(plan),s)};
  return frameTestTools.execute(frameTestTab,frameTestPending,frameTestPolicy,async()=>true);
 });assert.equal(r.status,'success');
 assert.equal(await page.frames()[1].locator('[aria-label="Card"]').inputValue(),'4242424242424242');
 const movesBeforeVerify=await moveCount();assert(movesBeforeVerify>0,'frame action provides pointer feedback');
 assert.equal((await worker.evaluate(()=>frameTestTools.verify(frameTestTab,{expected:frameTestPending.expected},frameTestPolicy))).status,'success');
 await worker.evaluate(()=>frameTestTools.verify(frameTestTab,{expected:frameTestPending.expected},frameTestPolicy));
 const unmet=await worker.evaluate(()=>frameTestTools.verify(frameTestTab,{expected:frameTestPending.expected.map(c=>({...c,value:'not-current-value'}))},frameTestPolicy));
 assert.equal(unmet.status,'not_satisfied');
 assert.equal(await moveCount(),movesBeforeVerify,'repeated verification must leave the pointer parked');
 assert.equal(await worker.evaluate(async()=>{try{await frameTestTools.execute(frameTestTab,frameTestPending,frameTestPolicy,async()=>true);return 'executed';}catch(e){return e.code;}}),'STALE');
 const recovery=await worker.evaluate(async()=>{
  const store=PageAgentTaskStore.createTaskStore(chrome);
  let requests=0;
  const runtime=PageAgentRuntime.createRuntime({store,tools:frameTestTools,preferences:async()=>({maxSteps:50,contextTokens:32768}),schedule(){},cancelSchedule:async()=>{},model:async input=>{
   requests++;const page=JSON.parse(input).page,e=page.elements.find(e=>e.label==='Name');
   return {text:JSON.stringify(e?{action:'fill',id:e.id,value:'Scoped Customer',reply:'Fill name'}:{action:'pause',reply:'Embedded form needs website access'})};
  }});
  globalThis.frameTestRuntime=runtime;
  const initial=await runtime.submit(frameTestTab,'Fill test fields and stop before Pay',{goalMode:true});
  await runtime.tick(frameTestTab);const blocked=await runtime.get(frameTestTab);
  if(blocked.reason!=='frame_access')throw Error('Expected frame permission card: '+blocked.reason);
  await runtime.tick(frameTestTab);const requestCount=requests;
  await runtime.changeOrigins(frameTestTab,{taskId:blocked.taskId,expectedRevision:blocked.scopeRevision,origin:'https://payment.test',action:'add'});
  await runtime.resume(frameTestTab);await runtime.tick(frameTestTab);
  const after=await runtime.get(frameTestTab);
  return {requestCount,helpAttempts:blocked.helpAttempts||0,origins:blocked.frameAccessRequest.origins,sameTask:initial.taskId===after.taskId,status:after.status};
 });
 assert.equal(recovery.requestCount,1);assert.equal(recovery.helpAttempts,0);assert.deepEqual(recovery.origins,['https://payment.test']);assert.equal(recovery.sameTask,true);
 assert.equal(await page.frames()[1].locator('[aria-label="Name"]').inputValue(),'Scoped Customer');
 assert.equal(await page.locator('[data-page-agent="pointer"]').count(),1,'active task keeps top pointer');
 await worker.evaluate(()=>frameTestRuntime.stop(frameTestTab));
 for(const frame of page.frames())assert.equal(await frame.locator('[data-page-agent="pointer"]').count(),0,'stop clears pointer in every frame');
 assert.equal(await page.frames()[1].evaluate(()=>!!window.paid),false);
 console.log('Real MV3 cross-origin smoke passed: actual webNavigation, scoped injection, sensitive authorization, fill, verification, stale rejection, runtime permission pause without retries and scoped continuation; Pay untouched.');
 }finally{if(context)await context.close();await fs.rm(tmp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
