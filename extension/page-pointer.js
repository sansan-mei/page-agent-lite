(function(root){
 'use strict';
 if(root.PageAgentPointer)return;
 let host,arrow,box,ring,timer,previous,movement,active=false;
 const persistent=!root.top||root===root.top;
 function clear(){movement?.cancel();movement=null;clearTimeout(timer);host?.remove();host=arrow=box=ring=null;previous=null;active=false;}
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
 function move(point,doc){
  const reduced=doc.defaultView.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  // Core can locate the same target twice in one dispatch. Preserve the flight already in progress.
  if(!reduced&&previous?.left===point.left&&previous?.top===point.top)return;
  const current=arrow.getBoundingClientRect(),from={left:current.left+'px',top:current.top+'px'};
  movement?.cancel();movement=null;
  Object.assign(arrow.style,point);previous=point;
  const distance=Math.hypot(parseFloat(point.left)-current.left,parseFloat(point.top)-current.top);
  if(!reduced&&distance>1&&arrow.animate){
   movement=arrow.animate([from,point],{duration:Math.min(600,Math.max(240,180+distance*.65)),easing:'cubic-bezier(.22,.61,.36,1)'});
  }
 }
 // rect is in the containing viewport; same-origin frame targets use the top layer.
 function show(target,doc,rect){
  if(!target?.getBoundingClientRect||doc.hidden)return;
  const r=rect||target.getBoundingClientRect(),win=doc.defaultView;
  const left=Math.max(0,r.left),top=Math.max(0,r.top),right=Math.min(win.innerWidth,r.right),bottom=Math.min(win.innerHeight,r.bottom);
  if(right<=left||bottom<=top||!mount(doc))return;
  active=true;clearTimeout(timer);
  Object.assign(box.style,{display:'block',left:left+'px',top:top+'px',width:right-left+'px',height:bottom-top+'px'});
  const point={left:(left+right)/2+'px',top:(top+bottom)/2+'px'};
  move(point,doc);ring.style.display='none';
  timer=setTimeout(persistent?highlightsOff:clear,900);
 }
 function click(){
  if(!host?.isConnected||!previous)return;
  const layer=host,point=previous;
  const pulse=()=>{
   if(host!==layer||previous!==point||!ring)return;
   Object.assign(ring.style,{display:'block',left:(parseFloat(point.left)-11)+'px',top:(parseFloat(point.top)-11)+'px'});
   if(!root.matchMedia?.('(prefers-reduced-motion: reduce)').matches)ring.animate?.([{transform:'scale(.5)',opacity:1},{transform:'scale(1.7)',opacity:0}],{duration:360,fill:'forwards'});
  };
  if(movement?.playState==='running')void movement.finished.then(pulse,()=>{});
  else pulse();
 }
 function reposition(){
  if(!active||!persistent){clear();return;}
  highlightsOff();if(!previous||!arrow)return;
  move({left:Math.max(0,Math.min(parseFloat(previous.left),root.innerWidth-14))+'px',top:Math.max(0,Math.min(parseFloat(previous.top),root.innerHeight-20))+'px'},root.document);
 }
 root.addEventListener?.('pagehide',clear);
 root.addEventListener?.('scroll',reposition,true);
 root.addEventListener?.('resize',reposition);
 root.document?.addEventListener('visibilitychange',()=>{if(!root.document.hidden&&active&&persistent)mount(root.document);if(host)host.style.setProperty('display',root.document.hidden?'none':'block','important');});
 root.PageAgentPointer={start,show,click,clear};
})(globalThis);
