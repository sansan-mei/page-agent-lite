(function(root){
  'use strict';
  const statuses=['success','not_satisfied','pending','unknown','unsupported','error'];
  const dispatches=['not_sent','sent','unknown'];
  const scopes=['dispatch','ui','page'];
  const recoveries=['none','wait','observe','relocate','replan','pause'];
  function result(data={}){
    const r={version:2,operationId:data.operationId||null,documentId:data.documentId||null,
      status:data.status||'unknown',dispatch:data.dispatch||'not_sent',scope:data.scope||'dispatch',
      code:data.code||'UNVERIFIED',observed:data.observed??null,evidence:(data.evidence||[]).slice(0,5),
      recovery:data.recovery||'none',message:String(data.message||'').slice(0,500)};
    if(!statuses.includes(r.status)||!dispatches.includes(r.dispatch)||!scopes.includes(r.scope)||!recoveries.includes(r.recovery)||!/^[A-Z][A-Z0-9_]{0,60}$/.test(r.code))throw new Error('工具结果协议无效');
    if(JSON.stringify(r.observed).length>4500)r.observed={truncated:true};
    if(JSON.stringify(r.evidence).length>6500)r.evidence=r.evidence.map(e=>({kind:e.kind,matched:e.matched,code:e.code}));
    return r;
  }
  function normalize(raw={},meta={}){
    meta=Object.fromEntries(Object.entries(meta).filter(([,v])=>v!==undefined));
    if(raw.version===2)return {...raw,...result({...raw,...meta})};
    let value={status:'unknown',dispatch:'sent',code:'LEGACY_UNVERIFIED',recovery:'observe',message:raw.message};
    if(raw.verification)value={...value,status:raw.verification.verified?'success':'unknown',scope:'ui',
      code:raw.verification.verified?'FIELD_MATCH':'FIELD_UNVERIFIED',recovery:raw.verification.verified?'none':'pause',
      observed:{actual:raw.verification.actual},evidence:[{kind:'field',matched:raw.verification.verified}]};
    if(raw.navigation||raw.connection)value={...value,status:'unknown',dispatch:'unknown',code:raw.connection==='reconnected'?'PORT_RECONNECTED':'DOCUMENT_CHANGED',recovery:raw.navigation?'wait':'observe'};
    return {...raw,legacy:true,...result({...value,...meta})};
  }
  function failure(error,meta={}){
    const code=error?.code||'TOOL_ERROR';
    const known={NAVIGATION_DENIED:['error','not_sent','pause'],UNSUPPORTED_EDITABLE:['unsupported','not_sent','pause'],INPUT_CANCELLED:['unknown','unknown','pause'],INVALID_FIELD_VALUE:['error','not_sent','pause'],TARGET_BLOCKED:['unknown','not_sent','relocate'],TARGET_CHANGED:['unknown','unknown','observe'],STALE:['unknown','not_sent','relocate'],PAGE_BUSY:['pending','not_sent','wait'],NAVIGATION:['pending','not_sent','wait'],PERMISSION_DENIED:['error','not_sent','pause'],UNSUPPORTED_PAGE:['unsupported','not_sent','pause'],TAB_CLOSED:['error','not_sent','pause'],INVALID_PLAN:['error','not_sent','replan']};
    const [status,dispatch,recovery]=known[code]||['error','unknown','pause'];
    return result({status,dispatch,recovery,observed:error?.observed,code:/^[A-Z][A-Z0-9_]{0,60}$/.test(code)?code:'TOOL_ERROR',message:error?.message,...meta});
  }
  const api={result,normalize,failure};root.PageAgentProtocol=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
