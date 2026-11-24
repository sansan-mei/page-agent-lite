'use strict';
// Real DOM only: no extension worker or model.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PAGE_AGENT_CHROMIUM});
 try{
  const page=await browser.newPage({viewport:{width:800,height:600}});
  await page.setContent(`<form style="padding:40px"><input aria-label="开始时间" value="2024-01"><button type="button" id="save" style="width:200px;height:40px">保存至在线简历</button></form>
<div id="picker" role="dialog" aria-label="选择日期" style="position:absolute;z-index:10;background:#fff;border:1px solid #888;width:260px;height:120px"><button type="button" id="ok">确定</button><button type="button" disabled>清空</button></div>
<div style="height:1600px"></div><button type="button" id="low" style="width:200px;height:40px">底部按钮</button><div style="height:600px"></div><div id="bar" style="position:fixed;left:0;right:0;bottom:0;height:80px;background:#eee;z-index:5">固定底栏</div>`);
  await page.addScriptTag({path:path.join(__dirname,'../extension/core.js')});
  await page.addScriptTag({path:path.join(__dirname,'../extension/tool-protocol.js')});
  const result=await page.evaluate(()=>{
   const C=PageAgentCore,T=PageAgentProtocol,save=document.getElementById('save'),picker=document.getElementById('picker');
   let saves=0;save.addEventListener('click',()=>saves++);
   document.getElementById('ok').addEventListener('click',()=>picker.remove());
   const click=label=>{const s=C.agentSnapshot(document),e=s.page.elements.find(x=>x.label===label);try{C.agentExecute({action:'click',id:e.id},s,document);return {ok:true,snap:s};}catch(error){return {ok:false,error,snap:s};}};
   const r=save.getBoundingClientRect();
   // Partial cover: the popup hides the centre and left half, the right edge stays visible.
   Object.assign(picker.style,{left:r.left+'px',top:r.top+'px',width:(r.width*0.6)+'px',height:r.height+'px'});
   const partial=click('保存至在线简历');
   const partialSaves=saves;
   // Full cover: nothing of the button is reachable, so nothing must be dispatched.
   Object.assign(picker.style,{left:(r.left-10)+'px',top:(r.top-10)+'px',width:(r.width+20)+'px',height:(r.height+20)+'px'});
   const full=click('保存至在线简历'),fullSaves=saves,outcome=T.failure(full.error,{dispatch:'not_sent'});
   // The reported key is matched in a fresh snapshot, then the layer control is used and the save is retried.
   const key=outcome.observed.layerControls[0]?.key,fresh=C.agentSnapshot(document),ok=fresh.page.elements.find(e=>e.key===key);
   C.agentExecute({action:'click',id:ok.id},fresh,document);
   const retry=click('保存至在线简历');
   // A fixed footer covers a control near the viewport bottom; centring it makes it clickable.
   let lows=0;const low=document.getElementById('low');low.addEventListener('click',()=>lows++);
   window.scrollTo(0,low.getBoundingClientRect().top+window.scrollY-540);
   const covered=document.elementFromPoint(low.getBoundingClientRect().left+100,low.getBoundingClientRect().top+20)===document.getElementById('bar');
   const footer=click('底部按钮');
   return {partial:partial.ok,partialSaves,fullOk:full.ok,fullCode:full.error?.code,fullSaves,observed:outcome.observed,okLabel:ok?.label,pickerGone:!picker.isConnected,retry:retry.ok,saves,covered,footer:footer.ok,lows};
  });
  assert.equal(result.partial,true);assert.equal(result.partialSaves,1);
  assert.equal(result.fullOk,false);assert.equal(result.fullCode,'TARGET_BLOCKED');assert.equal(result.fullSaves,1);
  assert.equal(result.observed.layer.role,'dialog');assert.equal(result.observed.layer.label,'选择日期');
  assert.deepEqual(result.observed.layerControls.map(c=>c.label),['确定']);
  assert.equal(result.okLabel,'确定');assert.equal(result.pickerGone,true);
  assert.equal(result.retry,true);assert.equal(result.saves,2);
  assert.equal(result.covered,true);assert.equal(result.footer,true);assert.equal(result.lows,1);
  console.log('Overlay checks passed: partial cover clicked at a visible point, full cover reported layer controls by key and sent nothing, layer closed then retry saved once, fixed footer resolved by centring.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
