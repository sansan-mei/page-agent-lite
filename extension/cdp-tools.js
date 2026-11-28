(function(root){
  'use strict';
  // Real input through chrome.debugger (CDP). Only the methods below can ever be sent; the model never
  // chooses a method, parameters or coordinates. One session per executing tab, owned by one task,
  // attached on first use and detached when the runtime releases the tab or the browser detaches it.
  const MOUSE_TYPES=['mouseMoved','mousePressed','mouseReleased'];
  const MOUSE_KEYS=['type','x','y','button','buttons','clickCount','pointerType'];
  function mouseParams(p){
    if(!p||typeof p!=='object'||Object.keys(p).some(k=>!MOUSE_KEYS.includes(k)))return false;
    if(!MOUSE_TYPES.includes(p.type)||![p.x,p.y].every(v=>Number.isFinite(v)&&v>=0&&v<=100000))return false;
    if(!['none','left'].includes(p.button)||![0,1].includes(p.buttons)||![0,1].includes(p.clickCount)||p.pointerType!=='mouse')return false;
    return true;
  }
  const METHODS=Object.freeze({'Input.dispatchMouseEvent':mouseParams});
  const fail=(code,message,dispatch='not_sent')=>Object.assign(new Error(message),{code,dispatch});
  function create(chrome){
    const api=chrome?.debugger;
    const sessions=new Map(); // tabId -> {taskId, ready, attached, detached}
    const declined=new Set(); // taskIds whose user cancelled the debugging infobar; never re-attached
    const available=()=>!!(api&&typeof api.attach==='function'&&typeof api.sendCommand==='function'&&typeof api.detach==='function');
    if(available()&&api.onDetach?.addListener)api.onDetach.addListener((source,reason)=>{
      const tabId=source?.tabId,session=sessions.get(tabId);if(!session)return;
      session.detached=reason||'detached';sessions.delete(tabId);
      if(reason==='canceled_by_user'){declined.add(session.taskId);while(declined.size>50)declined.delete(declined.values().next().value);}
    });
    async function attach(tabId){
      try{await api.attach({tabId},'1.3');return;}
      catch(error){
        const text=String(error?.message||'');
        if(!/already attached/i.test(text))throw fail('CDP_UNAVAILABLE','无法连接真实输入通道：'+text.slice(0,120));
      }
      // A session left by a restarted worker is ours and can be detached; another debugger (DevTools, another extension) cannot.
      try{await api.detach({tabId});}catch{throw fail('CDP_BUSY','该标签页已被其他调试器占用（如开发者工具），无法使用真实输入');}
      try{await api.attach({tabId},'1.3');}catch{throw fail('CDP_BUSY','该标签页已被其他调试器占用（如开发者工具），无法使用真实输入');}
    }
    async function ensure(tabId,taskId){
      if(!available())throw fail('CDP_UNAVAILABLE','浏览器不支持真实输入通道');
      if(typeof taskId!=='string'||!taskId)throw fail('CDP_UNAVAILABLE','真实输入缺少任务身份');
      if(declined.has(taskId))throw fail('CDP_CANCELLED','你已取消本任务的调试连接，真实输入不再自动连接');
      let session=sessions.get(tabId);
      if(session&&session.taskId!==taskId){await release(tabId);session=null;}
      if(!session){
        session={taskId,attached:false,detached:null};
        session.ready=attach(tabId).then(()=>{session.attached=true;});
        sessions.set(tabId,session);
        session.ready.catch(()=>{if(sessions.get(tabId)===session)sessions.delete(tabId);});
      }
      await session.ready;
      // Released (stop, takeover, task end) or detached while attaching: never dispatch on it.
      if(sessions.get(tabId)!==session){
        if(declined.has(taskId))throw fail('CDP_CANCELLED','你已取消本任务的调试连接，真实输入不再自动连接');
        throw fail('CDP_DETACHED','真实输入通道已断开，未发送输入');
      }
      return session;
    }
    async function send(tabId,taskId,method,params){
      const valid=Object.prototype.hasOwnProperty.call(METHODS,method)?METHODS[method]:null;
      if(!valid||!valid(params))throw fail('CDP_METHOD_DENIED','真实输入命令不在允许范围');
      const session=sessions.get(tabId);
      if(!session?.attached||session.taskId!==taskId)throw fail('CDP_DETACHED','真实输入通道已断开');
      try{return await api.sendCommand({tabId},method,params);}
      catch(error){
        const reason=session.detached||(sessions.get(tabId)!==session?'detached':null);
        if(reason==='canceled_by_user'||declined.has(taskId))throw fail('CDP_CANCELLED','你已取消调试连接');
        if(reason)throw fail('CDP_DETACHED','真实输入通道已断开（'+reason+'）');
        throw fail('CDP_COMMAND_FAILED','真实输入命令失败：'+String(error?.message||'').slice(0,120));
      }
    }
    // click: move, press, release at one runtime-computed viewport point; hover: move only.
    // dispatch on failure: not_sent until the press (or the hover move) was attempted, unknown afterwards.
    async function input(tabId,taskId,action,point,live=null){
      if(!['click','hover'].includes(action))throw fail('CDP_METHOD_DENIED','真实输入只支持点击和悬停');
      if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.y))throw fail('CDP_METHOD_DENIED','真实输入坐标无效');
      await ensure(tabId,taskId);
      if(live&&!await live())throw fail('CANCELLED','请求已取消，未发送真实输入');
      const at={x:Math.round(point.x*100)/100,y:Math.round(point.y*100)/100,pointerType:'mouse'};
      const steps=[{type:'mouseMoved',button:'none',buttons:0,clickCount:0}];
      if(action==='click')steps.push({type:'mousePressed',button:'left',buttons:1,clickCount:1},{type:'mouseReleased',button:'left',buttons:0,clickCount:1});
      let effect=false;
      for(const step of steps){
        if(step.type==='mousePressed'&&live&&!await live())throw fail('CANCELLED','请求已取消，未发送点击');
        // Once a press may have reached the page, always try the release and report unknown on any failure.
        if(step.type!=='mouseReleased')effect=action==='hover'||step.type==='mousePressed';
        try{await send(tabId,taskId,'Input.dispatchMouseEvent',{...step,...at});}
        catch(error){error.dispatch=effect?'unknown':'not_sent';throw error;}
      }
      return {dispatch:'sent',input:'cdp'};
    }
    async function release(tabId){
      const session=sessions.get(tabId);sessions.delete(tabId);
      if(!available())return false;
      if(session)try{await session.ready;}catch{return false;}
      // Also clears a session a restarted worker no longer knows about; detach of a tab we never attached just fails.
      try{await api.detach({tabId});return true;}catch{return false;}
    }
    return {available,ensure,input,release,attached:tabId=>sessions.get(tabId)?.attached===true};
  }
  const api={create,METHODS};root.PageAgentCdp=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
