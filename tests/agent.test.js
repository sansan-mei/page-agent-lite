const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parseHTML}=require('linkedom');
const C=require('../extension/core.js');

test('hover reveals event-driven menus without a click and rejects stale or invented targets',()=>{
 const {document}=parseHTML('<html><body><button>Menu</button><div hidden>Options</div></body></html>');
 document.defaultView.MouseEvent=document.defaultView.Event;
 const button=document.querySelector('button');let clicks=0;
 button.addEventListener('click',()=>clicks++);
 button.addEventListener('mouseenter',()=>document.querySelector('div').removeAttribute('hidden'));
 const snap=C.agentSnapshot(document),plan=C.agentPlan(JSON.stringify({reply:'Open menu',action:'hover',id:'t0'}),snap);
 C.agentExecute(plan,snap,document);
 assert.equal(clicks,0);assert.match(C.agentSnapshot(document).page.text,/Options/);
 assert.throws(()=>C.agentPlan(JSON.stringify({...plan,id:'t999'}),snap));
 button.textContent='Different';assert.throws(()=>C.agentExecute(plan,snap,document),e=>e.code==='STALE');
});

test('agent reads forms and options but excludes extension UI, passwords and hidden text',()=>{
 const {document}=parseHTML('<html><body><p>Question: 2+2?</p><input aria-label="Answer" type="text"><button>Submit</button><input type="password" value="secret"><div hidden>hidden secret</div><div data-page-agent="ui">private conversation</div></body></html>');
 const snap=C.agentSnapshot(document);
 assert.match(snap.page.text,/2\+2/);assert.doesNotMatch(snap.page.text,/secret|private conversation/);
 assert.equal(snap.page.elements.length,2);assert.equal(snap.page.elements[0].label,'Answer');
 const p=C.agentPlan('{"reply":"Fill answer","action":"fill","id":"t0","value":"4"}',snap);
 let inputs=0;document.querySelector('input').addEventListener('input',()=>inputs++);
 C.agentExecute(p,snap,document);assert.equal(document.querySelector('input').value,'4');assert.equal(inputs,1);
 assert.throws(()=>C.agentExecute(p,snap,document),/变化/);
});

test('agent rejects invented targets, executable output and stale click targets',()=>{
 const {document}=parseHTML('<html><body><button>Buy</button></body></html>');const snap=C.agentSnapshot(document);
 for(const p of [{reply:'x',action:'click',id:'t9'},{reply:'x',action:'eval',value:'alert(1)'},{reply:'x',action:'click',id:'t0',script:'evil'}])assert.throws(()=>C.agentPlan(JSON.stringify(p),snap));
 const p=C.agentPlan('{"reply":"click","action":"click","id":"t0"}',snap);
 document.querySelector('button').textContent='Delete';assert.throws(()=>C.agentExecute(p,snap,document),/变化/);
});

test('repeated true/false options expose distinct question groups and associated labels',()=>{
 const {document}=parseHTML('<html><body><fieldset><legend>第1题 天是蓝色</legend><label><input type="radio" name="q1" value="yes">对</label><label><input type="radio" name="q1" value="no">错</label></fieldset><fieldset><legend>第2题 水是固体</legend><input id="q2yes" type="radio" name="q2" value="yes"><label for="q2yes">对</label><input id="q2no" type="radio" name="q2" value="no"><label for="q2no">错</label></fieldset></body></html>');
 const snap=C.agentSnapshot(document);assert.equal(snap.page.groups.length,2);
 assert.match(snap.page.groups[0].context,/第1题/);assert.match(snap.page.groups[1].context,/第2题/);
 assert.deepEqual(snap.page.elements.map(e=>e.label),['对','错','对','错']);
 assert.notEqual(snap.page.elements[0].group,snap.page.elements[2].group);
 assert.deepEqual(snap.page.groups[1].optionIds,['t2','t3']);
});

test('verification distinguishes a selected answer, unchanged wrong answer and replaced target',()=>{
 const {document}=parseHTML('<html><body><input type="radio" name="q1"></body></html>');
 const n=document.querySelector('input');n.checked=false;
 const snap=C.agentSnapshot(document),p={action:'check',id:'t0',value:true};
 assert.equal(C.agentVerify(p,snap).verified,false);n.checked=true;assert.equal(C.agentVerify(p,snap).verified,true);
 n.remove();assert.equal(C.agentVerify(p,snap).verified,false);
});

