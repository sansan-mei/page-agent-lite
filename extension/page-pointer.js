(function(root){
 'use strict';
 if(root.PageAgentPointer)return;
 let host,arrow,box,ring,timer,previous,active=false;
 const persistent=!root.top||root===root.top;
 function clear(){clearTimeout(timer);host?.remove();host=arrow=box=ring=null;previous=null;active=false;}
 function node(doc,style){const n=doc.createElement('div');n.style.cssText=style+';pointer-events:none!important';return n;}
 function highlightsOff(){clearTimeout(timer);if(box)box.style.display='none';if(ring)ring.style.display='none';}
 function mount(doc){
  if(doc.hidden)return false;
  if(!host?.isConnected){
   host=doc.createElement('div');host.setAttribute('data-page-agent','pointer');host.setAttribute('aria-hidden','true');
   host.style.cssText='all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;display:block!important';
   const shadow=host.attachShadow({mode:'closed'});
   box=node(doc,'position:fixed;border:2px solid #2563eb;border-radius:5px;box-sizing:border-box;background:rgba(37,99,235,.06);display:none');
   arrow=node(doc,'position:fixed;width:14px;height:20px;background:#2563eb;clip-path:polygon(0 0,0 100%,35% 70%,60% 100%,78% 88%,54% 59%,100% 55%);filter:drop-shadow(0 1px 2px white)');
   ring=node(doc,'position:fixed;width:22px;height:22px;border:2px solid #2563eb;border-radius:50%;box-sizing:border-box;display:none');
   shadow.append(box,ring,arrow);doc.documentElement.append(host);
   previous=previous||{left:'24px',top:'24px'};Object.assign(arrow.style,previous);
  }
  return true;
 }
 function start(doc){if(!persistent)return;active=true;mount(doc);}
 // rect is in the containing viewport; same-origin frame targets use the top layer.
 function show(target,doc,rect){
  if(!target?.getBoundingClientRect||doc.hidden)return;
  const r=rect||target.getBoundingClientRect(),win=doc.defaultView;
  const left=Math.max(0,r.left),top=Math.max(0,r.top),right=Math.min(win.innerWidth,r.right),bottom=Math.min(win.innerHeight,r.bottom);
  if(right<=left||bottom<=top||!mount(doc))return;
  active=true;clearTimeout(timer);
  Object.assign(box.style,{display:'block',left:left+'px',top:top+'px',width:right-left+'px',height:bottom-top+'px'});
  const point={left:(left+right)/2+'px',top:(top+bottom)/2+'px'};
  const reduced=win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if(previous&&!reduced)arrow.animate?.([previous,point],{duration:140,easing:'ease-out'});
  Object.assign(arrow.style,point);previous=point;ring.style.display='none';
  timer=setTimeout(persistent?highlightsOff:clear,900);
 }
 function click(){
  if(!host?.isConnected||!previous)return;
  Object.assign(ring.style,{display:'block',left:(parseFloat(previous.left)-11)+'px',top:(parseFloat(previous.top)-11)+'px'});
  if(!root.matchMedia?.('(prefers-reduced-motion: reduce)').matches)ring.animate?.([{transform:'scale(.5)',opacity:1},{transform:'scale(1.7)',opacity:0}],{duration:360,fill:'forwards'});
 }
 function reposition(){
  if(!active||!persistent){clear();return;}
  highlightsOff();if(!previous||!arrow)return;
  previous={left:Math.max(0,Math.min(parseFloat(previous.left),root.innerWidth-14))+'px',top:Math.max(0,Math.min(parseFloat(previous.top),root.innerHeight-20))+'px'};
  Object.assign(arrow.style,previous);
 }
 root.addEventListener?.('pagehide',clear);
 root.addEventListener?.('scroll',reposition,true);
 root.addEventListener?.('resize',reposition);
 root.document?.addEventListener('visibilitychange',()=>{if(!root.document.hidden&&active&&persistent)mount(root.document);if(host)host.style.setProperty('display',root.document.hidden?'none':'block','important');});
 root.PageAgentPointer={start,show,click,clear};
})(globalThis);
