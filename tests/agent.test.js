const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parseHTML}=require('linkedom');
const C=require('../extension/core.js');

test('snapshot tolerates non-string DOM reflections from list items, gauges and shadowed form properties',()=>{
 const {document}=parseHTML('<html><body><form tabindex="0" id="resume"><ul role="listbox"><li role="option">本科</li><li onclick="1">硕士</li></ul><progress tabindex="0"></progress><meter tabindex="0"></meter><input name="name" value="张三"><input name="type" value="x"><input name="value" value="y"><input type="submit" value="保存简历"><input type="radio" name="edu" value="a"><input type="radio" name="edu" value="b"></form></body></html>');
 // Browsers expose these as numbers or as the same-named child control; linkedom only models strings.
 const form=document.querySelector('form');
 for(const key of ['name','type','value'])Object.defineProperty(form,key,{configurable:true,get:()=>form.querySelector('[name="'+key+'"]')});
 for(const n of document.querySelectorAll('li,progress,meter'))Object.defineProperty(n,'value',{configurable:true,get:()=>0});
 const snap=C.agentSnapshot(document),items=snap.page.elements;
 const byTag=tag=>items.filter(e=>e.tag===tag);
 assert.equal(byTag('li').length,2);for(const e of [...byTag('li'),...byTag('progress'),...byTag('meter'),...byTag('form')])assert.equal(e.value,undefined);
 const formItem=byTag('form')[0];assert.equal(formItem.name,undefined);assert.equal(formItem.type,null);
 assert.equal(items.find(e=>e.name==='name').value,'张三');assert.equal(items.find(e=>e.type==='submit').label,'保存简历');
 const radios=items.filter(e=>e.type==='radio');assert.equal(radios.length,2);assert.equal(radios[0].group,radios[1].group);
 assert.doesNotThrow(()=>C.agentPlan(JSON.stringify({reply:'Pick',action:'click',id:byTag('li')[0].id}),snap));
});

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