test('memory operations validate names and bounded text, never accept scripts as actions',()=>{
 const snap={nodes:new Map()};
 assert.equal(C.agentPlan('{"reply":"记住","action":"memory_write","id":"answers","value":"对错"}',snap).id,'answers');
 for(const p of [{reply:'x',action:'memory_write',id:'../key',value:'x'},{reply:'x',action:'memory_write',id:'ok',value:'x'.repeat(2001)},{reply:'x',action:'memory_delete',id:''}])assert.throws(()=>C.agentPlan(JSON.stringify(p),snap));
});

test('custom controls expose current IDs, accessible icon names and clickable handlers',()=>{
 const {document}=parseHTML('<html><body><span id="name">保存</span><div role="link" aria-labelledby="name"></div><span tabindex="0" title="点赞"><svg></svg>12</span><div onclick="ignored()">展开</div><div tabindex="-1">普通容器</div><div hidden onclick="ignored()">隐藏</div><div data-page-agent="ui" onclick="ignored()">扩展</div></body></html>');
 const snap=C.agentSnapshot(document);
 assert.deepEqual(snap.page.elements.map(e=>e.label),['保存','点赞','展开']);
 let clicks=0;document.querySelector('[title]').addEventListener('click',()=>clicks++);
 C.agentExecute(C.agentPlan(JSON.stringify({reply:'点击',action:'click',id:'t1'}),snap),snap,document);
 assert.equal(clicks,1);
 assert.throws(()=>C.agentPlan(JSON.stringify({reply:'点击',action:'click',id:'t99'}),snap),/目标无效/);
});

test('pointer controls expose the control boundary once and preserve native buttons',()=>{
 const {document,window}=parseHTML('<html><body><div id="bar"><div id="custom" title="收藏"><span id="count">3</span></div><button id="native">分享<span id="icon">4</span></button><span id="plain">5</span></div></body></html>');
 window.getComputedStyle=n=>({cursor:['custom','count','native','icon'].includes(n.id)?'pointer':'auto'});
 const snap=C.agentSnapshot(document);
 assert.deepEqual(snap.page.elements.map(e=>e.label),['收藏','分享4']);
 let clicks=0;document.getElementById('custom').addEventListener('click',()=>clicks++);
 C.agentExecute({action:'click',id:'t0'},snap,document);assert.equal(clicks,1);
});

test('custom control extraction keeps the bounded list and reports truncation',()=>{
 const {document}=parseHTML('<html><body>'+Array.from({length:121},(_,i)=>`<span tabindex="0" title="操作${i}">${i}</span>`).join('')+'</body></html>');
 const snap=C.agentSnapshot(document);
 assert.equal(snap.page.elements.length,120);assert.equal(snap.page.coverage.elementsComplete,false);
});


test('durable memory tools validate note identifiers and bounded plain text',()=>{
 const snap={nodes:new Map()};
 assert.equal(C.agentPlan('{"reply":"save","action":"site_memory_write","id":"workflow","value":"verified"}',snap).action,'site_memory_write');
 for(const p of [{action:'site_memory_read',id:'../../x'},{action:'site_memory_delete',id:''},{action:'site_memory_write',id:'ok',value:'x'.repeat(2001)}])assert.throws(()=>C.agentPlan(JSON.stringify({reply:'test',...p}),snap));
});


test('viewport targets escape the first-120 cap while dialogs retain priority and absence stays unknown',()=>{
 const {document,window}=parseHTML('<html><body>'+Array.from({length:130},(_,i)=>`<button>Old ${i}</button>`).join('')+'<button id="later">Later</button><div role="dialog" aria-label="Confirm"><button id="confirm">Confirm</button></div></body></html>');
 window.innerWidth=800;window.innerHeight=600;
 for(const n of document.querySelectorAll('button'))n.getBoundingClientRect=()=>({left:0,right:100,top:900,bottom:930,width:100,height:30});
 const later=document.getElementById('later');later.getBoundingClientRect=()=>({left:0,right:100,top:10,bottom:40,width:100,height:30});
 const snap=C.agentSnapshot(document);
 assert.equal(snap.page.elements[0].label,'Confirm');assert.equal(snap.page.elements[1].label,'Later');
 assert.equal(snap.page.elements[1].inViewport,true);assert.equal(snap.page.coverage.elementsComplete,false);
 const G=require('../extension/conditions.js');
 assert.equal(G.evaluate([{kind:'element_absent',target:{category:'element',label:'Old 129'}}],snap).status,'unknown');
});

