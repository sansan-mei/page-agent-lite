'use strict';
// Real DOM and CSS in Chromium; core only, no model or loaded extension.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
const html=`<!doctype html><style>
.row{cursor:pointer;padding:8px}.row .op{opacity:0}.row:hover .op{opacity:1}
.ops{visibility:hidden}.ops .shown{visibility:visible}
</style><main>
<div class="row" id="row">期望职位 <a class="op" id="add">添加</a> <span class="op" id="more" aria-haspopup="menu">更多</span> <span class="op" id="plain">图标</span></div>
<div class="ops"><button class="shown" id="edit">编辑</button><button id="gone">删除</button></div>
</main>`;
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PAGE_AGENT_CHROMIUM});
 try{
  const page=await browser.newPage({viewport:{width:800,height:500}});
  await page.route('https://fixture.test/**',route=>route.fulfill({contentType:'text/html',body:html}));
  await page.goto('https://fixture.test/');
  // Keep the real pointer away so CSS :hover never reveals the actions.
  await page.mouse.move(790,490);
  await page.evaluate(()=>{globalThis.chrome={runtime:{id:'test',getURL:p=>p,onMessage:{addListener(){}},sendMessage:async()=>({})}};});
  for(const file of ['tool-protocol.js','conditions.js','core.js'])await page.addScriptTag({path:path.join(__dirname,'../extension',file)});
  const result=await page.evaluate(()=>{
   const snap=PageAgentCore.agentSnapshot(document,{includeText:false});
   const ids=[...snap.nodes.values()].map(v=>v.node.id);
   const clicked=[];for(const id of ['add','more','edit'])document.getElementById(id).addEventListener('click',()=>clicked.push(id));
   for(const id of ['add','more','edit']){const target=[...snap.nodes].find(([,v])=>v.node.id===id)[0];PageAgentCore.agentExecute({action:'click',id:target},snap,document);}
   return {ids,clicked};
  });
  assert.deepEqual(result.ids.filter(id=>['row','add','more','plain','edit','gone'].includes(id)).sort(),['add','edit','more','row']);
  assert.deepEqual(result.clicked,['add','more','edit']);
  console.log('Hover action browser checks passed: link and popup actions inside a clickable row, visibility override, inherited hidden exclusion, real clicks.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
