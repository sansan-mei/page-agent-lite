'use strict';
// Real unpacked extension in Playwright Chromium: CSS-only :hover actions become visible
// only after browser-tools moves the real mouse through chrome.debugger. No model.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const html=`<!doctype html><meta charset="utf-8"><style>
.row{cursor:pointer;padding:20px;width:600px}.row .add{display:none;cursor:pointer}.row:hover .add{display:inline}
</style><main><section aria-label="期望职位"><div class="row" id="row" onclick="window.rowClicks=(window.rowClicks||0)+1">期望职位 Node.js <a class="add" id="add" onclick="event.stopPropagation();window.added=(window.added||0)+1">添加</a></div></section></main>`;
(async()=>{
 const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(html);});
 await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
 const origin='http://127.0.0.1:'+server.address().port;
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'page-agent-hover-'));
 const fixture=path.join(base,'extension');
 await fs.cp(path.join(__dirname,'../extension'),fixture,{recursive:true});
 const manifest=JSON.parse(await fs.readFile(path.join(fixture,'manifest.json'),'utf8'));
 assert.ok(manifest.permissions.includes('debugger'));
 await fs.writeFile(path.join(fixture,'manifest.json'),JSON.stringify({...manifest,host_permissions:['http://127.0.0.1/*']}));
 const context=await chromium.launchPersistentContext(path.join(base,'profile'),{channel:'chromium',headless:true,viewport:{width:900,height:600},args:[`--disable-extensions-except=${fixture}`,`--load-extension=${fixture}`]});
 try{
  const sw=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker',{timeout:20000});
  const page=await context.newPage();await page.goto(origin+'/');
  const result=await sw.evaluate(async origin=>{
   const tools=PageAgentBrowserTools.createBrowserTools(chrome);
   const [tab]=await chrome.tabs.query({url:origin+'/*'});
   const policy={origin,allowedOrigins:[origin]};
   const labels=s=>s.page.elements.map(e=>e.label);
   const before=await tools.observe(tab.id,0,policy);
   const row=before.page.elements.find(e=>e.label.startsWith('期望职位'));
   const pending=s=>({operationId:crypto.randomUUID(),documentId:s.documentId,snapshotId:s.snapshotId,url:s.url});
   const hovered=await tools.execute(tab.id,{...pending(before),plan:{reply:'悬浮',action:'hover',id:row.id}},policy,async()=>true);
   await new Promise(r=>setTimeout(r,300));
   const after=await tools.observe(tab.id,0,policy);
   const add=after.page.elements.find(e=>e.label==='添加');
   const clicked=add?await tools.execute(tab.id,{...pending(after),plan:{reply:'添加',action:'click',id:add.id}},policy,async()=>true):null;
   const [state]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>({added:window.added||0,rowClicks:window.rowClicks||0,hover:document.getElementById('row').matches(':hover')}),world:'MAIN'});
   const stopped=await tools.observe(tab.id,0,policy);
   const cancelled=await tools.execute(tab.id,{...pending(stopped),plan:{reply:'悬浮',action:'hover',id:stopped.page.elements.find(e=>e.label.startsWith('期望职位')).id}},policy,async()=>false);
   return {before:labels(before),hover:{code:hovered.code,pointer:hovered.observed?.pointer,dispatch:hovered.dispatch},after:labels(after),clicked:clicked&&{dispatch:clicked.dispatch},state:state.result,cancelledPointer:cancelled.observed?.pointer??null,cancelledCode:cancelled.code};
  },origin);
  console.log(JSON.stringify(result));
  assert.ok(!result.before.includes('添加'),'hover-only action must be hidden before trusted hover');
  assert.deepEqual(result.hover,{code:'TRUSTED_HOVER',pointer:'trusted',dispatch:'sent'});
  assert.ok(result.after.includes('添加'),'trusted hover reveals CSS :hover action');
  assert.equal(result.clicked.dispatch,'sent');assert.equal(result.state.added,1);assert.equal(result.state.rowClicks,0);assert.equal(result.state.hover,true);
  assert.equal(result.cancelledPointer,null);assert.notEqual(result.cancelledCode,'TRUSTED_HOVER');
  console.log('Trusted hover extension checks passed: CSS :hover action hidden, real mouse move via debugger reveals it, click lands once, hover state survives detach, cancelled run skips the real move.');
 }finally{await context.close();server.close();await fs.rm(base,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
