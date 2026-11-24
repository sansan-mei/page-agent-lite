(function(root){
 'use strict';
 if(root.PageAgentPointer)return;
 let host,arrow,box,ring,timer,previous;
 function clear(){clearTimeout(timer);host?.remove();host=arrow=box=ring=null;previous=null;}
 function node(doc,style){const n=doc.createElement('div');n.style.cssText=style+';pointer-events:none!important';return n;}
 // rect (top viewport coordinates) is passed for targets inside a same-origin frame; the layer stays in doc.
 function show(target,doc,rect){
  if(!target?.getBoundingClientRect||doc.hidden)return;
  const r=rect||target.getBoundingClientRect(),win=doc.defaultView;
  const left=Math.max(0,r.left),top=Math.max(0,r.top),right=Math.min(win.innerWidth,r.right),bottom=Math.min(win.innerHeight,r.bottom);
  if(right<=left||bottom<=top)return;
  clearTimeout(timer);
  if(!host?.isConnected){
   host=doc.createElement('div');host.setAttribute('data-page-agent','pointer');host.setAttribute('aria-hidden','true');
   host.style.cssText='all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important';
   const shadow=host.attachShadow({mode:'closed'});
   box=node(doc,'position:fixed;border:2px solid #2563eb;border-radius:5px;box-sizing:border-box;background:rgba(37,99,235,.06)');
   arrow=node(doc,'position:fixed;width:14px;height:20px;background:#2563eb;clip-path:polygon(0 0,0 100%,35% 70%,60% 100%,78% 88%,54% 59%,100% 55%);filter:drop-shadow(0 1px 2px white)');
   ring=node(doc,'position:fixed;width:22px;height:22px;border:2px solid #2563eb;border-radius:50%;box-sizing:border-box;display:none');
   shadow.append(box,ring,arrow);doc.documentElement.append(host);
  }
  Object.assign(box.style,{left:left+'px',top:top+'px',width:right-left+'px',height:bottom-top+'px'});
  const point={left:(left+right)/2+'px',top:(top+bottom)/2+'px'};
  const reduced=win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if(previous&&!reduced)arrow.animate?.([previous,point],{duration:140,easing:'ease-out'});
  Object.assign(arrow.style,point);previous=point;ring.style.display='none';
  timer=setTimeout(()=>{host?.remove();host=arrow=box=ring=null;},900);
 }
 function click(){
  if(!host?.isConnected||!previous)return;
  Object.assign(ring.style,{display:'block',left:(parseFloat(previous.left)-11)+'px',top:(parseFloat(previous.top)-11)+'px'});
  if(!root.matchMedia?.('(prefers-reduced-motion: reduce)').matches)ring.animate?.([{transform:'scale(.5)',opacity:1},{transform:'scale(1.7)',opacity:0}],{duration:360,fill:'forwards'});
 }
 root.addEventListener?.('pagehide',clear);
 root.addEventListener?.('scroll',clear,true);
 root.addEventListener?.('resize',clear);
 root.document?.addEventListener('visibilitychange',clear);
 root.PageAgentPointer={show,click,clear};
})(globalThis);
