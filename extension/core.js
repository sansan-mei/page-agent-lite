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
const api={endpoint,siteOrigin,byteSize,safe,cleanText,collect,validStyle,proposal,apply,describe,resolve,validRecord,restore};
root.PageAgentCore=api;
if(typeof module!=='undefined')module.exports=api;
})(globalThis);
