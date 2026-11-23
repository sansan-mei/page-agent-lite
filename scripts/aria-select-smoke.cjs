'use strict';
// Native ARIA controls with Chrome messaging stub, no framework or live model.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PAGE_AGENT_CHROMIUM});
 try{
  const page=await browser.newPage();
  await page.route('https://fixture.test/**',route=>route.fulfill({contentType:'text/html',body:'<button role="combobox" aria-label="Departure" aria-controls="from" aria-expanded="false" onclick="document.getElementById(\'from\').hidden=false;this.setAttribute(\'aria-expanded\',\'true\')">From</button><button role="combobox" aria-label="Arrival" aria-owns="to" aria-expanded="false" onclick="document.getElementById(\'to\').hidden=false;this.setAttribute(\'aria-expanded\',\'true\')">To</button><div role="listbox" id="from" hidden><button role="option" aria-selected="false" onclick="this.setAttribute(\'aria-selected\',\'true\')">Paris</button></div><div role="listbox" id="to" hidden><button role="option" aria-selected="false" onclick="this.setAttribute(\'aria-selected\',\'true\');setTimeout(()=>this.setAttribute(\'aria-selected\',\'false\'),0)">Paris</button></div>'}));
  await page.goto('https://fixture.test/');
  await page.evaluate(()=>{globalThis.chrome={runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,onMessage:{addListener(fn){globalThis.selectListener=fn;}},sendMessage:async()=>({ok:true})}};});
  for(const file of ['tool-protocol.js','conditions.js','core.js','content.js'])await page.addScriptTag({path:path.join(__dirname,'../extension',file)});
  const result=await page.evaluate(async()=>{
   const send=m=>new Promise(resolve=>selectListener(m,{id:'test',url:'chrome-extension://test/background.js'},resolve));
   const click=async(label,group,kind)=>{
    const snap=(await send({type:'agent:observe'})).value;
    const target=snap.page.elements.find(e=>e.label===label&&(!group||snap.page.groups.find(g=>g.id===e.group)?.label===group));
    return send({type:'agent:execute',snapshotId:snap.snapshotId,documentId:snap.documentId,url:snap.url,plan:{reply:'Choose',action:'click',id:target.id,expected:[{kind,id:target.id,value:true}]}});
   };
   const opened=await click('Departure',null,'expanded_equals'),otherOpened=await click('Arrival',null,'expanded_equals');
   const chosen=await click('Paris','Departure','selected_equals'),rolledBack=await click('Paris','Arrival','selected_equals');
   const final=(await send({type:'agent:observe'})).value;
   document.getElementById('from').hidden=true;
   const hidden=await send({type:'agent:verify',expected:[{kind:'selected_equals',target:{category:'element',role:'option',label:'Paris',group:'Departure'},value:true}]});
   return {opened,otherOpened,chosen,rolledBack,hidden,selected:final.page.elements.filter(e=>e.role==='option').map(e=>({group:final.page.groups.find(g=>g.id===e.group).label,selected:e.selected}))};
  });
  assert.equal(result.opened.value.status,'success');assert.equal(result.otherOpened.value.status,'success');assert.equal(result.chosen.value.status,'success');assert.equal(result.rolledBack.value.status,'not_satisfied');assert.equal(result.hidden.value.status,'unknown');assert.deepEqual(result.selected,[{group:'Departure',selected:true},{group:'Arrival',selected:false}]);
  console.log('ARIA browser checks passed: expansion, portal ownership, duplicate option groups, selection, asynchronous rollback, hidden selection stays unknown.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
