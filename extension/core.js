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
// Static trusted policy only: no registration hooks, model handlers or page callbacks.
const agentToolRegistry=(()=>{
 const records=Object.create(null);
 const add=(names,policy)=>{for(const name of names)records[name]=Object.freeze({route:'runtime',effect:'read',target:'none',timeout:false,guard:false,...policy});};
 add(['done','pause','request_sensitive_access'],{effect:'control'});
 add(['observe','verify','history_read'],{});add(['wait'],{timeout:true});
 add(['click','fill','check','select','wheel','press_key','double_click','right_click'],{route:'content',effect:'page',target:'required',timeout:true,guard:true});
 add(['hover'],{route:'content',effect:'page',target:'required',timeout:true});
 add(['scroll'],{route:'content',effect:'page',target:'optional',timeout:true});
 add(['navigate'],{route:'browser',effect:'page',timeout:true});
 // Task tabs: refs come only from the task member directory; handled by the runtime, never by the page.
 add(['tab_switch'],{});add(['tab_open','tab_close'],{route:'browser',effect:'tab'});
 for(const prefix of ['site_memory','global_memory']){
  add([prefix+'_read'],{});add([prefix+'_write',prefix+'_delete',prefix+'_clear'],{effect:'storage'});
 }
 // run_script: script-tools.js is loaded before core.js by the service worker only (content scripts
 // never load it, so the page executor refuses the action); the registry is still frozen afterwards.
 const scripts=typeof module!=='undefined'?require('./script-tools.js'):root.PageAgentScriptTools;if(scripts?.registry)for(const name of Object.keys(scripts.registry))if(!records[name])add([name],scripts.registry[name]);
 return Object.freeze(records);
})();
function agentTool(name){return typeof name==='string'&&Object.prototype.hasOwnProperty.call(agentToolRegistry,name)?agentToolRegistry[name]:null;}
function agentToolNames(){return Object.keys(agentToolRegistry);}
const agentSensitiveSelector=['current-password','new-password','one-time-code','cc-number','cc-csc'].map(token=>'[autocomplete~="'+token+'" i]').concat(['input[type="password"]','input[type="file"]','input[type="hidden"]']).join(',');
function agentText(n){
 if(!n||n.closest(agentSensitiveSelector+',script,style,noscript,[hidden],[aria-hidden="true"],[data-page-agent]'))return '';
 const copy=n.cloneNode(true);for(const child of copy.querySelectorAll(agentSensitiveSelector+',script,style,noscript,[hidden],[aria-hidden="true"],[data-page-agent]'))child.remove();
 return copy.textContent||'';
}
// DOM reflections are not always strings: li/progress/meter values are numbers, and a form's name/type/id/value
// can be shadowed by a same-named control. Snapshot fields read through this so page markup cannot crash a read.
function agentString(v){return typeof v==='string'?v:undefined;}
// Agent targets are ephemeral references, never model-provided selectors or scripts.
const agentNodeKeys=new WeakMap();let agentNodeCounter=0;
function agentNodeKey(node){if(!agentNodeKeys.has(node))agentNodeKeys.set(node,'node'+(++agentNodeCounter));return agentNodeKeys.get(node);}
// Same-origin iframes are read one level below the top document only. Each frame document maps back to its
// iframe element so geometry, hit tests and liveness checks can cross exactly that boundary.
const agentFrames=new WeakMap();
function agentFrame(doc){return doc&&agentFrames.get(doc)||null;}
function agentLive(n){if(!n?.isConnected)return false;const f=agentFrame(n.ownerDocument);return !f||f.isConnected&&f.contentDocument===n.ownerDocument;}
function agentFrameOffset(f){const r=f.getBoundingClientRect(),s=f.ownerDocument.defaultView?.getComputedStyle?.(f);return {x:r.left+(f.clientLeft||0)+(parseFloat(s?.paddingLeft)||0),y:r.top+(f.clientTop||0)+(parseFloat(s?.paddingTop)||0)};}
// Visible box in top viewport coordinates: own viewport, overflow ancestors and, inside a frame, the iframe's visible box.
function agentVisibleRect(n){
 const r=n.getBoundingClientRect?.(),win=n.ownerDocument?.defaultView;
 if(!r||!Number.isFinite(win?.innerHeight)||!Number.isFinite(win?.innerWidth))return null;
 let left=Math.max(0,r.left),top=Math.max(0,r.top),right=Math.min(win.innerWidth,r.right),bottom=Math.min(win.innerHeight,r.bottom);
 for(let p=n.parentElement;p;p=p.parentElement){const style=win.getComputedStyle?.(p),box=p.getBoundingClientRect?.();if(!box)continue;if(/auto|scroll|hidden|clip/.test(style?.overflowX)){left=Math.max(left,box.left);right=Math.min(right,box.right);}if(/auto|scroll|hidden|clip/.test(style?.overflowY)){top=Math.max(top,box.top);bottom=Math.min(bottom,box.bottom);}}
 const f=agentFrame(n.ownerDocument);
 if(f){const o=agentFrameOffset(f),outer=agentVisibleRect(f);if(!outer)return null;left=Math.max(outer.left,left+o.x);top=Math.max(outer.top,top+o.y);right=Math.min(outer.right,right+o.x);bottom=Math.min(outer.bottom,bottom+o.y);}
 return {left,top,right,bottom,width:r.width,height:r.height};
}
function agentGeometry(n){const b=agentVisibleRect(n);return b&&{inViewport:b.width>0&&b.height>0&&b.right>b.left&&b.bottom>b.top};}
// Read same-origin frames one level deep (at most 10); list cross-origin, nested, loading or over-limit frames as not read.
function agentFrameScan(doc,visible){
 const frames=[],docs=new Map(),origin=d=>d?.defaultView?.origin;let complete=true,count=0;
 const scan=(d,nested)=>{for(const f of d.querySelectorAll('iframe,frame')){
  if(!visible(f))continue;
  let fd=null;try{fd=f.contentDocument;}catch{}
  const src=(f.getAttribute('src')||'').trim(),box=f.getBoundingClientRect?.();
  const reason=nested?'nested':!fd||origin(fd)&&origin(doc)&&origin(fd)!==origin(doc)?'cross_origin':fd.readyState==='loading'||!fd.body||src&&!/^about:/i.test(src)&&fd.URL==='about:blank'?'loading':docs.size>=10?'limit':null;
  if(reason&&box&&box.width*box.height<4)continue;// zero-size trackers hold nothing readable
  const entry={id:'f'+count++,key:agentNodeKey(f),label:(f.getAttribute('title')||f.getAttribute('aria-label')||f.getAttribute('name')||'').trim().slice(0,100),read:!reason,reason:reason||undefined};
  if(reason)complete=false;
  if(!reason||frames.length<20)frames.push(entry);
  if(!reason){agentFrames.set(fd,f);docs.set(f,{doc:fd,entry});}
 }};
 scan(doc,false);for(const f of [...docs.values()])scan(f.doc,true);
 return {frames,docs,complete};
}
function agentScrollInfo(n){
 const x=Math.max(0,(n.scrollWidth||0)-(n.clientWidth||0)),y=Math.max(0,(n.scrollHeight||0)-(n.clientHeight||0));
 return {x:n.scrollLeft||0,y:n.scrollTop||0,maxX:x,maxY:y};
}
// ARIA popup ownership is reference data, never an instruction or a selector from the model.
// Only plain text and bare line breaks are replaceable without destroying editor nodes.
function agentEditable(n){
 const mode=n.getAttribute('contenteditable');
 if(mode===null||!['','true','plaintext-only'].includes(mode.toLowerCase()))return null;
 const parts=[...n.childNodes],supported=parts.every(c=>c.nodeType===3||c.nodeType===1&&c.localName==='br'&&!c.attributes.length);
 return {supported,value:supported?parts.map(c=>c.nodeType===3?c.textContent:'\n').join(''):undefined};
}
// visibility is inherited and a descendant may set it back to visible; display:none hides the whole subtree.
function agentHidden(n,win){
 const own=win?.getComputedStyle?.(n);
 if(own&&(own.visibility==='hidden'||own.visibility==='collapse'))return true;
 for(let p=n;p;p=p.parentElement){const s=p===n?own:win?.getComputedStyle?.(p);if(s?.display==='none')return true;}
 return false;
}
function agentPopup(n){
 const popup=n.closest('[role="listbox"]');if(!popup)return null;
 const owners=popup.id?[...n.ownerDocument.querySelectorAll('[role="combobox"][aria-controls],[role="combobox"][aria-owns]')].filter(c=>{if(c.closest('[hidden],[aria-hidden="true"],[data-page-agent],input[type="password"],input[type="hidden"]'))return false;return !agentHidden(c,n.ownerDocument.defaultView);}).filter(c=>[c.getAttribute('aria-controls'),c.getAttribute('aria-owns')].filter(Boolean).join(' ').split(/\s+/).includes(popup.id)):[];
 const owner=owners.length===1?owners[0]:null;
 const label=owner?(owner.getAttribute('aria-label')||owner.getAttribute('aria-labelledby')?.split(/\s+/).map(id=>agentText(n.ownerDocument.getElementById(id))).join(' ')||owner.getAttribute('title')||owner.getAttribute('placeholder')||owner.getAttribute('name')||'').trim().slice(0,180):'';
 return {popup,label,signature:[label,agentNodeKey(popup),popup.id,popup.getAttribute('aria-label'),popup.getAttribute('aria-labelledby'),owners.map(c=>[agentNodeKey(c),c.getAttribute('aria-label'),c.getAttribute('aria-controls'),c.getAttribute('aria-owns')])]};
}
function agentContext(n){
 const doc=n.ownerDocument,win=doc.defaultView;
 const blocked=agentSensitiveSelector+',[hidden],[aria-hidden="true"],[data-page-agent],script,style,noscript,input,textarea,select,[contenteditable]';
 const readable=e=>{if(!e||e.closest(blocked)||e.closest('dialog:not([open])'))return false;return !agentHidden(e,win);};
 const text=e=>{
  let value='',visited=0;
  const read=node=>{if(++visited>300||value.length>=160)return;if(node.nodeType===3){value+=node.textContent;return;}if(node.nodeType!==1||!readable(node))return;for(const child of node.childNodes)read(child);};
  if(readable(e))read(e);return value.replace(/\s+/g,' ').trim().slice(0,160);
 };
 const refs=(e,attribute)=>[...new Set((e.getAttribute(attribute)||'').split(/\s+/))].filter(Boolean).slice(0,5).map(id=>text(doc.getElementById(id))).filter(Boolean).join(' ').slice(0,300);
 const scope='section,article,main,fieldset,form,dialog,[role="region"],[role="group"],[role="dialog"]',path=[];
 for(let parent=n.parentElement;parent&&path.length<3;parent=parent.parentElement){
  if(!parent.matches(scope)||!readable(parent))continue;
  const heading=[...parent.querySelectorAll('legend,h1,h2,h3,h4,h5,h6,[role="heading"]')].find(h=>h.closest(scope)===parent&&readable(h));
  const label=(parent.getAttribute('aria-label')||refs(parent,'aria-labelledby')||text(heading)).trim().slice(0,160);
  if(label&&!path.includes(label))path.push(label);
 }
 return {path:path.reverse(),description:refs(n,'aria-describedby')};
}
function agentReadOptions(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||!Object.keys(value).length||Object.keys(value).some(k=>!['elementOffset','query','regionOffset','regionQuery','regionTextOffset','includeText'].includes(k))||value.regionTextOffset!==undefined&&(!Number.isSafeInteger(value.regionTextOffset)||value.regionTextOffset<0||typeof value.regionQuery!=='string'||!value.regionQuery.trim())||value.includeText!==undefined&&typeof value.includeText!=='boolean'||value.elementOffset!==undefined&&(!Number.isSafeInteger(value.elementOffset)||value.elementOffset<0)||value.regionOffset!==undefined&&(!Number.isSafeInteger(value.regionOffset)||value.regionOffset<0)||value.regionQuery!==undefined&&(typeof value.regionQuery!=='string'||!value.regionQuery.trim()||value.regionQuery.length>180)||value.query!==undefined&&(typeof value.query!=='string'||!value.query.trim()||value.query.length>180))throw new Error('Invalid element reading scope');
 return value;
}
function agentSnapshot(doc, textOffset=0, policy={}){
 const sensitiveSelector=policy.sensitiveFields===true?'input[type="file"],input[type="hidden"]':agentSensitiveSelector;
 const reading=typeof textOffset==='object'?agentReadOptions(textOffset):{};
 if(typeof textOffset==='object')textOffset=0;
 const elementOffset=reading.elementOffset||0;let matchedElements=0;
 if(!Number.isSafeInteger(textOffset)||textOffset<0)throw new Error("Invalid text offset");
 const nodes=new Map(), elements=[],regions=[],groups=[],groupNodes=new Map();let semanticBudget=4000;let contextBudget=5000,elementsComplete=true,regionsComplete=true,cssHiddenExcluded=false;
 const blocked=sensitiveSelector+',[data-page-agent],script,style,noscript,[hidden],[aria-hidden="true"]';
 const visible=n=>{if(n.closest(blocked)||n.closest('dialog:not([open])'))return false;return !agentHidden(n,n.ownerDocument.defaultView);};
 const dialogSelector='dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"]';
 const scan=agentFrameScan(doc,visible),frameOf=n=>agentFrame(n.ownerDocument),frameId=n=>scan.docs.get(frameOf(n))?.entry.id;
 const inDialog=n=>!!n.closest(dialogSelector)||!!frameOf(n)?.closest(dialogSelector);
 // Frame nodes follow their iframe element so document order and shared budgets stay intact.
 const all=[];for(const n of doc.querySelectorAll('*')){all.push(n);const f=scan.docs.get(n);if(f)all.push(...f.doc.querySelectorAll('*'));}
 const geometry=new Map(),scrollables=new Set();
 const inViewport=n=>{if(!geometry.has(n))geometry.set(n,agentGeometry(n));return geometry.get(n)?.inViewport;};
 for(const n of all){const info=agentScrollInfo(n),own=n.ownerDocument;if(n===own.body||n===own.documentElement||(!info.maxX&&!info.maxY))continue;const style=own.defaultView?.getComputedStyle?.(n);if((info.maxX&&/auto|scroll/.test(style?.overflowX))||(info.maxY&&/auto|scroll/.test(style?.overflowY)))scrollables.add(n);}
 const prioritize=items=>[...items].sort((a,b)=>Number(inDialog(b))-Number(inDialog(a))||Number(!!inViewport(b))-Number(!!inViewport(a)));
 let fullText='';
 if(reading.includeText!==false){
  const read=d=>{const copy=d.body.cloneNode(true);for(const n of copy.querySelectorAll(blocked))n.remove();return (copy.innerText||copy.textContent||'').replace(/\s+/g,' ').trim();};
  fullText=[read(doc),...[...scan.docs.values()].map(f=>{const t=read(f.doc);return t&&`[${f.entry.id}${f.entry.label?' '+f.entry.label:''}] ${t}`;})].filter(Boolean).join(' ');
 }
 const start=Math.min(textOffset,fullText.length),text=fullText.slice(start,start+16000);
 const textRange=reading.includeText===false?{start:0,end:0,total:null,nextOffset:null,omitted:true}:{start,end:start+text.length,total:fullText.length,nextOffset:start+text.length<fullText.length?start+text.length:null};
 // Include custom controls without relying on site-specific classes or executing handlers.
 const controls='[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"],button,a[href],input,textarea,select,[role="button"],[role="radio"],[role="checkbox"],[role="link"],[role="menuitem"],[role="switch"],[role="combobox"],[role="option"],[role="tab"],[onclick],[tabindex]';
 const explicit=n=>n.matches(controls)&&(n.getAttribute('tabindex')===null||Number(n.getAttribute('tabindex'))>=0||n.matches(controls.replace(',[tabindex]','')));
 const cursors=new Map();
 const pointer=n=>{if(!n)return false;if(!cursors.has(n))cursors.set(n,n.ownerDocument.defaultView?.getComputedStyle?.(n)?.cursor);return cursors.get(n)==='pointer';};
 // Inside a clickable row, keep children that carry their own interaction signal (e.g. hover-revealed actions).
 const distinct=n=>n.matches('a,label,summary,[aria-haspopup]:not([aria-haspopup="false"]),[aria-expanded],[aria-pressed],[data-testid]');
 for(const n of prioritize(all)){
  const direct=explicit(n)||scrollables.has(n);
  if(!direct){
   // A pointer cursor is inherited: expose its boundary, not every icon/count child.
   if(!pointer(n)||n===n.ownerDocument.body||n===n.ownerDocument.documentElement||pointer(n.parentElement)&&!distinct(n)||n.closest(controls)||n.querySelector(controls))continue;
  }
  if(!visible(n)){if(!n.closest(blocked))cssHiddenExcluded=true;continue;}
  const id='t'+elements.length,editable=agentEditable(n);
  const associated=[...(n.labels||[])];
  if(n.closest('label'))associated.push(n.closest('label'));
  const nodeId=n.getAttribute('id'),type=agentString(n.type),name=agentString(n.name);
  if(nodeId)for(const l of n.ownerDocument.querySelectorAll('label[for]'))if(l.getAttribute('for')===nodeId)associated.push(l);
  const labelled=n.getAttribute('aria-labelledby')?.split(/\s+/).map(id=>agentText(n.ownerDocument.getElementById(id))).join(' ').trim();
  const label=(n.getAttribute('aria-label')||labelled||[...new Set(associated)].map(l=>agentText(l)).join(' ').trim()||n.getAttribute('title')||(['submit','button','reset'].includes(type)?agentString(n.value):'')||(editable?'':agentText(n))||n.getAttribute('placeholder')||name||'').trim().slice(0,180);
  if(reading.query&&!label.toLocaleLowerCase().includes(reading.query.trim().toLocaleLowerCase())&&!(name||'').toLocaleLowerCase().includes(reading.query.trim().toLocaleLowerCase()))continue;
  if(matchedElements++<elementOffset)continue;
  if(elements.length>=120)continue;
  let container=n.closest('fieldset,[role="radiogroup"],[role="group"],form,dialog,[role="dialog"],[role="alertdialog"],[data-question-id],.question,.question-item,.ques-item');
  const popup=agentPopup(n);
  container=popup?.popup||n.closest(dialogSelector)||container;
  if(!container&&['radio','checkbox'].includes(type)){
   for(let p=n.parentElement,depth=0;p&&p!==n.ownerDocument.body&&depth<6;p=p.parentElement,depth++){
    const choices=[...p.querySelectorAll('input[type="radio"],input[type="checkbox"]')];
    if(choices.length>=2&&choices.every(c=>!name||c.name===name)){container=p;break;}
   }
  }
  let group;
  if(container){
   group=groupNodes.get(container);
   if(!group){
    const c=container.cloneNode(true);for(const x of c.querySelectorAll(blocked))x.remove();
    const context=(c.textContent||'').replace(/\s+/g,' ').trim().slice(0,Math.min(500,contextBudget));contextBudget-=context.length;
    const heading=container.querySelector('legend,h1,h2,h3,h4,[role="heading"]');
    const groupLabel=(container.getAttribute('aria-label')||container.getAttribute('aria-labelledby')?.split(/\s+/).map(id=>agentText(container.ownerDocument.getElementById(id))).join(' ')||agentText(heading)||popup?.label||(inDialog(container)?context:'')).trim().slice(0,180);
    group={id:'g'+groups.length,label:groupLabel,context,optionIds:[]};groupNodes.set(container,group);groups.push(group);
   }
   group.optionIds.push(id);
  }
  const options=n.localName==='select'?[...n.options].filter(o=>!o.closest(sensitiveSelector)).map(o=>({value:o.value,label:agentText(o).slice(0,100)})).slice(0,40):undefined;
  const role=n.getAttribute('role')||(editable?'textbox':null)||(scrollables.has(n)?'region':null)||({button:'button',a:'link',select:'combobox',textarea:'textbox'}[n.localName])||(['radio','checkbox'].includes(type)?type:n.localName==='input'?'textbox':'button');
  const ariaChecked=n.getAttribute('aria-checked');
  const related=n.getAttribute('aria-controls')||n.getAttribute('aria-owns');
  const controlled=related?.split(/\s+/).slice(0,5).map(id=>n.ownerDocument.getElementById(id)).filter(Boolean);
  const expanded=n.getAttribute('aria-expanded'),selected=n.getAttribute('aria-selected');
  const semantic=semanticBudget>0?agentContext(n):null;
  const context=semantic?{path:semantic.path.map(label=>{const part=label.slice(0,semanticBudget);semanticBudget-=part.length;return part;}).filter(Boolean),description:semantic.description.slice(0,semanticBudget)}:undefined;
  if(context)semanticBudget=Math.max(0,semanticBudget-context.description.length);
  elements.push({context,inViewport:inViewport(n),expanded:['true','false'].includes(expanded)?expanded==='true':undefined,selected:['true','false'].includes(selected)?selected==='true':undefined,haspopup:n.getAttribute('aria-haspopup')||undefined,controlledLabels:controlled?.filter(visible).map(c=>{const copy=c.cloneNode(true);for(const x of copy.querySelectorAll(blocked))x.remove();return (c.getAttribute('aria-label')||copy.textContent||'').trim().slice(0,180);}),scroll:scrollables.has(n)?agentScrollInfo(n):undefined,id,key:agentNodeKey(n),frame:frameId(n),tag:n.localName,role,type:type||n.getAttribute('role'),name:name?.slice(0,100),group:group?.id,label,visible:visible(n),disabled:!!n.disabled||!!n.closest('[aria-disabled="true"],fieldset[disabled]'),editable:editable?(editable.supported?'plain_text':'unsupported_structure'):undefined,value:agentString(editable?editable.value:n.value)?.slice(0,4000),sensitive:policy.sensitiveFields===true&&n.matches(agentSensitiveSelector)?true:undefined,checked:typeof n.checked==='boolean'?n.checked:ariaChecked==='true'?true:ariaChecked==='false'?false:undefined,options});
  nodes.set(id,{node:n,signature:agentSignature(n)});
 }
 const regionOffset=reading.regionOffset||0;let matchedRegions=0;
 let regionBudget=5000;
 for(const n of prioritize(all.filter(n=>n.matches('main,section,article,fieldset,form,dialog,[role="status"],[role="alert"],[role="dialog"],[role="alertdialog"],[role="region"],[role="list"],[role="table"],[role="listbox"]')))){
  if(!visible(n)){if(!n.closest(blocked))cssHiddenExcluded=true;continue;}
  const heading=n.querySelector('legend,h1,h2,h3,h4,[role="heading"]');
  const labelled=n.getAttribute('aria-labelledby')?.split(/\s+/).map(id=>agentText(n.ownerDocument.getElementById(id))).join(' ');
  const id='r'+regions.length,label=(n.getAttribute('aria-label')||labelled||agentText(heading)||agentPopup(n)?.label||'').trim().slice(0,180);
  if(reading.regionQuery&&!label.toLocaleLowerCase().includes(reading.regionQuery.trim().toLocaleLowerCase()))continue;
  if(matchedRegions++<regionOffset)continue;
  if(regions.length>=40||regionBudget<=0)continue;
  const copy=n.cloneNode(true);for(const x of copy.querySelectorAll(blocked))x.remove();
  const raw=(copy.innerText||copy.textContent||'').replace(/\s+/g,' ').trim();
  const limit=Math.min(1000,regionBudget),regionStart=Math.min(reading.regionTextOffset||0,raw.length),regionText=raw.slice(regionStart,regionStart+limit);regionBudget-=regionText.length;
  const textRange={start:regionStart,end:regionStart+regionText.length,total:raw.length,nextOffset:regionStart+regionText.length<raw.length?regionStart+regionText.length:null};
  regions.push({id,key:agentNodeKey(n),frame:frameId(n),tag:n.localName,role:n.getAttribute('role')||n.localName,label,text:visible(n)?regionText:'',textRange,textTruncated:regionStart>0||textRange.nextOffset!==null,visible:visible(n)});
  nodes.set(id,{node:n,signature:agentSignature(n)});
 }
 regionsComplete=!reading.regionQuery&&regionOffset===0&&regions.length===matchedRegions;
 const regionRange={start:Math.min(regionOffset,matchedRegions),end:Math.min(regionOffset,matchedRegions)+regions.length,total:matchedRegions,nextOffset:regionOffset+regions.length<matchedRegions?regionOffset+regions.length:null,query:reading.regionQuery||null};
 elementsComplete=!reading.query&&elementOffset===0&&matchedElements<=120;
 const elementRange={start:Math.min(elementOffset,matchedElements),end:Math.min(elementOffset,matchedElements)+elements.length,total:matchedElements,nextOffset:elementOffset+elements.length<matchedElements?elementOffset+elements.length:null,query:reading.query||null};
 const docs=[doc,...[...scan.docs.values()].map(f=>f.doc)],sensitiveExcluded=docs.some(d=>d.querySelector(sensitiveSelector));
 const hiddenExcluded=sensitiveExcluded||cssHiddenExcluded||docs.some(d=>[...d.querySelectorAll('[hidden],[aria-hidden="true"]')].some(n=>!n.closest('[data-page-agent]')));
 return {nodes,sensitiveFields:policy.sensitiveFields===true,page:{viewport:{width:doc.defaultView?.innerWidth||0,height:doc.defaultView?.innerHeight||0,...agentScrollInfo(doc.scrollingElement||doc.documentElement)},title:doc.title,scrollY:doc.defaultView?.scrollY||0,text,textRange,elementRange,regionRange,truncated:reading.includeText===false||start>0||textRange.nextOffset!==null||!elementsComplete||!regionsComplete,elements,groups,regions,frames:scan.frames.length?scan.frames:undefined,coverage:{sensitiveFieldsAuthorized:policy.sensitiveFields===true,sensitiveExcluded,elementsComplete,regionsComplete,textComplete:reading.includeText!==false&&start===0&&textRange.nextOffset===null,absenceComplete:!hiddenExcluded,framesComplete:scan.complete}}};
}
function agentVerify(plan,snap){
 if(!['fill','check','select'].includes(plan.action))return null;
 const n=snap.nodes.get(plan.id)?.node;
 if(n?.closest(snap.sensitiveFields===true?'input[type="file"],input[type="hidden"]':agentSensitiveSelector)||n&&agentFrame(n.ownerDocument)?.closest(snap.sensitiveFields===true?'input[type="file"],input[type="hidden"]':agentSensitiveSelector))return {verified:false,message:'敏感字段已排除，无法核对'};
 if(!agentLive(n))return {verified:false,message:'操作后目标被替换，尚未核实结果，需重新读取页面'};
 const editor=agentEditable(n),actual=plan.action==='check'?n.checked:editor?editor.value:n.value;
 const verified=actual===plan.value;
 return {verified,actual,message:verified?'已核对目标字段状态与本次指定值一致':'实际字段状态与指定值不一致，操作未生效；需重新读取并修正'};
}
function agentSignature(n){return JSON.stringify([n.localName,agentString(n.type),n.getAttribute('aria-label'),n.textContent,n.getAttribute('href'),agentString(n.name),agentString(n.value),n.checked,n.disabled,n.getAttribute('aria-expanded'),n.getAttribute('aria-selected'),n.getAttribute('aria-controls'),n.getAttribute('aria-owns'),agentPopup(n)?.signature,n.getAttribute('contenteditable'),n.getAttribute('autocomplete'),agentEditable(n)]);}
function agentPlan(raw,snap){
 let p;try{p=JSON.parse(raw);}catch{throw new Error('模型未返回有效操作 JSON，请重试');}
 if(!p||typeof p.reply!=='string'||p.reply.length>4000||!agentTool(p.action)||Object.keys(p).some(k=>!['reply','action','id','value','expected','timeoutMs','choices','pauseReason','notice','subgoals'].includes(k)))throw new Error('模型操作格式无效');
 if(p.subgoals!==undefined){
  if(!Array.isArray(p.subgoals)||p.subgoals.length>8||new Set(p.subgoals.map(g=>g?.id)).size!==p.subgoals.length)throw new Error('子目标列表无效');
  for(const g of p.subgoals){
   if(!g||Object.keys(g).some(k=>!['id','title','status','checks'].includes(k))||typeof g.id!=='string'||! /^[a-zA-Z0-9_-]{1,40}$/.test(g.id)||typeof g.title!=='string'||!g.title.trim()||g.title.length>120||!['pending','active','completed','blocked'].includes(g.status)||g.status==='completed'&&!g.checks)throw new Error('子目标格式或完成证据无效');
   if(g.checks!==undefined){const G=typeof module!=='undefined'?require('./conditions.js'):root.PageAgentConditions;G.validate(g.checks);}
  }
 }
 if(p.action==='observe'&&p.value!==undefined){if(typeof p.value==='object')agentReadOptions(p.value);else if(!Number.isSafeInteger(p.value)||p.value<0)throw new Error('Invalid text offset');}
 if(p.notice!==undefined&&(typeof p.notice!=='string'||!p.notice.trim()||p.notice.length>300))throw new Error('操作提示无效');
 if(p.pauseReason!==undefined&&(p.action!=='pause'||!['blocked','user'].includes(p.pauseReason)))throw new Error('暂停原因无效');
 if(p.choices!==undefined&&(p.action!=='pause'||!Array.isArray(p.choices)||p.choices.length<2||p.choices.length>8||p.choices.some(v=>typeof v!=='string'||!v.trim()||v.length>120)||new Set(p.choices).size!==p.choices.length))throw new Error('用户选项无效');
 if(p.expected!==undefined){const G=typeof module!=='undefined'?require('./conditions.js'):root.PageAgentConditions;G.validate(p.expected);}
 if(p.action==='verify'&&!p.expected)throw new Error('验证需要明确条件');
 if(p.action==='wait'&&!p.expected&&p.timeoutMs===undefined)throw new Error('纯延时等待需要 timeoutMs');
 if(p.timeoutMs!==undefined&&(!Number.isInteger(p.timeoutMs)||p.timeoutMs<100||p.timeoutMs>30000||!agentTool(p.action).timeout))throw new Error('等待时间需为 100–30000 毫秒');
 if(['site_memory_write','site_memory_delete','site_memory_read','global_memory_read','global_memory_write','global_memory_delete'].includes(p.action)&&(typeof p.id!=='string'||! /^[a-zA-Z0-9_-]{1,60}$/.test(p.id)))throw new Error('记忆名称无效');
 if(p.action==='history_read'&&(typeof p.id!=='string'||!/^h[0-9]+$/.test(p.id)||(p.value!==undefined&&(!Number.isSafeInteger(p.value)||p.value<0))))throw new Error('历史记录读取参数无效');
 if(['site_memory_write','global_memory_write'].includes(p.action)&&(typeof p.value!=='string'||!p.value.trim()||p.value.length>2000))throw new Error('记忆内容无效或超过 2000 字符');
 if(agentTool(p.action).target==='required'&&!snap.nodes.has(p.id))throw new Error('操作目标无效');
 if(['fill','select'].includes(p.action)&&(typeof p.value!=='string'||p.value.length>4000))throw new Error('填写内容无效');
 if(['tab_switch','tab_close'].includes(p.action)&&(typeof p.id!=='string'||!(p.action==='tab_switch'?/^(tab[0-9]{1,3}|open[0-9]{1,2})$/:/^tab[0-9]{1,3}$/).test(p.id)||p.value!==undefined||p.expected!==undefined))throw new Error('标签页标识无效');
 if(p.action==='tab_open'&&p.expected!==undefined)throw new Error('打开标签页不支持预期条件');
 if(p.action==='navigate'||p.action==='tab_open'){
  let url;try{url=new URL(p.value);}catch{throw new Error('导航 URL 无效');}
  if(typeof p.value!=='string'||p.value.length>2000||!['http:','https:'].includes(url.protocol)||url.username||url.password||p.id!==undefined)throw new Error('导航仅支持不含凭据的 HTTP/HTTPS URL');
  p.value=url.href;
 }
 if(p.action==='check'&&typeof p.value!=='boolean')throw new Error('勾选状态无效');
 if(p.action==='scroll'||p.action==='wheel'){
  if(!['up','down','left','right'].includes(p.value))throw new Error('滚动方向无效');
  if(p.id!==undefined&&!snap.nodes.has(p.id))throw new Error('滚动目标无效');
 }
 if(p.action==='press_key')agentKey(p.value);
 if(agentToolRegistry.run_script&&p.action==='run_script')(typeof module!=='undefined'?require('./script-tools.js'):root.PageAgentScriptTools).validate(p);
 return p;
}
function agentExecute(p,snap,doc){
 if(p.action==='done')return;
 if(agentTool(p.action)?.route!=='content')throw Object.assign(new Error('该工具不能在网页执行'),{code:'UNSUPPORTED_ACTION',beforeDispatch:true});
 if(p.action==='scroll'&&p.id===undefined){return agentScroll(p,doc.scrollingElement||doc.documentElement,doc,true);}
 const ref=snap.nodes.get(p.id),n=ref?.node,frame=n&&agentFrame(n.ownerDocument);
 if(n?.closest(snap.sensitiveFields===true?'input[type="file"],input[type="hidden"]':agentSensitiveSelector)||frame?.closest(snap.sensitiveFields===true?'input[type="file"],input[type="hidden"]':agentSensitiveSelector))throw Object.assign(new Error('目标已变为敏感字段，未执行'),{code:'STALE',beforeDispatch:true});
 if(!agentLive(n)||frame?.closest('[hidden],[aria-hidden="true"],[data-page-agent]')||agentSignature(n)!==ref.signature||n.disabled||n.closest('[hidden],[aria-hidden="true"],[aria-disabled="true"],fieldset[disabled],[data-page-agent]'))throw Object.assign(new Error('页面目标已变化，请重新发送指令'),{code:'STALE'});
 // Frame targets act on their own document: its viewport, hit testing, event constructors and value setters.
 const top=doc;doc=n.ownerDocument;const win=doc.defaultView;
 if(agentHidden(n,win)||frame&&agentHidden(frame,top.defaultView))throw Object.assign(new Error('页面目标已隐藏，请重新定位'),{code:'STALE'});
 if(p.action==='scroll')return agentScroll(p,n,doc,false);
 if(p.action==='wheel')return agentWheel(p,n,doc,snap);
 if(['press_key','double_click','right_click'].includes(p.action))return agentInput(p,n,doc,ref.signature,snap);
 // Visual feedback never gates or changes the actual operation.
 try{n.scrollIntoView?.({block:'nearest',inline:'nearest',behavior:'instant'});root.PageAgentPointer?.show(n,top,agentVisibleRect(n));}catch{}
 if(p.action==='click'||p.action==='hover'){agentClick(n,doc,p.action==='hover',snap);return;}
 if(p.action==='check'){
  if(n.localName!=='input'||!['checkbox','radio'].includes(n.type))throw new Error('目标不是可勾选选项');
  if(n.type==='radio'&&!p.value)throw new Error('不能直接取消单选项');
  if(n.checked!==p.value){n.click();try{root.PageAgentPointer?.click();}catch{}}return;
 }
 const editable=agentEditable(n);
 if(p.action==='fill'&&editable&&!editable.supported)throw Object.assign(new Error('此编辑器包含复杂节点，不支持纯文本替换'),{code:'UNSUPPORTED_EDITABLE',beforeDispatch:true});
 if(n.readOnly||n.getAttribute('aria-readonly')==='true')throw new Error('目标为只读字段');
 if(p.action==='fill'&&!(editable||n.localName==='textarea'||n.localName==='input'&&['text','search','email','tel','url','number','date','time','datetime-local','month','week',...(snap.sensitiveFields===true?['password']:[])].includes(n.type)))throw new Error('目标不是支持的文本字段');
 if(p.action==='select'&&(n.localName!=='select'||![...n.options].some(o=>o.value===p.value&&!o.disabled)))throw new Error('下拉选项无效');
 const proto=n.localName==='textarea'?win.HTMLTextAreaElement?.prototype:n.localName==='select'?win.HTMLSelectElement?.prototype:win.HTMLInputElement?.prototype;
 const setter=proto&&Object.getOwnPropertyDescriptor(proto,'value')?.set;
 // Browser sanitization must not silently clear an existing date/number value.
 if(p.action==='fill'&&n.localName==='input'&&setter){
  const probe=doc.createElement('input');probe.type=n.type;setter.call(probe,p.value);
  if(probe.value!==p.value)throw Object.assign(new Error('字段不接受此格式，未修改原值'),{code:'INVALID_FIELD_VALUE',beforeDispatch:true});
 }
 const inputType=n.type;
 const intact=()=>{
  if(!agentLive(n)||n.disabled||n.readOnly||n.closest(snap.sensitiveFields===true?'input[type="file"],input[type="hidden"]':agentSensitiveSelector)||n.closest('[hidden],[aria-hidden="true"],[aria-disabled="true"],fieldset[disabled],[data-page-agent]')||n.localName==='input'&&n.type!==inputType||editable&&!agentEditable(n)?.supported||n.getAttribute('aria-readonly')==='true')throw Object.assign(new Error('输入事件期间目标变化，已停止后续事件'),{code:'TARGET_CHANGED'});
  if(agentHidden(n,win))throw Object.assign(new Error('输入目标已隐藏，已停止后续事件'),{code:'TARGET_CHANGED'});
 };
 n.focus?.({preventScroll:true});intact();
 if(agentSignature(n)!==ref.signature)throw Object.assign(new Error('聚焦期间字段变化，未继续写入'),{code:'TARGET_CHANGED'});
 const inputEvent=(type,cancelable)=>new (win.InputEvent||win.Event)(type,{bubbles:true,composed:true,cancelable,inputType:'insertReplacementText',data:p.value,isComposing:false});
 if(p.action==='fill'){
  if(!n.dispatchEvent(inputEvent('beforeinput',true)))throw Object.assign(new Error('网页取消了输入，未写入指定值'),{code:'INPUT_CANCELLED'});
  intact();
  if(agentSignature(n)!==ref.signature)throw Object.assign(new Error('输入前字段变化，未继续写入'),{code:'TARGET_CHANGED'});
 }
 if(editable)n.textContent=p.value;else if(setter)setter.call(n,p.value);else n.value=p.value;
 n.dispatchEvent(p.action==='fill'?inputEvent('input',false):new win.Event('input',{bubbles:true,composed:true}));
 intact();
 n.dispatchEvent(new win.Event('change',{bubbles:true,composed:true}));
}
// Only current snapshot references reach these helpers; no selectors from the model.
function agentScroll(p,n,doc,page){
 const before=agentScrollInfo(n),horizontal=['left','right'].includes(p.value),axis=horizontal?'x':'y';
 const max=horizontal?before.maxX:before.maxY;
 if(!page&&!max)throw Object.assign(new Error('目标在指定方向不可滚动，请重新读取'),{code:'STALE'});
 const amount=(['up','left'].includes(p.value)?-1:1)*600;
 const x=horizontal?amount:0,y=horizontal?0:amount;
 if(page)doc.defaultView.scrollBy(x,y);else n.scrollBy({left:x,top:y,behavior:'instant'});
 const after=agentScrollInfo(n),delta=after[axis]-before[axis];
 return {axis,before:before[axis],after:after[axis],delta,atStart:after[axis]<=0,atEnd:after[axis]>=max};
}
// Bounded input vocabulary: no text, scripts, arbitrary codes or held-key state.
function agentKey(value){
 if(typeof value!=='string')throw new Error('按键参数无效');
 const parts=value.split('+'),key=parts.pop(),modifiers=parts;
 if(!['Enter','Escape','Tab','Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown','Backspace','Delete',...'abcdefghijklmnopqrstuvwxyz'].includes(key)||modifiers.some(m=>!['Control','Alt','Shift','Meta'].includes(m))||new Set(modifiers).size!==modifiers.length)throw new Error('不支持的按键或组合键');
 return {key:key==='Space'?' ':key,ctrlKey:modifiers.includes('Control'),altKey:modifiers.includes('Alt'),shiftKey:modifiers.includes('Shift'),metaKey:modifiers.includes('Meta')};
}
// An overlay often covers only part of a control: probe several points of its visible box,
// then once more after centring it. Never dispatch to a point the target does not own.
const agentHitFractions=[[.5,.5],[.25,.5],[.75,.5],[.5,.25],[.5,.75],[.15,.2],[.85,.2],[.15,.8],[.85,.8]];
function agentHitPoint(n,doc,snap,message){
 const win=doc.defaultView,frame=agentFrame(doc);
 const probe=()=>{
  const r=n.getBoundingClientRect();let left=Math.max(0,r.left),top=Math.max(0,r.top),right=Math.min(win.innerWidth,r.right),bottom=Math.min(win.innerHeight,r.bottom);
  // In a frame, also stay inside the iframe's visible box and require the top document to hit the iframe there.
  const o=frame&&agentFrameOffset(frame),outer=frame&&agentVisibleRect(frame);
  if(frame){if(!outer)return {};left=Math.max(left,outer.left-o.x);top=Math.max(top,outer.top-o.y);right=Math.min(right,outer.right-o.x);bottom=Math.min(bottom,outer.bottom-o.y);}
  if(!(right>left&&bottom>top))return {};
  let first=null;
  for(const [fx,fy] of agentHitFractions){
   const x=left+(right-left)*fx,y=top+(bottom-top)*fy,cover=frame&&frame.ownerDocument.elementFromPoint(x+o.x,y+o.y);
   if(frame&&cover!==frame){if(cover)first??={hit:cover,anchor:frame};continue;}
   const hit=doc.elementFromPoint(x,y);if(hit&&n.contains(hit))return {x,y,hit};if(hit)first??={hit,anchor:n};
  }
  return {blocker:first};
 };
 n.scrollIntoView?.({block:'nearest',inline:'nearest',behavior:'instant'});
 let found=probe();
 if(!found.hit){n.scrollIntoView?.({block:'center',inline:'center',behavior:'instant'});found=probe();}
 if(found.hit)return found;
 throw Object.assign(new Error(message),{code:'TARGET_BLOCKED',beforeDispatch:true,observed:agentBlocker(found.blocker?.hit,found.blocker?.anchor||n,snap)});
}
// A point still belongs to the target only if the target (and, in a frame, the iframe in the top document) is hit there.
function agentOwns(n,doc,x,y){
 const f=agentFrame(doc);if(f){const o=agentFrameOffset(f);if(f.ownerDocument.elementFromPoint(x+o.x,y+o.y)!==f)return null;}
 const hit=doc.elementFromPoint(x,y);return hit&&n.contains(hit)?hit:null;
}
// Describe the covering layer only through data the snapshot already exposed, keyed by stable node keys.
function agentBlocker(hit,n,snap){
 if(!hit)return {blocker:null,layer:null,layerControls:[]};
 const brief=n=>({tag:n.localName,role:n.getAttribute?.('role')||undefined});
 if(hit.contains(n))return {blocker:brief(hit),layer:null,layerControls:[]};
 let layer=hit;while(layer.parentElement&&!layer.parentElement.contains(n))layer=layer.parentElement;
 const items=[...(snap?.page?.elements||[]),...(snap?.page?.regions||[])],byId=new Map(items.map(e=>[e.id,e])),byNode=new Map();
 for(const [id,ref] of snap?.nodes||[])if(byId.has(id))byNode.set(ref.node,byId.get(id));
 const pick=e=>({key:e.key,role:e.role,label:e.label});
 let own=null;for(let p=hit;p&&!own;p=p.parentElement){if(byNode.has(p))own=pick(byNode.get(p));if(p===layer)break;}
 const layerControls=(snap?.page?.elements||[]).filter(e=>!e.disabled&&layer.contains(snap.nodes.get(e.id)?.node)).slice(0,8).map(pick);
 const region=byNode.get(layer);
 return {blocker:own||brief(hit),layer:{key:agentNodeKey(layer),...brief(layer),label:region?.label||undefined},layerControls};
}
function agentInput(p,n,doc,signature,snap){
 const win=doc.defaultView;
 const {x,y,hit}=agentHitPoint(n,doc,snap,'目标被遮挡，请重新观察');
 const guard=()=>{
  if(!agentLive(n)||!hit.isConnected||agentSignature(n)!==signature||n.disabled||n.closest('[hidden],[aria-hidden="true"],[aria-disabled="true"],fieldset[disabled]')||!agentOwns(n,doc,x,y))throw Object.assign(new Error('输入期间目标变化，停止后续事件'),{code:'TARGET_CHANGED'});
  if(agentHidden(n,win))throw Object.assign(new Error('输入期间目标隐藏'),{code:'TARGET_CHANGED'});
 };
 if(p.action==='press_key'){
  const opts=agentKey(p.value);
  n.focus?.({preventScroll:true});guard();
  if(doc.activeElement!==n)throw Object.assign(new Error('目标无法获得键盘焦点'),{code:'TARGET_CHANGED'});
  n.dispatchEvent(new win.KeyboardEvent('keydown',{...opts,bubbles:true,cancelable:true,composed:true}));
  guard();if(doc.activeElement!==n)throw Object.assign(new Error('按键期间焦点变化，停止后续事件'),{code:'TARGET_CHANGED'});
  n.dispatchEvent(new win.KeyboardEvent('keyup',{...opts,bubbles:true,cancelable:true,composed:true}));
  return {input:'keyboard',key:opts.key};
 }
 if(p.action==='double_click'){
  agentClick(n,doc,false,snap);guard();agentClick(n,doc,false,snap);guard();
  hit.dispatchEvent(new win.MouseEvent('dblclick',{bubbles:true,cancelable:true,composed:true,clientX:x,clientY:y,button:0,detail:2}));
 }else{
  const opts={bubbles:true,cancelable:true,composed:true,clientX:x,clientY:y,button:2};
  for(const type of ['pointerdown','mousedown','pointerup','mouseup','contextmenu']){guard();const C=type.startsWith('pointer')?win.PointerEvent:win.MouseEvent;hit.dispatchEvent(new C(type,{...opts,buttons:type.endsWith('down')?2:0,pointerId:1,pointerType:'mouse',isPrimary:true}));}
 }
 return {input:p.action};
}
function agentWheel(p,n,doc,snap){
 const win=doc.defaultView;
 if(!win?.WheelEvent)throw Object.assign(new Error('浏览器不支持滚轮事件'),{code:'UNSUPPORTED_ACTION',beforeDispatch:true});
 const {x,y,hit}=agentHitPoint(n,doc,snap,'目标被遮挡或不在可操作区域，请重新观察');
 try{root.PageAgentPointer?.show(n,agentFrame(doc)?.ownerDocument||doc,agentVisibleRect(n));}catch{}
 const horizontal=['left','right'].includes(p.value),amount=['up','left'].includes(p.value)?-600:600;
 const deltaX=horizontal?amount:0,deltaY=horizontal?0:amount;
 const accepted=hit.dispatchEvent(new win.WheelEvent('wheel',{bubbles:true,cancelable:true,composed:true,clientX:x,clientY:y,deltaX,deltaY,deltaMode:0}));
 // Synthetic wheel invokes page listeners, never claims native default scrolling.
 return {input:'wheel',deltaX,deltaY,defaultPrevented:!accepted};
}
function agentClick(n,doc,hover=false,snap){
 const win=doc.defaultView;
 const r=n.getBoundingClientRect?.();
 let target=n,x=0,y=0;
 if(r&&doc.elementFromPoint)({x,y,hit:target}=agentHitPoint(n,doc,snap,'目标被遮挡或不在可点击区域，请重新观察'));
 else n.scrollIntoView?.({block:'nearest',inline:'nearest',behavior:'instant'});
 const send=(type,pointer=false,bubbles=true)=>{
  const EventClass=pointer?win.PointerEvent:win.MouseEvent;
  if(!EventClass)return true;
  return target.dispatchEvent(new EventClass(type,{bubbles,cancelable:true,clientX:x,clientY:y,button:0,buttons:type.endsWith('down')?1:0,pointerId:1,pointerType:'mouse',isPrimary:true}));
 };
 send('pointerover',true);send('pointerenter',true,false);send('mouseover');send('mouseenter',false,false);
 if(hover){send('pointermove',true);send('mousemove');return;}
 const pointer=send('pointerdown',true),mouse=pointer?send('mousedown'):false;
 if(mouse)n.focus?.({preventScroll:true});
 send('pointerup',true);if(pointer)send('mouseup');
 // Hover/focus handlers can replace a node or open an overlay. Never click through it.
 if(!agentLive(n)||!target.isConnected||(r&&doc.elementFromPoint&&!agentOwns(n,doc,x,y)))throw Object.assign(new Error('交互期间目标发生变化，尚未派发 click，请重新观察'),{code:'TARGET_CHANGED'});
 // SVG hit targets have no HTMLElement.click(); keep the actual hit as event target.
 if(typeof target.click==='function')target.click();
 else target.dispatchEvent(new win.MouseEvent('click',{bubbles:true,cancelable:true,composed:true,clientX:x,clientY:y,button:0,buttons:0}));
 try{root.PageAgentPointer?.click();}catch{}
}
const api={endpoint,siteOrigin,byteSize,safe,cleanText,collect,validStyle,proposal,apply,describe,resolve,validRecord,restore,agentTool,agentToolNames,agentSnapshot,agentPlan,agentExecute,agentVerify};
root.PageAgentCore=api;
if(typeof module!=='undefined')module.exports=api;
})(globalThis);