test('pointer rows keep nested actions with their own interaction signal and honor visibility overrides',()=>{
 const {document,window}=parseHTML('<html><body><div id="row">期望职位<a id="add">添加</a><span id="more" aria-haspopup="menu">更多</span><span id="icon">图标</span></div><div id="ops"><button id="edit">编辑</button><button id="gone">删除</button></div></body></html>');
 const pointerIds=['row','add','more','icon'];
 window.getComputedStyle=n=>({cursor:pointerIds.includes(n.id)?'pointer':'auto',visibility:['ops','gone'].includes(n.id)?'hidden':'visible'});
 const snap=C.agentSnapshot(document);
 assert.deepEqual([...snap.nodes.values()].map(v=>v.node.id).sort(),['add','edit','more','row']);
 assert.equal(snap.page.coverage.absenceComplete,false);
 const edit=[...snap.nodes].find(([,v])=>v.node.id==='edit')[0];
 window.getComputedStyle=n=>({cursor:'auto',visibility:['ops','gone','edit'].includes(n.id)?'hidden':'visible'});
 assert.throws(()=>C.agentExecute({action:'click',id:edit},snap,document),/已隐藏/);
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

test('partly covered targets are clicked at a visible point the target owns',()=>{
 const {document,window}=parseHTML('<html><body><button>Save</button><div id="cover"></div></body></html>');
 window.innerWidth=800;window.innerHeight=600;window.MouseEvent=window.Event;const n=document.querySelector('button');
 n.getBoundingClientRect=()=>({left:0,right:100,top:0,bottom:40,width:100,height:40});
 const points=[];document.elementFromPoint=(x,y)=>{points.push([x,y]);return x===50?document.getElementById('cover'):n;};
 let clicks=0;n.addEventListener('click',()=>clicks++);
 C.agentExecute({action:'click',id:C.agentSnapshot(document).page.elements[0].id},C.agentSnapshot(document),document);
 assert.equal(clicks,1);assert.deepEqual(points[0],[50,20]);assert.ok(points.slice(1).every(([x])=>x!==50));
});

test('fully covered targets report the covering layer and its snapshot controls by stable key',()=>{
 const {document,window}=parseHTML('<html><body><form><input aria-label="开始时间"><button id="save">保存至在线简历</button></form><div id="picker" role="dialog" aria-label="选择日期"><span id="face">2024</span><button>确定</button><button disabled>清空</button></div></body></html>');
 window.innerWidth=800;window.innerHeight=600;window.MouseEvent=window.Event;
 const save=document.getElementById('save'),face=document.getElementById('face');
 save.getBoundingClientRect=()=>({left:0,right:120,top:0,bottom:30,width:120,height:30});
 const points=[];document.elementFromPoint=(x,y)=>{points.push([x,y]);return face;};
 let clicks=0;save.addEventListener('click',()=>clicks++);
 const snap=C.agentSnapshot(document),target=snap.page.elements.find(e=>e.label==='保存至在线简历');
 let thrown;assert.throws(()=>C.agentExecute({action:'click',id:target.id},snap,document),e=>(thrown=e).code==='TARGET_BLOCKED'&&e.beforeDispatch);
 assert.equal(clicks,0);assert.equal(points.length,18);
 const confirm=snap.page.elements.find(e=>e.label==='确定');
 assert.deepEqual(thrown.observed.layerControls,[{key:confirm.key,role:'button',label:'确定'}]);
 assert.equal(thrown.observed.layer.role,'dialog');assert.equal(thrown.observed.layer.label,'选择日期');
 assert.deepEqual(thrown.observed.blocker,{key:thrown.observed.layer.key,role:'dialog',label:'选择日期'});
 const result=require('../extension/tool-protocol.js').failure(thrown,{dispatch:'not_sent'});
 assert.equal(result.code,'TARGET_BLOCKED');assert.equal(result.recovery,'relocate');assert.deepEqual(result.observed,thrown.observed);
 // Keys survive re-observation, so the model can act on the reported control in the next snapshot.
 assert.equal(C.agentSnapshot(document).page.elements.find(e=>e.label==='确定').key,confirm.key);
});

test('decision schema rejects malformed options and limits new model fields',()=>{
 const snap={nodes:new Map()};
 for(const choices of [[],['only'],['x','x'],['x',3],Array(9).fill('x')])assert.throws(()=>C.agentPlan(JSON.stringify({action:'pause',reply:'选择',choices}),snap));
 assert.throws(()=>C.agentPlan(JSON.stringify({action:'observe',reply:'x',choices:['a','b']}),snap));
 assert.throws(()=>C.agentPlan(JSON.stringify({action:'pause',reply:'x',pauseReason:'anything'}),snap));
});

test('control paging and literal lookup expose late targets without inferring absence',()=>{
 const {document,window}=parseHTML('<html><body>'+Array.from({length:245},(_,i)=>`<button>Entry ${i}</button>`).join('')+'<input type="password" aria-label="Hidden secret"><button hidden>Hidden secret</button></body></html>');
 window.MouseEvent=window.Event;let clicks=0;document.querySelectorAll('button')[244].addEventListener('click',()=>clicks++);
 const first=C.agentSnapshot(document);assert.equal(first.page.elementRange.nextOffset,120);
 const second=C.agentSnapshot(document,{elementOffset:120});assert.equal(second.page.elements[0].label,'Entry 120');assert.equal(second.page.elementRange.nextOffset,240);
 const last=C.agentSnapshot(document,{elementOffset:240});assert.equal(last.page.elements.length,5);assert.equal(last.page.elementRange.nextOffset,null);assert.equal(last.page.coverage.elementsComplete,false);
 const found=C.agentSnapshot(document,{query:'ENTRY 244'});assert.equal(found.page.elements.length,1);assert.equal(found.page.elements[0].label,'Entry 244');
 C.agentExecute({action:'click',id:found.page.elements[0].id},found,document);assert.equal(clicks,1);
 const missing=C.agentSnapshot(document,{query:'Hidden secret'});assert.equal(missing.page.elementRange.total,0);
 assert.equal(require('../extension/conditions.js').evaluate([{kind:'element_absent',target:{category:'element',label:'Hidden secret'}}],missing).status,'unknown');
 assert.equal(C.agentSnapshot(document,{query:'Entry 2',elementOffset:999}).page.elements.length,0);
 for(const value of [{},{elementOffset:-1},{query:''},{query:'x'.repeat(181)},{query:'.button',selector:'button'},[],null]){
  assert.throws(()=>C.agentPlan(JSON.stringify({reply:'find',action:'observe',value}),first));
 }
 const literal=C.agentSnapshot(document,{query:'Entry .*'});assert.equal(literal.page.elements.length,0);
});

test('fill honors cancelled beforeinput and stops when event handlers replace a target',()=>{
 for(const mode of ['cancel','focus-replace','beforeinput-replace','input-replace']){
  const {document,window}=parseHTML('<html><body><input type="text" value="original"></body></html>');
  const n=document.querySelector('input');let inputs=0,changes=0;
  n.addEventListener('input',()=>inputs++);n.addEventListener('change',()=>changes++);
  const replace=()=>n.replaceWith(document.createElement('input'));
  if(mode==='cancel')n.addEventListener('beforeinput',e=>e.preventDefault());
  if(mode==='focus-replace')n.focus=replace;
  if(mode==='beforeinput-replace')n.addEventListener('beforeinput',replace);
  if(mode==='input-replace')n.addEventListener('input',replace);
  const snap=C.agentSnapshot(document);
  assert.throws(()=>C.agentExecute({action:'fill',id:'t0',value:'new'},snap,document),e=>e.code===(mode==='cancel'?'INPUT_CANCELLED':'TARGET_CHANGED'));
  assert.equal(changes,0);assert.equal(inputs,mode==='input-replace'?1:0);
  if(mode!=='input-replace')assert.equal(n.value,'original');
 }
});

test('ARIA popup groups disambiguate same-label options and owner changes stale old targets',()=>{
 const {document}=parseHTML('<html><body><div role="combobox" aria-label="Departure" aria-controls="from"></div><div role="combobox" aria-label="Arrival" aria-owns="to"></div><div role="listbox" id="from"><div role="option" aria-selected="false">Paris</div></div><div role="listbox" id="to"><div role="option" aria-selected="true">Paris</div></div></body></html>');
 const snap=C.agentSnapshot(document),options=snap.page.elements.filter(e=>e.role==='option');
 assert.deepEqual(options.map(e=>snap.page.groups.find(g=>g.id===e.group).label),['Departure','Arrival']);
 assert.ok(snap.page.regions.some(r=>r.role==='listbox'&&r.label==='Arrival'));
 document.querySelector('[aria-controls]').setAttribute('aria-controls','to');
 assert.throws(()=>C.agentExecute({action:'click',id:options[0].id},snap,document),e=>e.code==='STALE');
 const multiple=C.agentSnapshot(document),arrival=multiple.page.elements.find(e=>e.role==='option'&&e.selected);
 assert.equal(multiple.page.groups.find(g=>g.id===arrival.group).label,'');
});

test('region pages respect count and text budget and preserve incomplete coverage',()=>{
 const {document}=parseHTML('<html><body>'+Array.from({length:65},(_,i)=>`<section aria-label="Result ${i}">${'a'.repeat(1000)}</section>`).join('')+'<section hidden aria-label="Private">secret</section></body></html>');
 const first=C.agentSnapshot(document);assert.equal(first.page.regions.length,5);assert.equal(first.page.regionRange.nextOffset,5);assert.equal(first.page.regionRange.total,65);
 const second=C.agentSnapshot(document,{regionOffset:5});assert.equal(second.page.regions[0].label,'Result 5');
 const found=C.agentSnapshot(document,{regionQuery:'Result 64'});assert.equal(found.page.regions.length,1);assert.equal(found.page.regions[0].label,'Result 64');assert.equal(found.page.coverage.regionsComplete,false);
 const last=C.agentSnapshot(document,{regionOffset:64});assert.equal(last.page.regionRange.nextOffset,null);assert.equal(last.page.coverage.regionsComplete,false);
 assert.equal(C.agentSnapshot(document,{regionOffset:999}).page.regionRange.start,65);
 const hidden=C.agentSnapshot(document,{regionQuery:'Private'});assert.equal(hidden.page.regionRange.total,0);
 assert.equal(require('../extension/conditions.js').evaluate([{kind:'element_absent',target:{category:'region',label:'Private'}}],hidden).status,'unknown');
 for(const value of [{regionOffset:-1},{regionOffset:1.5},{regionQuery:''},{regionQuery:'a'.repeat(181)},{regionQuery:'Result',selector:'section'}])assert.throws(()=>C.agentPlan(JSON.stringify({reply:'read',action:'observe',value}),first));
});

test('plain editable fields use text only, preserve cancellation and refuse complex editor nodes',()=>{
 const {document}=parseHTML('<html><body><div contenteditable="true" aria-label="Editor">old<br>line</div><div contenteditable="plaintext-only" aria-label="Plain"></div><div contenteditable="true" aria-label="Complex"><span>formatted</span></div><div contenteditable="false">Read only</div></body></html>');
 let snap=C.agentSnapshot(document);const editor=snap.page.elements.find(e=>e.label==='Editor');
 assert.equal(editor.value,'old\nline');assert.equal(editor.role,'textbox');assert.equal(editor.editable,'plain_text');
 const value='<img src=x onerror=alert(1)>\nline';
 C.agentExecute({action:'fill',id:editor.id,value},snap,document);
 assert.equal(document.querySelector('img'),null);assert.equal(C.agentVerify({action:'fill',id:editor.id,value},snap).verified,true);
 assert.equal(C.agentSnapshot(document).page.elements.find(e=>e.label==='Editor').value,value);
 const complex=snap.page.elements.find(e=>e.label==='Complex'),span=document.querySelector('span');
 assert.equal(complex.editable,'unsupported_structure');assert.equal(complex.value,undefined);
 assert.throws(()=>C.agentExecute({action:'fill',id:complex.id,value:'overwrite'},snap,document),e=>e.code==='UNSUPPORTED_EDITABLE');assert.equal(span.isConnected,true);
 const plain=document.querySelector('[contenteditable="plaintext-only"]');plain.addEventListener('beforeinput',e=>e.preventDefault());snap=C.agentSnapshot(document);
 assert.throws(()=>C.agentExecute({action:'fill',id:snap.page.elements.find(e=>e.label==='Plain').id,value:'cancel'},snap,document),e=>e.code==='INPUT_CANCELLED');assert.equal(plain.textContent,'');
});

test('semantic context separates repeated controls while excluding hidden and interactive reference text',()=>{
 const {document,window}=parseHTML('<html><body><main aria-label="Account"><section><h2>Billing</h2><p id="help">Monthly <span style="display:none">css-secret</span><input value="secret">invoice</p><button aria-describedby="help private ui">Save</button><section><h3>Nested</h3><button>Save</button></section></section><section><h2>Shipping</h2><button>Save</button></section></main><p hidden id="private">hidden-secret</p><p data-page-agent id="ui">ui-secret</p></body></html>');
 window.getComputedStyle=n=>({display:n.getAttribute('style')==='display:none'?'none':'block'});
 const snap=C.agentSnapshot(document),buttons=snap.page.elements.filter(e=>e.tag==='button');
 assert.deepEqual(buttons.map(e=>e.context.path),[['Account','Billing'],['Account','Billing','Nested'],['Account','Shipping']]);
 assert.equal(buttons[0].context.description,'Monthly invoice');assert.doesNotMatch(JSON.stringify(buttons.map(e=>e.context)),/secret/);
 assert.equal(require('../extension/conditions.js').evaluate([{kind:'element_visible',target:{category:'element',label:'Save'}}],snap).status,'unknown');
 const long=parseHTML('<html><body><section aria-label="'+ 'x'.repeat(160)+'">'+Array.from({length:120},()=>'<button aria-describedby="desc">Save</button>').join('')+'</section><p id="desc">'+ 'a'.repeat(1000)+'</p></body></html>').document;
 const result=C.agentSnapshot(long);assert.ok(result.page.elements.reduce((sum,e)=>sum+(e.context?.path.join('').length||0)+(e.context?.description.length||0),0)<=4000);
});

test('controls-only observation skips body cloning and explicitly marks body text unread',()=>{
 const {document}=parseHTML('<html><body><p>'+ 'irrelevant '.repeat(3000)+'</p><button>Save</button></body></html>');
 const full=C.agentSnapshot(document);const clone=document.body.cloneNode;document.body.cloneNode=()=>{throw Error('body clone must be skipped');};
 const scoped=C.agentSnapshot(document,{query:'Save',includeText:false});document.body.cloneNode=clone;
 assert.equal(scoped.page.text,'');assert.deepEqual(scoped.page.textRange,{start:0,end:0,total:null,nextOffset:null,omitted:true});assert.equal(scoped.page.coverage.textComplete,false);assert.equal(scoped.page.truncated,true);assert.equal(scoped.page.elements[0].label,'Save');
 const P=require('../extension/prompts.js'),task={goal:'Find Save',steps:1,results:[]};
 assert.ok(P.estimateTokens(P.agentInput(task,full.page))-P.estimateTokens(P.agentInput(task,scoped.page))>3500);
 assert.equal(C.agentSnapshot(document,{includeText:true}).page.text,full.page.text);
 assert.throws(()=>C.agentPlan(JSON.stringify({reply:'Observe',action:'observe',value:{includeText:'false'}}),full));
});

test('subgoals require bounded public milestones and explicit completion checks',()=>{
 const snap={nodes:new Map()},base={reply:'Plan',action:'observe'};
 assert.equal(C.agentPlan(JSON.stringify({...base,subgoals:[{id:'read',title:'Read result',status:'active'}]}),snap).subgoals.length,1);
 for(const subgoals of [[{id:'a',title:'Done',status:'completed'}],[{id:'a',title:'X',status:'active',thoughts:'private'}],[{id:'a',title:'X',status:'active'},{id:'a',title:'Y',status:'pending'}],Array.from({length:9},(_,i)=>({id:'g'+i,title:'X',status:'pending'})),[{id:'a',title:'x'.repeat(121),status:'pending'}]])assert.throws(()=>C.agentPlan(JSON.stringify({...base,subgoals}),snap));
});

test('navigation plans reject credentials, internal schemes, relative URLs and element targets',()=>{
 const snap={nodes:new Map()};assert.equal(C.agentPlan(JSON.stringify({reply:'Open',action:'navigate',value:'https://example.test/next'}),snap).value,'https://example.test/next');
 for(const value of ['javascript:alert(1)','file:///x','chrome://settings','/next','https://user:pass@example.test/'])assert.throws(()=>C.agentPlan(JSON.stringify({reply:'Open',action:'navigate',value}),snap));
 assert.throws(()=>C.agentPlan(JSON.stringify({reply:'Open',action:'navigate',value:'https://example.test/',id:'t0'}),snap));
});

test('static tool policy cannot be mutated or expanded and backend tools never execute against DOM',()=>{
 const {document}=parseHTML('<html><body><input type="text" value="untouched"></body></html>'),snap=C.agentSnapshot(document);
 const policy=C.agentTool('click');assert.equal(Object.isFrozen(policy),true);assert.equal(policy.guard,true);
 try{policy.route='runtime';policy.guard=false;}catch{}
 assert.equal(C.agentTool('click').route,'content');assert.equal(C.agentTool('click').guard,true);
 const names=C.agentToolNames();names.push('eval');assert.equal(C.agentTool('eval'),null);
 for(const action of ['eval','constructor','__proto__','toString']){
  assert.equal(C.agentTool(action),null);assert.throws(()=>C.agentPlan(JSON.stringify({reply:'Unsupported',action,id:'t0',value:'changed'}),snap));
 }
 for(const action of ['memory_clear','site_memory_clear','verify','navigate','run_script'])assert.throws(()=>C.agentExecute({action,id:'t0',value:'changed'},snap,document),e=>e.beforeDispatch===true&&e.code==='UNSUPPORTED_ACTION');
 assert.equal(document.querySelector('input').value,'untouched');
 const prompts=require('../extension/prompts.js'),prompt=prompts.agentSystem('English');
 // run_script is listed only on turns where script execution is available.
 assert.doesNotMatch(prompt,/run_script/);
 for(const name of C.agentToolNames())assert.ok(prompts.agentSystem('English','json',{scripts:true}).includes(name));
});

test('sensitive autocomplete fields are excluded from values, labels, regions and model input',()=>{
 const {document}=parseHTML('<html><body><form><h2>Payment</h2><textarea id="otp" autocomplete="SECTION-auth ONE-TIME-CODE">PRIVATE_OTP</textarea><input autocomplete="billing cc-number" aria-label="Card" value="PRIVATE_CARD"><div contenteditable="true" autocomplete="new-password">PRIVATE_PASSWORD</div><select autocomplete="cc-csc"><option value="PRIVATE_CSC">PRIVATE_CSC</option></select><label>Normal <textarea autocomplete="current-password">PRIVATE_CURRENT</textarea><input type="text" aria-label="Public" value="safe"></label><button aria-labelledby="otp">Save</button><section aria-labelledby="otp">Normal result</section></form></body></html>');
 const snap=C.agentSnapshot(document);assert.doesNotMatch(JSON.stringify(snap.page),/PRIVATE_/);assert.equal(snap.page.elements.some(e=>e.label==='Public'&&e.value==='safe'),true);assert.equal(snap.page.coverage.sensitiveExcluded,true);assert.equal(snap.page.coverage.absenceComplete,false);
 const P=require('../extension/prompts.js');assert.doesNotMatch(P.agentInput({goal:'Read',steps:1,results:[]},snap.page),/PRIVATE_/);
 const G=require('../extension/conditions.js');assert.equal(G.evaluate([{kind:'element_absent',target:{category:'element',label:'Card'}}],snap).status,'unknown');
 const input=document.querySelector('[aria-label="Public"]'),before=C.agentSnapshot(document),target=before.page.elements.find(e=>e.label==='Public');input.setAttribute('autocomplete','one-time-code');
 assert.throws(()=>C.agentExecute({action:'fill',id:target.id,value:'changed'},before,document),e=>e.code==='STALE');assert.equal(input.value,'safe');assert.equal(C.agentVerify({action:'fill',id:target.id,value:'safe'},before).actual,undefined);
});

test('named region text segments reach the tail and never make partial absence conclusive',()=>{
 const {document}=parseHTML('<html><body><section aria-label="Report">'+ 'a'.repeat(2500)+'TAIL<textarea autocomplete="one-time-code">PRIVATE</textarea></section></body></html>');
 const first=C.agentSnapshot(document,{regionQuery:'Report',includeText:false});assert.equal(first.page.regions[0].textRange.nextOffset,1000);
 const middle=C.agentSnapshot(document,{regionQuery:'Report',regionTextOffset:1000});assert.equal(middle.page.regions[0].textRange.nextOffset,2000);
 const tail=C.agentSnapshot(document,{regionQuery:'Report',regionTextOffset:2000});assert.match(tail.page.regions[0].text,/TAIL$/);assert.equal(tail.page.regions[0].textRange.nextOffset,null);assert.equal(tail.page.regions[0].textTruncated,true);assert.doesNotMatch(JSON.stringify(tail.page),/PRIVATE/);
 const G=require('../extension/conditions.js'),check=G.bind([{kind:'text_present',id:tail.page.regions[0].id,value:'not present'}],{...tail,documentId:'doc'});assert.equal(G.evaluate(check,{...tail,documentId:'doc'}).status,'unknown');
 assert.equal(C.agentSnapshot(document,{regionQuery:'Report',regionTextOffset:999999}).page.regions[0].text,'');
 document.querySelector('section').textContent='updated';assert.equal(C.agentSnapshot(document,{regionQuery:'Report',regionTextOffset:0}).page.regions[0].text,'updated');
 for(const value of [{regionTextOffset:0},{regionTextOffset:-1,regionQuery:'Report'},{regionTextOffset:1.5,regionQuery:'Report'},{regionTextOffset:0,regionQuery:''}])assert.throws(()=>C.agentPlan(JSON.stringify({reply:'Read',action:'observe',value}),first));
});


test('sensitive inputs require snapshot authorization and file/hidden stay excluded',()=>{
 const {document}=parseHTML('<html><body><input type="password" aria-label="Password" value="secret"><input type="text" autocomplete="cc-number" aria-label="Card" value="123"><input type="file"><input type="hidden" value="hidden"></body></html>');
 assert.equal(C.agentSnapshot(document).page.elements.length,0);
 const snap=C.agentSnapshot(document,0,{sensitiveFields:true});
 assert.equal(snap.page.coverage.sensitiveFieldsAuthorized,true);
 assert.deepEqual(snap.page.elements.map(e=>e.label),['Password','Card']);
 const card=snap.page.elements.find(e=>e.label==='Card');
 C.agentExecute({action:'fill',id:card.id,value:'456'},snap,document);
 assert.equal(C.agentVerify({action:'fill',id:card.id,value:'456'},snap).verified,true);
 assert.equal(C.agentSnapshot(document).page.elements.length,0);
});
