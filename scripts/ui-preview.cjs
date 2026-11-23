const {chromium}=require('playwright');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const fs=require('node:fs/promises');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.PAGE_AGENT_CHROMIUM,headless:true});
 try{
  const page=await browser.newPage({viewport:{width:390,height:960},deviceScaleFactor:2});
  await page.addInitScript(()=>{
   const t=Date.now();
   const task={goal:'整理这页信息，填写表单后让我检查。',status:'waiting_confirmation',steps:4,prefs:{maxSteps:50,autoClick:false},events:[{time:t-24000,text:'已读取页面内容，找到 3 个可填写字段。'},{time:t-16000,text:'已填写姓名和联系方式，字段状态已核实。'},{time:t-8000,text:'表单已准备好，等待你确认后再提交。'}],pending:{plan:{action:'click'},label:'提交表单'},contextUsage:{promptTokens:6432,cachedTokens:4096}};
   globalThis.chrome={runtime:{sendMessage:async m=>({ok:true,value:m.type==='task:get'?task:m.type==='task:memory'?[]:m.type==='task:site-memory'?{origin:'https://example.com',version:0,notes:[]}:[]}),openOptionsPage:async()=>{}},tabs:{query:async()=>[{id:1,url:'https://example.com/form',title:'示例工作台'}],onActivated:{addListener(){}},onUpdated:{addListener(){}}},storage:{onChanged:{addListener(){}}},permissions:{request:async()=>true}};
  });
  await page.goto(pathToFileURL(path.resolve('extension/sidepanel.html')).href);await page.locator('#goal').filter({hasText:'整理这页'}).waitFor();
  await fs.mkdir('docs/assets',{recursive:true});await page.screenshot({path:'docs/assets/sidepanel-preview.png',fullPage:true});
  for(const width of [320,390,480]){await page.setViewportSize({width,height:960});const size=await page.evaluate(()=>({body:document.documentElement.scrollWidth,view:innerWidth}));if(size.body>size.view)throw new Error('Horizontal overflow at '+width);}
  const options=await browser.newPage({viewport:{width:1080,height:900}});
  await options.addInitScript(()=>{globalThis.chrome={runtime:{sendMessage:async m=>({ok:true,value:m.type==='settings'?{}:m.type==='agentPreferences'?{maxSteps:50,autoFill:true,contextTokens:32768,compressionThreshold:80}:[]})}};});
  await options.goto(pathToFileURL(path.resolve('extension/options.html')).href);await options.locator('#status').filter({hasText:'设置已读取'}).waitFor();await options.screenshot({path:'tests/browser-output/options-redesign.png',fullPage:true});
  console.log('UI screenshots saved; no horizontal overflow at 320/390/480px. Preview uses synthetic task data.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
