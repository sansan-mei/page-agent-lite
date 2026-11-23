(function () {
  'use strict';
  if (globalThis.__pageAgentTools) return;
  globalThis.__pageAgentTools = true;
  const C=globalThis.PageAgentCore,G=globalThis.PageAgentConditions,T=globalThis.PageAgentProtocol;
  const documentId=crypto.randomUUID();
  let snapshot=null,snapshotId=null,executing=false;
  function capture(){return {...C.agentSnapshot(document),documentId,url:location.href};}
  function fingerprint(){return JSON.stringify(capture().page);}
  async function settle(before){
    const start=Date.now();let last=before,stable=0;
    while(Date.now()-start<600){
      await new Promise(resolve=>setTimeout(resolve,100));
      const next=fingerprint();stable=next===last?stable+1:0;last=next;
      if(stable>=1&&next!==before)break;
    }
    return last===before?'NO_CHANGE':'PAGE_CHANGED';
  }
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if(sender.id!==chrome.runtime.id||sender.url!==chrome.runtime.getURL('background.js')){
      if(sender.id!==chrome.runtime.id||sender.tab||sender.url)return;
    }
    if(message?.type==='agent:clear-pointer'){globalThis.PageAgentPointer?.clear();respond({ok:true});return;}
    if(!['agent:observe','agent:execute','agent:verify'].includes(message?.type))return;
    let dispatched=false;
    (async()=>{
      if(document.readyState==='loading')throw Object.assign(new Error('等待页面 DOM 就绪'),{code:'NAVIGATION'});
      if(executing)throw Object.assign(new Error('页面操作尚未完成'),{code:'PAGE_BUSY'});
      if(message.type==='agent:observe'){
        snapshot=capture();snapshotId=crypto.randomUUID();
        return {snapshotId,documentId,url:location.href,readyState:document.readyState,page:snapshot.page};
      }
      if(message.type==='agent:verify'){
        const current=capture(),check=G.evaluate(message.expected,current);
        return T.result({...check,operationId:message.operationId,documentId,dispatch:'not_sent',scope:'page',code:check.status==='success'?'CONDITIONS_MATCH':'CONDITIONS_UNMET',recovery:check.status==='success'?'none':'wait',message:check.status==='success'?'预期条件已满足':'预期条件尚未满足或证据不足'});
      }
      if(!snapshot||message.snapshotId!==snapshotId||message.url!==location.href||message.documentId&&message.documentId!==documentId)throw Object.assign(new Error('页面快照已失效'),{code:'STALE'});
      const plan=C.agentPlan(JSON.stringify(message.plan),snapshot);
      const captured=snapshot,before=fingerprint();
      const expected=message.expected||G.bind(plan.expected||G.automatic(plan),captured);
      if(expected.length)G.validate(expected);
      snapshot=null;snapshotId=null;executing=true;
      try{
        dispatched=true;const interaction=C.agentExecute(plan,captured,document);
        const changed=await settle(before),verification=C.agentVerify(plan,captured);
        const current=capture();
        const check=expected.length?G.evaluate(expected,current):null;
        const r=T.result({operationId:message.operationId,documentId,status:check?.status||'unknown',dispatch:'sent',scope:check?'ui':'dispatch',code:check?(check.status==='success'?'CONDITIONS_MATCH':'CONDITIONS_UNMET'):changed,
          evidence:check?.evidence||[],observed:verification?{actual:verification.actual??null}:interaction||null,recovery:check?.status==='success'?'none':expected.length?'wait':'observe',
          message:check?.status==='success'?'指定预期已核实（不代表服务端保存或整个任务完成）':expected.length?'操作已发出，正在等待预期结果':changed==='NO_CHANGE'?'操作已发出，暂未观察到页面变化':'操作已发出，页面有变化；具体效果待核对'});
        return {...r,verification,navigation:false};
      }finally{executing=false;}
    })().then(value=>respond({ok:true,value}),error=>{
      const result=T.failure(error,{operationId:message.operationId,documentId,dispatch:dispatched&&error.code!=='STALE'&&!error.beforeDispatch?'unknown':'not_sent'});
      respond({ok:false,error:result.message,code:result.code,result});
    });
    return true;
  });
  void chrome.runtime.sendMessage({type:'pageReady'}).catch(()=>{});
})();
