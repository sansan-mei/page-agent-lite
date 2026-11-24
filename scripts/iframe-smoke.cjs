'use strict';
// Real DOM in Chromium with a Chrome messaging stub; no model or loaded extension.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
const top=`<h1>Checkout</h1><button type="button" id="topSave">Top save</button>
<iframe id="pay" title="Payment form" src="/child" style="position:absolute;left:40px;top:120px;width:500px;height:300px;border:3px solid #333;padding:5px"></iframe>
<iframe title="Ad" src="https://other.test/ad" style="position:absolute;left:600px;top:120px;width:150px;height:100px"></iframe>
<iframe src="/child" style="display:none"></iframe>
<div id="cover" style="display:none;position:absolute;left:30px;top:110px;width:530px;height:330px;background:#fff;z-index:5">Loading overlay</div>`;
const child=`<body style="margin:0;font:14px sans-serif"><form>
<input aria-label="Name"><input type="checkbox" aria-label="Agree"><select aria-label="City"><option value="">-</option><option value="sh">Shanghai</option></select>
<input type="password" aria-label="Password" value="PRIVATE_FRAME_SECRET"><button type="button" id="submit">Submit</button></form>
<section aria-label="Result"><p id="out">Waiting</p></section>
<iframe title="Inner" src="/inner" style="width:200px;height:60px"></iframe>
<div style="height:900px"></div><button type="button" id="low">Lower action</button><div style="height:200px"></div>
<script>window.log=[];document.addEventListener('input',e=>log.push(['input',e.constructor===window.InputEvent]),true);
document.addEventListener('keydown',e=>log.push(['key',e.key]),true);
document.getElementById('submit').addEventListener('mousedown',e=>log.push(['down',e.clientX,e.clientY]));
document.getElementById('submit').addEventListener('click',()=>{log.push(['submit']);document.getElementById('out').textContent='Saved';});
document.getElementById('low').addEventListener('click',()=>log.push(['low']));</script></body>`;
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PAGE_AGENT_CHROMIUM});
 try{
  const page=await browser.newPage({viewport:{width:800,height:600}});
  const pages={'https://fixture.test/':top,'https://fixture.test/child':child,'https://fixture.test/inner':'<button>Inner button</button>','https://other.test/ad':'<button>Ad button</button>'};
  await page.route(/^https:\/\/(fixture|other)\.test\//,route=>route.fulfill({contentType:'text/html',body:pages[route.request().url()]||''}));
  await page.goto('https://fixture.test/');
  await page.evaluate(()=>{globalThis.chrome={runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,onMessage:{addListener(fn){globalThis.readListener=fn;}},sendMessage:async()=>({ok:true})}};});
  for(const file of ['tool-protocol.js','conditions.js','core.js','page-pointer.js','content.js'])await page.addScriptTag({path:path.join(__dirname,'../extension',file)});
  const r=await page.evaluate(async()=>{
   const sender={id:'test',url:'chrome-extension://test/background.js'},send=m=>new Promise(res=>readListener(m,sender,res));
   const frame=document.getElementById('pay'),cw=frame.contentWindow,cd=frame.contentDocument;
   const observe=async()=>(await send({type:'agent:observe'})).value;
   const act=async(label,action,value,expected)=>{const s=await observe(),e=s.page.elements.find(x=>x.label===label);if(!e)throw Error('missing '+label);return send({type:'agent:execute',snapshotId:s.snapshotId,documentId:s.documentId,url:s.url,plan:{reply:action,action,id:e.id,value},expected:expected&&PageAgentConditions.bind(expected(s),s)});};
   const first=await observe(),out={};
   out.frames=first.page.frames;out.coverage=first.page.coverage;out.json=JSON.stringify(first.page);
   out.labels=first.page.elements.map(e=>[e.label,e.frame||null]);out.view=Object.fromEntries(first.page.elements.map(e=>[e.label,e.inViewport]));out.text=first.page.text;
   out.fill=await act('Name','fill','Ada');out.name=cd.querySelector('[aria-label="Name"]').value;
   out.check=await act('Agree','check',true);out.agree=cd.querySelector('[aria-label="Agree"]').checked;
   out.select=await act('City','select','sh');out.city=cd.querySelector('select').value;
   out.key=await act('Name','press_key','Enter');
   out.submit=await act('Submit','click',undefined,s=>[{kind:'text_present',id:s.page.regions.find(x=>x.label==='Result').id,value:'Saved'}]);
   out.pointerTop=!!document.querySelector('[data-page-agent="pointer"]');out.pointerFrame=!!cd.querySelector('[data-page-agent]');
   const btn=cd.getElementById('submit').getBoundingClientRect();out.btn={left:btn.left,right:btn.right,top:btn.top,bottom:btn.bottom};
   out.low=await act('Lower action','click');out.childScroll=cw.scrollY;
   cw.scrollTo(0,0);document.getElementById('cover').style.display='block';
   out.blocked=await act('Submit','click');document.getElementById('cover').style.display='none';
   const s=await observe(),e=s.page.elements.find(x=>x.label==='Submit');frame.remove();
   out.removed=await send({type:'agent:execute',snapshotId:s.snapshotId,documentId:s.documentId,url:s.url,plan:{reply:'click',action:'click',id:e.id}});
   out.log=cw.log;return out;
  });
  const f=r.frames.find(x=>x.label==='Payment form'),ad=r.frames.find(x=>x.label==='Ad'),inner=r.frames.find(x=>x.label==='Inner');
  assert.equal(f.read,true);assert.equal(ad.read,false);assert.equal(ad.reason,'cross_origin');assert.equal(inner.reason,'nested');
  assert.equal(r.frames.length,3);assert.equal(r.coverage.framesComplete,false);
  assert.deepEqual(r.labels.filter(([,fr])=>fr).map(([l])=>l).slice(0,5),['Name','Agree','City','Submit','Lower action']);
  assert.equal(r.view.Name,true);assert.equal(r.view['Lower action'],false);
  assert.ok(r.labels.every(([l,fr])=>l!=='Top save'||fr===null));
  assert.ok(!r.labels.some(([l])=>/Inner button|Ad button|Password/.test(l)));
  assert.ok(!r.json.includes('PRIVATE_FRAME_SECRET'));assert.equal(r.coverage.sensitiveExcluded,true);
  assert.match(r.text,/\[f0 Payment form\] .*Saved|\[f0 Payment form\] .*Waiting/);
  for(const k of ['fill','check','select','key','submit','low'])assert.equal(r[k].ok,true,k+': '+JSON.stringify(r[k]));
  assert.equal(r.name,'Ada');assert.equal(r.fill.value.verification.verified,true);assert.equal(r.agree,true);assert.equal(r.city,'sh');
  assert.equal(r.submit.value.status,'success');assert.equal(r.submit.value.code,'CONDITIONS_MATCH');
  assert.equal(r.pointerTop,true);assert.equal(r.pointerFrame,false);
  const submit=r.log.find(x=>x[0]==='down');
  assert.ok(submit[1]>=r.btn.left&&submit[1]<=r.btn.right&&submit[2]>=r.btn.top&&submit[2]<=r.btn.bottom,'click uses frame-local coordinates');
  assert.ok(r.log.some(x=>x[0]==='input'&&x[1]===true),'input event built with the frame window constructor');
  assert.ok(r.log.some(x=>x[0]==='key'&&x[1]==='Enter'));assert.ok(r.log.some(x=>x[0]==='low'));assert.ok(r.childScroll>0);
  assert.equal(r.log.filter(x=>x[0]==='submit').length,1);
  assert.equal(r.blocked.code,'TARGET_BLOCKED');assert.equal(r.blocked.result.dispatch,'not_sent');assert.equal(r.blocked.result.observed.blocker.tag,'div');
  assert.equal(r.removed.code,'STALE');assert.equal(r.removed.result.dispatch,'not_sent');
  console.log('Iframe checks passed: same-origin frame read with frame ids, cross-origin/nested reported unread, password excluded, fill/check/select/press_key/click with frame coordinates and constructors, scoped verify, scroll inside frame, top overlay blocks, removed frame is stale.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
