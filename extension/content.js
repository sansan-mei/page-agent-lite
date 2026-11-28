(function () {
  'use strict';
  if (globalThis.__pageAgentTools) return;
  globalThis.__pageAgentTools = true;
  const C=globalThis.PageAgentCore,G=globalThis.PageAgentConditions,T=globalThis.PageAgentProtocol;
  const documentId=crypto.randomUUID();
  // lastAction: the last click/hover target, kept only until the next observe so the background can ask for a
  // real-input point (agent:point) and the settled result (agent:settle) of that same target.
  let snapshot=null,snapshotId=null,executing=false,sensitiveFields=false,lastAction=null;
  function capture(textOffset=0){return {...C.agentSnapshot(document,textOffset,{sensitiveFields,skipFrames:!!globalThis.top&&globalThis!==globalThis.top}),documentId,url:location.href};}
  function captureForChecks(expected){
    G.validate(expected);
    const current=capture(),regions=new Map(current.page.regions.map(r=>[r.key,r]));
    const labels=[...new Set(expected.filter(c=>c.target?.category==='region'&&c.target.label).map(c=>c.target.label))];
    for(const label of labels){
      if(label.length>180)continue;
      const extra=capture({regionQuery:label});
      for(const r of extra.page.regions)regions.set(r.key,r);
    }
    if(labels.length)current.page.regions=[...regions.values()];
    return current;
  }
  function fingerprint(){return JSON.stringify(capture().page);}
  // view_image: opaque boxes over sensitive fields while the background takes the screenshot. Removed by
  // agent:unshot (always sent in a finally) or after 15 s if that message never arrives.
  let shield=null;
  function unshield(){if(shield){clearTimeout(shield.timer);shield.host.remove();shield=null;}}
  function cover(boxes,shotId){
    if(!boxes.length)return null;
    const win=document.defaultView,failed=()=>Object.assign(new Error('无法遮盖敏感字段，未截图'),{code:'MASK_FAILED'});
    const css=(n,props)=>{for(const [k,v] of Object.entries(props))n.style.setProperty(k,v,'important');};
    const host=document.createElement('div');host.setAttribute('data-page-agent','mask');
    css(host,{position:'fixed',left:'0',top:'0',width:'0',height:'0',overflow:'visible','z-index':'2147483647','pointer-events':'none',display:'block',visibility:'visible',opacity:'1',transform:'none',filter:'none'});
    for(const b of boxes){const box=document.createElement('div');css(box,{position:'fixed',left:b.left+'px',top:b.top+'px',width:b.width+'px',height:b.height+'px',background:'#000',display:'block',visibility:'visible',opacity:'1',margin:'0',border:'0',padding:'0'});host.appendChild(box);}
    try{
      (document.documentElement||document.body).appendChild(host);
      const root=win.getComputedStyle(document.documentElement);
      const placed=[...host.children].every((box,i)=>{const r=box.getBoundingClientRect(),style=win.getComputedStyle(box),b=boxes[i];
        return style.display!=='none'&&style.visibility==='visible'&&Math.abs(r.left-b.left)<=1&&Math.abs(r.top-b.top)<=1&&Math.abs(r.width-b.width)<=1&&Math.abs(r.height-b.height)<=1;});
      if(!host.isConnected||!placed||!['1',''].includes(String(root.opacity??'1')))throw failed();
    }catch{host.remove();throw failed();}
    return {shotId,host,timer:setTimeout(unshield,15000)};
  }
  function report(operationId,expected,changed,observed){
    const check=expected.length?G.evaluate(expected,captureForChecks(expected)):null;
    return T.result({operationId,documentId,status:check?.status||'unknown',dispatch:'sent',scope:check?'ui':'dispatch',code:check?(check.status==='success'?'CONDITIONS_MATCH':'CONDITIONS_UNMET'):changed,
      evidence:check?.evidence||[],observed,recovery:check?.status==='success'?'none':expected.length?'wait':'observe',
      message:check?.status==='success'?'指定预期已核实（不代表服务端保存或整个任务完成）':expected.length?'操作已发出，正在等待预期结果':changed==='NO_CHANGE'?'操作已发出，暂未观察到页面变化':'操作已发出，页面有变化；具体效果待核对'});
  }
  async function settle(before){
    const start=Date.now();let last=before,stable=0;
    while(Date.now()-start<600){
      await new Promise(resolve=>setTimeout(resolve,100));
      const next=fingerprint();stable=next===last?stable+1:0;last=next;
      if(stable>=1&&next!==before)break;
    }
    return last===before?'NO_CHANGE':'PAGE_CHANGED';
  }
  // The developer build swaps the service worker entry, so trust whichever worker the manifest declares.
  const worker=chrome.runtime.getURL(chrome.runtime.getManifest?.().background?.service_worker||'background.js');
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if(sender.id!==chrome.runtime.id||sender.url!==worker){
      if(sender.id!==chrome.runtime.id||sender.tab||sender.url)return;
    }
    if(message?.type==='agent:clear-pointer'){globalThis.PageAgentPointer?.clear();respond({ok:true});return;}
    if(!['agent:observe','agent:execute','agent:verify','agent:prepare-navigation','agent:document','agent:frame-guard','agent:consume','agent:point','agent:settle','agent:shot','agent:unshot','agent:viewport'].includes(message?.type))return;
    let dispatched=false;
    (async()=>{
      if(message.expectedOrigin&&message.expectedOrigin!==location.origin)throw Object.assign(new Error('页面来源已变化，拒绝读取旧任务范围之外的 DOM'),{code:'ORIGIN_BOUNDARY'});
      if(message.type==='agent:frame-guard')return C.agentFrameGuard(message.key,message.frameURL,message.sensitiveFields===true,message.showPointer===true);
      if(message.type==='agent:document')return {documentId,url:location.href};
      // click_point: read-only geometry compared with the screenshot's before a real click is sent.
      if(message.type==='agent:viewport'){const win=document.defaultView;return {documentId,url:location.href,viewport:{width:win.innerWidth,height:win.innerHeight},scroll:{x:win.scrollX||0,y:win.scrollY||0}};}
      if(message.type==='agent:unshot'){if(shield&&shield.shotId===message.shotId)unshield();return {cleared:true};}
      if(document.readyState==='loading')throw Object.assign(new Error('等待页面 DOM 就绪'),{code:'NAVIGATION'});
      if(executing)throw Object.assign(new Error('页面操作尚未完成'),{code:'PAGE_BUSY'});
      if(message.type==='agent:shot'){
        // Measures the area to capture (viewport, or a current snapshot target scrolled into view) and covers sensitive
        // fields; any failure leaves no overlay and no screenshot is taken.
        if(!snapshot||message.snapshotId!==snapshotId||message.url!==location.href)throw Object.assign(new Error('页面快照已失效'),{code:'STALE'});
        unshield();
        const win=document.defaultView;let area=null;
        if(message.id){
          const ref=snapshot.nodes.get(message.id);if(!ref)throw Object.assign(new Error('截图目标不在当前快照中'),{code:'STALE'});
          if(C.agentShotScroll(ref))await new Promise(resolve=>setTimeout(resolve,150));
          area=C.agentShotArea(ref);
        }
        const viewport={width:win.innerWidth,height:win.innerHeight};
        area=area||{left:0,top:0,...viewport};
        shield=cover(C.agentMaskBoxes(document,message.sensitiveFields===true),message.shotId);
        return {area,viewport,scroll:{x:win.scrollX||0,y:win.scrollY||0},dpr:win.devicePixelRatio||1,masked:shield?shield.host.children.length:0};
      }
      const authorized=message.sensitiveFields===true;
      if(message.type==='agent:execute'&&snapshot?.sensitiveFields!==authorized)throw Object.assign(new Error('敏感字段授权已变化，请重新观察'),{code:'STALE'});
      sensitiveFields=authorized;
      if(message.type==='agent:observe'){
        globalThis.PageAgentPointer?.start?.(document);
        snapshot=capture(message.textOffset??0);snapshotId=crypto.randomUUID();lastAction=null;
        return {snapshotId,documentId,url:location.href,readyState:document.readyState,page:snapshot.page};
      }
      if(message.type==='agent:verify'){
        const current=captureForChecks(message.expected),check=G.evaluate(message.expected,current);
        return T.result({...check,operationId:message.operationId,documentId,dispatch:'not_sent',scope:'page',code:check.status==='success'?'CONDITIONS_MATCH':'CONDITIONS_UNMET',recovery:check.status==='success'?'none':'wait',message:check.status==='success'?'预期条件已满足':'预期条件尚未满足或证据不足'});
      }
      if(message.type==='agent:point'||message.type==='agent:settle'){
        const action=lastAction;
        if(!action||message.operationId!==action.operationId||message.url!==location.href)throw Object.assign(new Error('真实输入目标已失效，请重新观察'),{code:'STALE'});
        if(message.type==='agent:point'){
          // After an ineffective attempt, real input only if nothing changed since before it; the point comes from the same
          // target, and the page right after measuring becomes the baseline for agent:settle.
          if(message.reason!=='unreachable'&&fingerprint()!==action.before)throw Object.assign(new Error('页面已有变化，不改用真实输入'),{code:'PAGE_CHANGED'});
          const point=C.agentInputPoint(action.ref.node,action.snap,action.ref.signature);action.before=fingerprint();return point;
        }
        lastAction=null;executing=true;
        try{return report(action.operationId,action.expected,await settle(action.before),{input:'cdp'});}finally{executing=false;sensitiveFields=false;}
      }
      if(!snapshot||message.snapshotId!==snapshotId||message.url!==location.href||message.documentId&&message.documentId!==documentId)throw Object.assign(new Error('页面快照已失效'),{code:'STALE'});
      if(message.type==='agent:consume'){snapshot=null;snapshotId=null;return {consumed:true};}
      const plan=C.agentPlan(JSON.stringify(message.plan),snapshot);
      if(message.type==='agent:prepare-navigation'){
        if(plan.action!=='navigate')throw Object.assign(new Error('导航准备动作无效'),{code:'STALE'});
        snapshot=null;snapshotId=null;return {prepared:true,documentId};
      }
      if(plan.action==='navigate')throw Object.assign(new Error('导航须由可信后台派发'),{code:'NAVIGATION_DENIED',beforeDispatch:true});
      const captured=snapshot,before=fingerprint();
      const expected=message.expected||G.bind(plan.expected||G.automatic(plan),captured);
      if(expected.length)G.validate(expected);
      snapshot=null;snapshotId=null;executing=true;
      lastAction=['click','hover'].includes(plan.action)?{operationId:message.operationId,ref:captured.nodes.get(plan.id),snap:captured,before,expected}:null;
      try{
        dispatched=true;const interaction=C.agentExecute(plan,captured,document);
        const changed=await settle(before),verification=C.agentVerify(plan,captured);
        const r=report(message.operationId,expected,changed,verification?{actual:verification.actual??null}:interaction||null);
        // pageChange is internal: the background uses it to decide on the real-input fallback and strips it.
        return {...r,verification,navigation:false,pageChange:changed};
      }finally{executing=false;sensitiveFields=false;}
    })().then(value=>respond({ok:true,value}),error=>{
      const result=T.failure(error,{operationId:message.operationId,documentId,dispatch:dispatched&&error.code!=='STALE'&&!error.beforeDispatch?'unknown':'not_sent'});
      respond({ok:false,error:result.message,code:result.code,result});
    });
    return true;
  });
  void chrome.runtime.sendMessage({type:'pageReady'}).catch(()=>{});
})();
