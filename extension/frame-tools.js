(function(root){
  'use strict';
  function create(chrome,T){
    const G=()=>typeof module!=='undefined'?require('./conditions.js'):root.PageAgentConditions;
    const fail=(message,code='STALE')=>Object.assign(new Error(message),{code,beforeDispatch:true});
    async function call(tabId,frameId,message){
      const response=await chrome.tabs.sendMessage(tabId,message,{frameId});
      if(!response?.ok)throw Object.assign(new Error(response?.error||'框架通信中断'),{code:response?.code,result:response?.result});
      return response.value;
    }
    async function permitted(origin,policy){return policy?.allowedOrigins?.includes(origin)&&await chrome.permissions.contains({origins:[origin+'/*']});}
    async function observe(tabId,top,textOffset,policy){
      if(!chrome.webNavigation?.getAllFrames||!policy||!top.page?.frames)return top;
      const frames=await chrome.webNavigation.getAllFrames({tabId})||[],routes={};
      const page=structuredClone(top.page);
      let nextElement=Math.max(-1,...page.elements.map(e=>Number(e.id.slice(1))))+1;
      let nextRegion=Math.max(-1,...page.regions.map(e=>Number(e.id.slice(1))))+1;
      let semanticBudget=4000-(top.page.elements||[]).reduce((n,e)=>n+JSON.stringify(e.context||{}).length,0);
      let textBudget=16000-(page.text?.length||0),regionBudget=5000-page.regions.reduce((n,r)=>n+(r.text?.length||0),0);
      for(const entry of page.frames.filter(f=>f.reason==='cross_origin').slice(0,10)){
        let origin;try{origin=new URL(entry.url).origin;}catch{continue;}
        if(!await permitted(origin,policy)){entry.reason='permission_required';entry.origin=origin;continue;}
        // Match only a unique direct child at its declared URL. Redirected/nested/opaque frames stay unread.
        const matches=frames.filter(f=>f.parentFrameId===0&&f.url===entry.url);
        if(matches.length!==1||page.frames.filter(f=>f.url===entry.url).length!==1)continue;
        const frame=matches[0];
        try{
          await call(tabId,0,{type:'agent:frame-guard',sensitiveFields:policy.sensitiveFields===true,expectedOrigin:policy.origin,key:entry.key,frameURL:entry.url});
          await chrome.scripting.executeScript({target:{tabId,frameIds:[frame.frameId]},files:['tool-protocol.js','conditions.js','core.js','page-pointer.js','content.js'],world:'ISOLATED'});
          const local=await call(tabId,frame.frameId,{type:'agent:observe',expectedOrigin:origin,sensitiveFields:policy.sensitiveFields===true,textOffset});
          // Recheck permissions after asynchronous injection; never forward a newly unauthorized body.
          if(!await permitted(origin,policy))continue;
          const remoteKey='remote:'+frame.frameId+':'+local.documentId;
          entry.key=remoteKey;entry.read=true;entry.nestedUnread=!!local.page.frames?.length;delete entry.reason;entry.origin=origin;
          const base={frameId:frame.frameId,origin,url:entry.url,documentId:local.documentId,snapshotId:local.snapshotId,parentKey:top.page.frames.find(f=>f.id===entry.id).key};
          const groups=new Map();
          let groupBudget=5000-JSON.stringify(page.groups||[]).length;
          for(const g of local.page.groups||[]){if(JSON.stringify(g).length>groupBudget)break;groupBudget-=JSON.stringify(g).length;const id='remote'+frame.frameId+'_'+g.id;groups.set(g.id,id);(page.groups||=[]).push({...g,id});}
          for(const e of local.page.elements){
            if(e.frame)continue; // Nested content is deliberately not promoted to a direct child.
            if(page.elements.length>=120){page.coverage.elementsComplete=false;break;}
            const context=e.context&&JSON.stringify(e.context).length<=semanticBudget?e.context:undefined;
            if(context)semanticBudget-=JSON.stringify(context).length;
            const id='t'+nextElement++;routes[id]={...base,id:e.id};
            page.elements.push({...e,context,id,key:remoteKey+':'+e.key,frame:entry.id,group:groups.get(e.group)});
          }
          for(const r of local.page.regions||[]){
            if(r.frame)continue;
            if(page.regions.length>=40||regionBudget<(r.text?.length||0)){page.coverage.regionsComplete=false;break;}
            regionBudget-=r.text?.length||0;
            page.regions.push({...r,id:'r'+nextRegion++,key:remoteKey+':'+r.key,frame:entry.id});
          }
          const text='\n['+entry.id+' '+entry.label+']\n'+(local.page.text||'');
          if(textBudget>0){page.text+=text.slice(0,textBudget);textBudget-=text.length;}
          for(const name of ['elementsComplete','regionsComplete','textComplete','absenceComplete'])page.coverage[name]=page.coverage[name]===true&&local.page.coverage?.[name]===true;
          // Cross-frame absence is conservative, including hidden/nested descendants and budget limits.
          page.coverage.absenceComplete=false;page.coverage.textComplete=false;
          page.coverage.sensitiveExcluded||=local.page.coverage?.sensitiveExcluded===true;
        }catch(error){entry.read=false;entry.reason=error.code==='TARGET_BLOCKED'?'blocked':'unavailable';}
      }
      page.coverage.framesComplete=page.frames.every(f=>f.read&&!f.nestedUnread);
      return {...top,page,frameRoutes:routes};
    }
    async function execute(tabId,pending,policy,live,helpers){
      await helpers.checkOrigin(tabId,policy);
      const route=pending.frameRoute;
      const plan={...pending.plan};delete plan.expected;
      if(route){
        if(!await permitted(route.origin,policy))throw fail('框架网站未授权','PERMISSION_DENIED');
        const frames=await chrome.webNavigation.getAllFrames({tabId});
        if(!frames.some(f=>f.frameId===route.frameId&&f.parentFrameId===0&&f.url===route.url))throw fail('框架已导航或移除');
        await helpers.call(tabId,{type:'agent:frame-guard',showPointer:true,sensitiveFields:policy.sensitiveFields===true,expectedOrigin:policy.origin,key:route.parentKey,frameURL:route.url});
        await helpers.call(tabId,{type:'agent:consume',snapshotId:pending.snapshotId,documentId:pending.documentId,url:pending.url,expectedOrigin:policy.origin});
        plan.id=route.id;
      }
      if(route&&!await permitted(route.origin,policy))throw fail('框架权限已撤销','PERMISSION_DENIED');
      if(live&&!await live())throw fail('动作已取消','CANCELLED');
      // All side effects remain a single dispatch. A lost reply must never trigger another execute.
      let outcome;
      try{
        outcome=await call(tabId,route?.frameId||0,{type:'agent:execute',...pending,plan,expected:[],snapshotId:route?.snapshotId||pending.snapshotId,documentId:route?.documentId||pending.documentId,url:route?.url||pending.url,expectedOrigin:route?.origin||policy.origin,sensitiveFields:policy.sensitiveFields===true});
      }catch(error){
        if(error.code)throw error;
        return T.result({operationId:pending.operationId,status:'unknown',dispatch:'unknown',scope:'dispatch',code:'FRAME_RESPONSE_LOST',recovery:'observe',message:'框架动作回执丢失，只读核对，不重发'});
      }
      if(pending.expected?.length){
        try{
          const snap=await helpers.observe(tabId,0,policy),check=G().evaluate(pending.expected,snap);
          return T.result({...check,operationId:pending.operationId,documentId:pending.documentId,dispatch:outcome.dispatch||'sent',scope:'page',code:check.status==='success'?'CONDITIONS_MATCH':'CONDITIONS_UNMET',recovery:check.status==='success'?'none':'wait'});
        }catch{return T.result({operationId:pending.operationId,status:'unknown',dispatch:outcome.dispatch||'sent',code:'FRAME_VERIFICATION_UNAVAILABLE',recovery:'observe'});}
      }
      return outcome;
    }
    return {observe,execute};
  }
  root.PageAgentFrameTools={create};if(typeof module!=='undefined')module.exports=root.PageAgentFrameTools;
})(globalThis);
