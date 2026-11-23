(function(root){
'use strict';
function endpoint(value){
 if(typeof value!=='string'||/[?#]/.test(value))throw new Error('API 地址不能包含查询或片段');
 let u; try{u=new URL(value);}catch{throw new Error('API 地址无效');}
 if((u.protocol!=='https:' && !(u.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(u.hostname))) || u.username || u.password || u.search || u.hash) throw new Error('仅支持 HTTPS 或本机 HTTP，不能包含凭据、查询或片段');
 return u.href.replace(/\/+$/,'');
}
const excluded='form,input,textarea,select,button,a,[contenteditable]:not([contenteditable="false"]),[role="textbox"],script,style,nav,header,footer,aside,[hidden],[aria-hidden="true"],[data-page-agent]';
function safe(el){return !!el && !el.closest(excluded);}
function cleanText(el,max=12000){const c=el.cloneNode(true);for(const n of c.querySelectorAll(excluded))n.remove();return (c.textContent||'').replace(/\s+/g,' ').trim().slice(0,max);}
function collect(doc){
 const nodes=new Map(),outline=[];let size=0;
 for(const el of doc.querySelectorAll('h1,h2,h3,p,li,blockquote')){
  if(!safe(el)||el.querySelector('p,li,blockquote'))continue;
  const text=cleanText(el,500);if(!text)continue;
  if(outline.length>=60||size+text.length>12000)break;
  const id='e'+outline.length;nodes.set(id,el);outline.push({id,tag:el.localName,text});size+=text.length;
 }
 return {nodes,outline};
}
function validStyle(p,v){
 if(typeof v!=='string'||v.length>32)return false;
 if(['color','background-color'].includes(p))return /^#[0-9a-f]{6}$/i.test(v);
 if(p==='font-size')return /^(1[2-9]|[2-3][0-9]|40)px$/.test(v);
 if(p==='line-height')return /^(1\.[2-9]|2(?:\.0)?)$/.test(v);
 if(p==='font-weight')return /^(400|500|600|700)$/.test(v);
 if(p==='text-align')return /^(left|center|right|justify)$/.test(v);
 return false;
}
function proposal(raw,snap){
 if(typeof raw!=='string'||raw.length>16000)throw new Error('修改建议过大');
 let data;try{data=JSON.parse(raw);}catch{throw new Error('模型未返回严格 JSON，请重试');}
 if(!data||Object.keys(data).join()!=='operations'||!Array.isArray(data.operations)||data.operations.length>30)throw new Error('修改格式无效');
 for(const op of data.operations){
  if(!op||!snap.nodes.has(op.id)||!safe(snap.nodes.get(op.id)))throw new Error('目标无效');
  const keys=Object.keys(op).sort().join();
  if(op.action==='hide'&&keys==='action,id')continue;
  if(op.action==='style'&&keys==='action,id,property,value'&&validStyle(op.property,op.value))continue;
  throw new Error('拒绝不安全的修改');
 }
 return data.operations;
}
function apply(ops,snap){
 proposal(JSON.stringify({operations:ops}),snap);
 for(const op of ops)if(!snap.nodes.get(op.id).isConnected)throw new Error('页面已变化，请重新生成建议');
 const saved=new Map();for(const op of ops){const el=snap.nodes.get(op.id);if(!saved.has(el))saved.set(el,el.getAttribute('style'));el.style.setProperty(op.action==='hide'?'display':op.property,op.action==='hide'?'none':op.value,'important');}
 return ()=>{for(const [el,style]of saved)style===null?el.removeAttribute('style'):el.setAttribute('style',style);};
}
function children(el){return [...el.children].filter(n=>!n.hasAttribute('data-page-agent'));}
function describe(el){
 if(!safe(el)||!['p','h1','h2','h3','li','blockquote'].includes(el.localName))throw new Error('请选择普通文章段落');
 const text=cleanText(el,4001);if(!text||text.length>4000)throw new Error('段落过长或为空');
 const path=[];let n=el;while(n!==el.ownerDocument.body){if(!n.parentElement||path.length>=20)throw new Error('目标结构不支持');path.unshift(children(n.parentElement).indexOf(n));n=n.parentElement;}
 const target={path,tag:el.localName,text};if(resolve(el.ownerDocument,target)!==el)throw new Error('目标不唯一，无法安全保存');return target;
}
function validTarget(t){return t&&Object.keys(t).sort().join()==='path,tag,text'&&Array.isArray(t.path)&&t.path.length>0&&t.path.length<=20&&t.path.every(i=>Number.isInteger(i)&&i>=0&&i<10000)&&/^(p|h[1-3]|li|blockquote)$/.test(t.tag)&&typeof t.text==='string'&&t.text.length>0&&t.text.length<=4000;}
function resolve(doc,t){
 if(!validTarget(t))return null;
 let el=doc.body;for(const i of t.path){el=el&&children(el)[i];if(!el)return null;}
 if(!safe(el)||el.localName!==t.tag||cleanText(el,4001)!==t.text)return null;
 const matches=[...doc.querySelectorAll(t.tag)].filter(n=>safe(n)&&cleanText(n,4001)===t.text);return matches.length===1?el:null;
}
function validRecord(r){
 if(!r||!validTarget(r.target))return false;
 if(['translation','summary'].includes(r.kind))return Object.keys(r).sort().join()==='kind,target,text'&&typeof r.text==='string'&&r.text.length>0&&r.text.length<=12000;
 if(r.kind!=='edit')return false;
 return r.action==='hide'?Object.keys(r).sort().join()==='action,kind,target':Object.keys(r).sort().join()==='action,kind,property,target,value'&&r.action==='style'&&validStyle(r.property,r.value);
}
function restore(doc,records){
 const undos=[];let skipped=0;
 for(const r of records){const el=validRecord(r)&&resolve(doc,r.target);if(!el){skipped++;undos.push(null);continue;}
  if(r.kind==='edit'){const op={id:'e',action:r.action};if(r.action==='style')Object.assign(op,{property:r.property,value:r.value});undos.push(apply([op],{nodes:new Map([['e',el]])}));}
  else {const box=doc.createElement('section');box.setAttribute('data-page-agent',r.kind);box.textContent=r.text;box.style.cssText='display:block!important;white-space:pre-wrap!important;padding:12px!important;border:1px solid #718096!important;background:#f0f7ff!important;color:#17202a!important;font:16px/1.6 system-ui!important;';if(r.kind==='summary')el.before(box);else el.after(box);undos.push(()=>box.remove());}
 }
 return {undos,skipped};
}
function siteOrigin(value){
 if(typeof value!=='string'||/[?#]/.test(value))throw new Error('站点源不能包含查询或片段');
 let u;try{u=new URL(value);}catch{throw new Error('站点源无效');}
 if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw new Error('请输入 HTTP/HTTPS 站点源，不带路径、凭据、查询或片段');
 return u.origin;
}
function byteSize(text){return encodeURIComponent(text).replace(/%[0-9A-F]{2}/g,'x').length;}
// Agent targets are ephemeral references, never model-provided selectors or scripts.
const agentNodeKeys=new WeakMap();let agentNodeCounter=0;
function agentNodeKey(node){if(!agentNodeKeys.has(node))agentNodeKeys.set(node,'node'+(++agentNodeCounter));return agentNodeKeys.get(node);}
function agentSnapshot(doc){
 const nodes=new Map(), elements=[],regions=[],groups=[],groupNodes=new Map();let contextBudget=5000,elementsComplete=true,regionsComplete=true,cssHiddenExcluded=false;
 const blocked='[data-page-agent],script,style,noscript,[hidden],[aria-hidden="true"],input[type="password"],input[type="file"],input[type="hidden"]';
 const visible=n=>{if(n.closest(blocked)||n.closest('dialog:not([open])'))return false;const win=doc.defaultView;for(let p=n;p;p=p.parentElement){const s=win?.getComputedStyle?.(p);if(s&&(s.display==='none'||s.visibility==='hidden'))return false;}return true;};
 const dialogSelector='dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"]';
 const inDialog=n=>!!n.closest(dialogSelector);
 const prioritize=items=>[...items].sort((a,b)=>Number(inDialog(b))-Number(inDialog(a)));
 const copy=doc.body.cloneNode(true);for(const n of copy.querySelectorAll(blocked))n.remove();
 const text=(copy.innerText||copy.textContent||'').replace(/\s+/g,' ').trim().slice(0,16000);
 // Include custom controls without relying on site-specific classes or executing handlers.
 const controls='button,a[href],input,textarea,select,[role="button"],[role="radio"],[role="checkbox"],[role="link"],[role="menuitem"],[role="switch"],[onclick],[tabindex]';
 const explicit=n=>n.matches(controls)&&(n.getAttribute('tabindex')===null||Number(n.getAttribute('tabindex'))>=0||n.matches(controls.replace(',[tabindex]','')));
 const cursors=new Map();
 const pointer=n=>{if(!n)return false;if(!cursors.has(n))cursors.set(n,doc.defaultView?.getComputedStyle?.(n)?.cursor);return cursors.get(n)==='pointer';};
 for(const n of prioritize(doc.querySelectorAll('*'))){
  const direct=explicit(n);
  if(!direct){
   // A pointer cursor is inherited: expose its boundary, not every icon/count child.
   if(!pointer(n)||n===doc.body||n===doc.documentElement||pointer(n.parentElement)||n.closest(controls)||n.querySelector(controls))continue;
  }
  if(!visible(n)){if(!n.closest(blocked))cssHiddenExcluded=true;continue;}if(elements.length>=120){elementsComplete=false;break;}
  const id='t'+elements.length;
  const associated=[...(n.labels||[])];
  if(n.closest('label'))associated.push(n.closest('label'));
  if(n.id)for(const l of doc.querySelectorAll('label[for]'))if(l.htmlFor===n.id||l.getAttribute('for')===n.id)associated.push(l);
  const labelled=n.getAttribute('aria-labelledby')?.split(/\s+/).map(id=>doc.getElementById(id)?.textContent||'').join(' ').trim();
  const label=(n.getAttribute('aria-label')||labelled||[...new Set(associated)].map(l=>l.textContent).join(' ').trim()||n.getAttribute('title')||(['submit','button','reset'].includes(n.type)?n.value:'')||n.textContent||n.getAttribute('placeholder')||n.name||'').trim().slice(0,180);
  let container=n.closest('fieldset,[role="radiogroup"],[role="group"],form,dialog,[role="dialog"],[role="alertdialog"],[data-question-id],.question,.question-item,.ques-item');
  container=n.closest(dialogSelector)||container;
  if(!container&&['radio','checkbox'].includes(n.type)){
   for(let p=n.parentElement,depth=0;p&&p!==doc.body&&depth<6;p=p.parentElement,depth++){
    const choices=[...p.querySelectorAll('input[type="radio"],input[type="checkbox"]')];
    if(choices.length>=2&&choices.every(c=>!n.name||c.name===n.name)){container=p;break;}
   }
  }
  let group;
  if(container){
   group=groupNodes.get(container);
   if(!group){
    const c=container.cloneNode(true);for(const x of c.querySelectorAll(blocked))x.remove();
    const context=(c.textContent||'').replace(/\s+/g,' ').trim().slice(0,Math.min(500,contextBudget));contextBudget-=context.length;
    const heading=container.querySelector('legend,h1,h2,h3,h4,[role="heading"]');
    const groupLabel=(container.getAttribute('aria-label')||container.getAttribute('aria-labelledby')?.split(/\s+/).map(id=>doc.getElementById(id)?.textContent||'').join(' ')||heading?.textContent||(inDialog(container)?context:'')).trim().slice(0,180);
    group={id:'g'+groups.length,label:groupLabel,context,optionIds:[]};groupNodes.set(container,group);groups.push(group);
   }
   group.optionIds.push(id);
  }
  const options=n.localName==='select'?[...n.options].map(o=>({value:o.value,label:o.textContent.slice(0,100)})).slice(0,40):undefined;
  const role=n.getAttribute('role')||({button:'button',a:'link',select:'combobox',textarea:'textbox'}[n.localName])||(['radio','checkbox'].includes(n.type)?n.type:n.localName==='input'?'textbox':'button');
  const ariaChecked=n.getAttribute('aria-checked');
  elements.push({id,key:agentNodeKey(n),tag:n.localName,role,type:n.type||n.getAttribute('role'),name:n.name?.slice(0,100),group:group?.id,label,visible:visible(n),disabled:!!n.disabled||!!n.closest('[aria-disabled="true"],fieldset[disabled]'),value:n.value?.slice(0,4000),checked:typeof n.checked==='boolean'?n.checked:ariaChecked==='true'?true:ariaChecked==='false'?false:undefined,options});
  nodes.set(id,{node:n,signature:agentSignature(n)});
 }
 let regionBudget=5000;
 for(const n of prioritize(doc.querySelectorAll('main,section,article,fieldset,form,dialog,[role="status"],[role="alert"],[role="dialog"],[role="alertdialog"],[role="region"],[role="list"],[role="table"]'))){
  if(!visible(n)){if(!n.closest(blocked))cssHiddenExcluded=true;continue;}if(regions.length>=40||regionBudget<=0){regionsComplete=false;break;}
  const copy=n.cloneNode(true);for(const x of copy.querySelectorAll(blocked))x.remove();
  const raw=(copy.innerText||copy.textContent||'').replace(/\s+/g,' ').trim();
  const heading=n.querySelector('legend,h1,h2,h3,h4,[role="heading"]');
  const labelled=n.getAttribute('aria-labelledby')?.split(/\s+/).map(id=>doc.getElementById(id)?.textContent||'').join(' ');
  const id='r'+regions.length,label=(n.getAttribute('aria-label')||labelled||heading?.textContent||'').trim().slice(0,180);
  const limit=Math.min(1000,regionBudget),regionText=raw.slice(0,limit);regionBudget-=regionText.length;
  regions.push({id,key:agentNodeKey(n),tag:n.localName,role:n.getAttribute('role')||n.localName,label,text:visible(n)?regionText:'',textTruncated:raw.length>limit,visible:visible(n)});
  nodes.set(id,{node:n,signature:agentSignature(n)});
 }
 const hiddenExcluded=cssHiddenExcluded||!!doc.querySelector('[hidden],[aria-hidden="true"]');
 return {nodes,page:{title:doc.title,scrollY:doc.defaultView?.scrollY||0,text,truncated:text.length===16000||!elementsComplete||!regionsComplete,elements,groups,regions,coverage:{elementsComplete,regionsComplete,textComplete:text.length<16000,absenceComplete:!hiddenExcluded}}};
}
function agentVerify(plan,snap){
 if(!['fill','check','select'].includes(plan.action))return null;
 const n=snap.nodes.get(plan.id)?.node;
 if(!n?.isConnected)return {verified:false,message:'操作后目标被替换，尚未核实结果，需重新读取页面'};
 const actual=plan.action==='check'?n.checked:n.value;
 const verified=actual===plan.value;
 return {verified,actual,message:verified?'已核对目标字段状态与本次指定值一致':'实际字段状态与指定值不一致，操作未生效；需重新读取并修正'};
}
function agentSignature(n){return JSON.stringify([n.localName,n.type,n.getAttribute('aria-label'),n.textContent,n.getAttribute('href'),n.name,n.value,n.checked,n.disabled]);}
function agentPlan(raw,snap){
 let p;try{p=JSON.parse(raw);}catch{throw new Error('模型未返回有效操作 JSON，请重试');}
 if(!p||typeof p.reply!=='string'||p.reply.length>4000||!['done','pause','observe','verify','wait','click','fill','check','select','scroll','memory_read','memory_write','memory_delete','memory_clear','history_read','site_memory_read','site_memory_write','site_memory_delete','site_memory_clear'].includes(p.action)||Object.keys(p).some(k=>!['reply','action','id','value','expected','timeoutMs'].includes(k)))throw new Error('模型操作格式无效');
 if(p.expected!==undefined){const G=typeof module!=='undefined'?require('./conditions.js'):root.PageAgentConditions;G.validate(p.expected);}
 if(['verify','wait'].includes(p.action)&&!p.expected)throw new Error('等待或验证需要明确条件');
 if(p.timeoutMs!==undefined&&(!Number.isInteger(p.timeoutMs)||p.timeoutMs<100||p.timeoutMs>30000||!['wait','click','fill','check','select','scroll'].includes(p.action)))throw new Error('等待时间需为 100–30000 毫秒');
 if(['memory_write','memory_delete','site_memory_write','site_memory_delete','site_memory_read'].includes(p.action)&&(typeof p.id!=='string'||! /^[a-zA-Z0-9_-]{1,60}$/.test(p.id)))throw new Error('记忆名称无效');
 if(p.action==='history_read'&&(typeof p.id!=='string'||!/^h[0-9]+$/.test(p.id)||(p.value!==undefined&&(!Number.isSafeInteger(p.value)||p.value<0))))throw new Error('历史记录读取参数无效');
 if(['memory_write','site_memory_write'].includes(p.action)&&(typeof p.value!=='string'||!p.value.trim()||p.value.length>2000))throw new Error('记忆内容无效或超过 2000 字符');
 if(['click','fill','check','select'].includes(p.action)&&!snap.nodes.has(p.id))throw new Error('操作目标无效');
 if(['fill','select'].includes(p.action)&&(typeof p.value!=='string'||p.value.length>4000))throw new Error('填写内容无效');
 if(p.action==='check'&&typeof p.value!=='boolean')throw new Error('勾选状态无效');
 if(p.action==='scroll'&&!['up','down'].includes(p.value))throw new Error('滚动方向无效');
 return p;
}
function agentExecute(p,snap,doc){
 if(p.action==='done')return;
 if(p.action==='scroll'){doc.defaultView.scrollBy(0,p.value==='up'?-600:600);return;}
 const ref=snap.nodes.get(p.id),n=ref?.node;
 if(!n?.isConnected||agentSignature(n)!==ref.signature||n.disabled||n.closest('[hidden],[aria-hidden="true"],[aria-disabled="true"],fieldset[disabled],[data-page-agent]'))throw Object.assign(new Error('页面目标已变化，请重新发送指令'),{code:'STALE'});
 const win=doc.defaultView;
 for(let p=n;p;p=p.parentElement){const s=win?.getComputedStyle?.(p);if(s&&(s.display==='none'||s.visibility==='hidden'))throw Object.assign(new Error('页面目标已隐藏，请重新定位'),{code:'STALE'});}
 if(p.action==='click'){n.click();return;}
 if(p.action==='check'){
  if(n.localName!=='input'||!['checkbox','radio'].includes(n.type))throw new Error('目标不是可勾选选项');
  if(n.type==='radio'&&!p.value)throw new Error('不能直接取消单选项');
  if(n.checked!==p.value)n.click();return;
 }
 if(n.readOnly)throw new Error('目标为只读字段');
 if(p.action==='fill'&&!(n.localName==='textarea'||n.localName==='input'&&['text','search','email','tel','url','number','date','time','datetime-local','month','week'].includes(n.type)))throw new Error('目标不是支持的文本字段');
 if(p.action==='select'&&(n.localName!=='select'||![...n.options].some(o=>o.value===p.value&&!o.disabled)))throw new Error('下拉选项无效');
 const proto=n.localName==='textarea'?win.HTMLTextAreaElement?.prototype:n.localName==='select'?win.HTMLSelectElement?.prototype:win.HTMLInputElement?.prototype;
 const setter=proto&&Object.getOwnPropertyDescriptor(proto,'value')?.set;
 if(setter)setter.call(n,p.value);else n.value=p.value;
 n.dispatchEvent(new win.Event('input',{bubbles:true}));n.dispatchEvent(new win.Event('change',{bubbles:true}));
}
const api={endpoint,siteOrigin,byteSize,safe,cleanText,collect,validStyle,proposal,apply,describe,resolve,validRecord,restore,agentSnapshot,agentPlan,agentExecute,agentVerify};
root.PageAgentCore=api;
if(typeof module!=='undefined')module.exports=api;
})(globalThis);
