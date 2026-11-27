'use strict';
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PAGE_AGENT_CHROMIUM});
 try{
  const page=await browser.newPage();
  await page.setContent('<button style="width:200px;height:100px">Target</button><input aria-label="Text" value="keep">');
  await page.addScriptTag({path:path.join(__dirname,'../extension/core.js')});
  const result=await page.evaluate(()=>{
   const C=PageAgentCore,b=document.querySelector('button'),input=document.querySelector('input'),events=[];
   for(const type of ['click','dblclick','contextmenu','keydown','keyup'])b.addEventListener(type,e=>events.push([type,e.key,e.ctrlKey,e.button,e.isTrusted]));
   const exec=(action,value,node=b)=>{const s=C.agentSnapshot(document),id=s.page.elements.find(e=>e.label===(node===b?'Target':'Text')).id;const p=C.agentPlan(JSON.stringify({reply:'test',action,id,value}),s);return C.agentExecute(p,s,document);};
   exec('press_key','Control+a');exec('double_click');exec('right_click');exec('press_key','Tab',input);
   const value=input.value;
   const invalid=[];for(const v of ['Control+Control+a','F12','Control+script()','a+b',null]){try{exec('press_key',v);invalid.push(false);}catch{invalid.push(true);}}
   const cover=document.createElement('div');cover.style='position:fixed;inset:0;z-index:999';document.body.append(cover);
   let blocked;try{exec('right_click');}catch(e){blocked=e.code;}cover.remove();
   const before=events.length;b.addEventListener('click',()=>b.remove(),{once:true});let changed;
   try{exec('double_click');}catch(e){changed=e.code;}
   // TodoMVC: Enter adds the item and clears the input inside keydown; that is the key's effect, not a replaced target.
   const todo=document.createElement('input');todo.setAttribute('aria-label','New Todo');todo.value='milk';document.body.append(todo);
   const added=[],ups=[];todo.addEventListener('keydown',e=>{if(e.key==='Enter'){added.push(todo.value);todo.value='';}if(e.key==='Tab')input.focus();});todo.addEventListener('keyup',e=>ups.push(e.key));
   const byLabel=(label,value)=>{const s=C.agentSnapshot(document),id=s.page.elements.find(e=>e.label===label).id;return C.agentExecute(C.agentPlan(JSON.stringify({reply:'test',action:'press_key',id,value}),s),s,document);};
   const enter=byLabel('New Todo','Enter'),tab=byLabel('New Todo','Tab');
   return {events:events.slice(0,before),tail:events.slice(before),invalid,blocked,changed,value,todo:{added,value:todo.value,ups,enter,tab}};
  });
  assert.deepEqual(result.events.map(e=>e[0]),['keydown','keyup','click','click','dblclick','contextmenu']);
  assert.equal(result.events[0][1],'a');assert.equal(result.events[0][2],true);assert.equal(result.events.at(-1)[3],2);
  assert.ok(result.events.every(e=>e[4]===false));assert.equal(result.value,'keep');
  assert.deepEqual(result.invalid,[true,true,true,true,true]);assert.equal(result.blocked,'TARGET_BLOCKED');
  assert.equal(result.changed,'TARGET_CHANGED');assert.deepEqual(result.tail.map(e=>e[0]),['click']);
  assert.deepEqual(result.todo.added,['milk']);assert.equal(result.todo.value,'');assert.deepEqual(result.todo.ups,['Enter'],'keyup follows on the still-focused input; none after focus moved');
  assert.equal(result.todo.enter.key,'Enter');assert.equal(result.todo.tab.keyup,false);
  console.log('Input DOM checks passed: modifiers, double/right click, untrusted metadata, no native typing, invalid keys, cover, mid-click replacement, and key effects that clear the input or move focus.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
