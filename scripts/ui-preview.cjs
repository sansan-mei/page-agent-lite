const {chromium}=require('playwright');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const fs=require('node:fs/promises');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.PAGE_AGENT_CHROMIUM,headless:true});
 try{
  const page=await browser.newPage({viewport:{width:390,height:960},deviceScaleFactor:2});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
   const t=Date.now();
   const task={origin:'https://example.com',goal:'整理这页信息，填写表单后让我检查。',status:'running',steps:4,taskId:'preview-task',updatedAt:t,phase:'observe',metrics:{observations:4,actions:2,verifications:2},results:[{time:t-16000,request:{reply:'填写联系方式',action:'fill',id:'t2',value:'示例内容'},action:'fill',label:'联系方式',result:'字段已填写，实际值匹配',outcome:{status:'success',code:'FIELD_MATCH',evidence:[{kind:'value',matched:true}]}}],prefs:{maxSteps:50},events:[{time:t-24000,text:'已读取页面内容，找到 3 个可填写字段。'},{time:t-16000,text:'已填写姓名和联系方式，字段状态已核实。'},{time:t-8000,text:'表单已准备好，正在核对页面反馈。'}],pending:null,contextUsage:{promptTokens:6432,cachedTokens:4096}};
   globalThis.chrome={runtime:{sendMessage:async m=>({ok:true,value:m.type==='task:history'?[task,{...task,taskId:'previous-task',goal:'上一段独立对话',status:'ended'}]:m.type==='task:history-get'?m.taskId==='previous-task'?{...task,taskId:'previous-task',goal:'上一段独立对话',status:'ended',events:[{time:t,text:'旧对话专属消息'}],results:[]}:task:m.type==='task:get'?task:m.type==='task:finish'?{...task,status:'ended'}:m.type==='task:memory'?[]:m.type==='task:site-memory'?{origin:'https://example.com',version:0,notes:[]}:[]}),openOptionsPage:async()=>{}},tabs:{query:async()=>[{id:1,url:'https://example.com/form',title:'示例工作台'}],onActivated:{addListener(){}},onUpdated:{addListener(){}}},storage:{onChanged:{addListener(fn){globalThis.__previewUpdate=fn;}}},permissions:{request:async()=>true}};
  });
  await page.goto(pathToFileURL(path.resolve('extension/sidepanel.html')).href);await page.locator('#goal').filter({hasText:'整理这页'}).waitFor();
  await page.locator('#timeline .tool-call > summary').first().click();
  if(!await page.locator('#timeline .tool-call pre').first().textContent().then(t=>t.includes('t2')))throw new Error('Tool parameters missing');
  await page.screenshot({path:'tests/browser-output/sidepanel-tool-expanded.png',animations:'disabled'});
  await page.locator('#timeline .tool-call > summary').first().click();
  await fs.mkdir('docs/assets',{recursive:true});await page.screenshot({path:'docs/assets/sidepanel-preview.png',fullPage:true,animations:'disabled'});
  for(const width of [320,390,480]){await page.setViewportSize({width,height:960});const size=await page.evaluate(()=>({body:document.documentElement.scrollWidth,view:innerWidth}));if(size.body>size.view)throw new Error('Horizontal overflow at '+width);}
  // Exercise the layout with realistic short sidebars and long conversations.
  for(const width of [320,390,480]){
    await page.setViewportSize({width,height:640});
    await page.evaluate(async()=>{
      const original=(await chrome.runtime.sendMessage({type:'task:get'})).value;
      globalThis.__longPreview={...original,events:Array.from({length:30},(_,i)=>({time:Date.now()+i,text:'步骤 '+i+'：读取并核对当前网页上的信息。'}))};
      __previewUpdate({'task:1':{newValue:__longPreview}},'session');
    });
    const layout=await page.evaluate(()=>{
      const composer=document.querySelector('.composer').getBoundingClientRect(),input=document.getElementById('instruction').getBoundingClientRect(),chat=document.getElementById('conversation');
      return {body:document.documentElement.scrollHeight,height:innerHeight,bottom:composer.bottom,inputBottom:input.bottom,scrolls:chat.scrollHeight>chat.clientHeight,collapsed:!document.getElementById('run-details').open};
    });
    if(layout.body>layout.height||layout.bottom>layout.height||layout.inputBottom>layout.height||!layout.scrolls||!layout.collapsed)throw new Error('Sidebar input not anchored at '+width+': '+JSON.stringify(layout));
    await page.evaluate(()=>{document.getElementById('conversation').scrollTop=20;__longPreview.events.push({time:Date.now(),text:'新增进度消息'});__previewUpdate({'task:1':{newValue:__longPreview}},'session');});
    if(await page.locator('#conversation').evaluate(el=>el.scrollTop)!==20)throw new Error('New progress interrupted reading position');
  }
  await page.evaluate(()=>__previewUpdate({'task:1':{newValue:null}},'session'));
  if(!await page.locator('#empty-state').isVisible())throw new Error('Missing empty state');
  await page.screenshot({path:'tests/browser-output/sidepanel-empty.png',animations:'disabled'});
  await page.evaluate(()=>__previewUpdate({'task:1':{newValue:{...__longPreview,status:'paused',phase:'observe'}}},'session'));
  await page.locator('#resume').waitFor({state:'visible'});
  if(await page.locator('#stop').isVisible())throw new Error('Stop visible on paused task');
  await page.locator('#history').click();
  await page.locator('#history-view').waitFor({state:'visible'});
  await page.locator('.conversation-item').first().click();
  await page.locator('#context-usage').waitFor({state:'visible'});
  await page.screenshot({path:'tests/browser-output/sidepanel-details.png',animations:'disabled'});
  await page.locator('#history-back').click();
  await page.locator('#instruction').fill('旧任务草稿');
  await page.locator('#finish').click();
  await page.locator('#empty-state').waitFor({state:'visible'});
  if(await page.locator('#instruction').inputValue()!=='')throw new Error('New dialogue retained old draft');
  await page.locator('#history').click();
  await page.locator('[data-task-id="previous-task"]').click();
  await page.locator('#history-messages').filter({hasText:'旧对话专属消息'}).waitFor();
  if(await page.locator('#composer').isVisible())throw new Error('Composer visible in read-only history');
  await page.screenshot({path:'tests/browser-output/conversation-history.png',animations:'disabled'});
  if(!await page.locator('#history-goal').textContent())throw new Error('New dialogue deleted old records');
  console.log('Sidebar new dialogue: header placement, blank view and retained ended records verified.');
  console.log('Sidebar: empty/paused/running states, anchored input and preserved reading position verified at 320/390/480px.');
  const options=await browser.newPage({viewport:{width:1080,height:900}});
  options.on('pageerror',e=>errors.push(e.message));
  await options.addInitScript(()=>{globalThis.chrome={runtime:{sendMessage:async m=>({ok:true,value:m.type==='settings'?{}:m.type==='agentPreferences'?{maxSteps:50,contextTokens:100000,compressionThreshold:80}:m.type==='task:site-memory'?{origin:'https://example.com',version:0,notes:[]}:[]})},tabs:{query:async()=>[{id:1,url:'https://example.com',title:'示例网页'}],onUpdated:{addListener(){}},onRemoved:{addListener(){}}},storage:{onChanged:{addListener(){}}},permissions:{request:async()=>true}};});
  await options.goto(pathToFileURL(path.resolve('extension/options.html')).href);await options.locator('#status').filter({hasText:'设置已读取'}).waitFor();await options.locator('#managed-tab option').waitFor({state:'attached'});await options.screenshot({path:'tests/browser-output/options-redesign.png',fullPage:true,animations:'disabled'});
  await options.screenshot({path:'docs/assets/options-preview.png',fullPage:true,animations:'disabled'});
  for(const width of [320,390,760,1080]){
    await options.setViewportSize({width,height:900});
    const size=await options.evaluate(()=>({body:document.documentElement.scrollWidth,view:innerWidth}));
    if(size.body>size.view)throw new Error('Settings horizontal overflow at '+width);
  }
  await options.setViewportSize({width:390,height:900});
  await options.screenshot({path:'tests/browser-output/options-mobile.png',fullPage:true,animations:'disabled'});
  await options.locator('a[href="#behavior"]').click();
  if(!await options.locator('#max-steps').isVisible())throw new Error('Settings navigation target missing');
  if(new URL(options.url()).hash)throw new Error('Settings navigation changed trusted document URL');
  for(const target of [page,options]){
    await target.emulateMedia({reducedMotion:'reduce'});
    const motion=await target.evaluate(()=>[...document.querySelectorAll('header,section,form,button')].some(el=>{const css=getComputedStyle(el);return css.animationName!=='none'||css.transitionDuration.split(',').some(t=>parseFloat(t)>0);}));
    if(motion)throw new Error('Reduced-motion preference was not respected');
  }
  if(errors.length)throw new Error(errors.join('\n'));
  console.log('Both pages: responsive layout, reduced motion and no script errors verified.');
  console.log('UI screenshots saved; no horizontal overflow at 320/390/480px. Preview uses synthetic task data.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