test('scrollable containers expose state, accept bounded directions and reject removed targets',()=>{
 const {document,window}=parseHTML('<html><body><div aria-label="Rows"></div></body></html>');
 const n=document.querySelector('div');Object.assign(n,{scrollWidth:1000,clientWidth:200,scrollHeight:1600,clientHeight:200,scrollTop:0,scrollLeft:0});
 window.getComputedStyle=()=>({overflowX:'auto',overflowY:'auto'});
 n.scrollBy=({left,top})=>{n.scrollLeft=Math.max(0,Math.min(800,n.scrollLeft+left));n.scrollTop=Math.max(0,Math.min(1400,n.scrollTop+top));};
 const snap=C.agentSnapshot(document);assert.equal(snap.page.elements[0].scroll.maxY,1400);
 const plan=C.agentPlan(JSON.stringify({reply:'Scroll rows',action:'scroll',id:'t0',value:'right'}),snap);
 const moved=C.agentExecute(plan,snap,document);assert.equal(moved.delta,600);assert.equal(n.scrollTop,0);
 assert.equal(C.agentExecute(plan,snap,document).atEnd,true);
 assert.throws(()=>C.agentPlan(JSON.stringify({...plan,id:'bad'}),snap));
 assert.throws(()=>C.agentPlan(JSON.stringify({...plan,value:'sideways'}),snap));
 n.remove();assert.throws(()=>C.agentExecute(plan,snap,document),/变化/);
});

test('custom combobox state and visible popup context are read, expansion invalidates old actions',()=>{
 const {document}=parseHTML('<html><body><div role="combobox" aria-label="City" aria-expanded="false" aria-controls="choices"></div><div id="choices" role="listbox" aria-label="Cities"><div role="option" aria-selected="true">Paris</div></div></body></html>');
 const snap=C.agentSnapshot(document),combo=snap.page.elements.find(e=>e.role==='combobox');
 assert.equal(combo.expanded,false);assert.deepEqual(combo.controlledLabels,['Cities']);
 assert.equal(snap.page.elements.find(e=>e.role==='option').selected,true);
 document.querySelector('[role="combobox"]').setAttribute('aria-expanded','true');
 assert.throws(()=>C.agentExecute({action:'click',id:combo.id},snap,document),/变化/);
});

test('occluded targets are rejected before click or pointer events are emitted',()=>{
 const {document,window}=parseHTML('<html><body><button>Save</button><div id="cover"></div></body></html>');
 window.innerWidth=800;window.innerHeight=600;const n=document.querySelector('button');
 n.getBoundingClientRect=()=>({left:0,right:100,top:0,bottom:30,width:100,height:30});
 document.elementFromPoint=()=>document.getElementById('cover');let clicks=0;n.addEventListener('click',()=>clicks++);
 const snap=C.agentSnapshot(document);
 assert.throws(()=>C.agentExecute({action:'click',id:'t0'},snap,document),e=>e.code==='TARGET_BLOCKED'&&e.beforeDispatch);
 assert.equal(clicks,0);
});

test('decision schema rejects malformed options and limits new model fields',()=>{
 const snap={nodes:new Map()};
 for(const choices of [[],['only'],['x','x'],['x',3],Array(9).fill('x')])assert.throws(()=>C.agentPlan(JSON.stringify({action:'pause',reply:'选择',choices}),snap));
 assert.throws(()=>C.agentPlan(JSON.stringify({action:'observe',reply:'x',choices:['a','b']}),snap));
 assert.throws(()=>C.agentPlan(JSON.stringify({action:'pause',reply:'x',pauseReason:'anything'}),snap));
});
