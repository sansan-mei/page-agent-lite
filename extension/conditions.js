(function(root){
  'use strict';
  const kinds=['field_equals','checked_equals','selected_equals','expanded_equals','element_visible','element_absent','text_present','url_changed','url_equals'];
  const descriptorKeys=['category','tag','role','label','name','type','group','key'];
  function validate(list){
    if(!Array.isArray(list)||list.length<1||list.length>5)throw new Error('验证条件必须为 1–5 项');
    for(const c of list){
      if(!c||!kinds.includes(c.kind)||Object.keys(c).some(k=>!['kind','id','target','value','documentId','beforeURL'].includes(k)))throw new Error('验证条件格式无效');
      if(c.kind.startsWith('url_')){
        if(c.id!==undefined||c.target!==undefined)throw new Error('URL 条件不能指定元素');
        if(c.kind==='url_equals'&&(typeof c.value!=='string'||c.value.length>2000||!/^https?:\/\//.test(c.value)))throw new Error('目标 URL 无效');
      }else{
        if(c.id===undefined&&c.target===undefined)throw new Error('验证条件需要目标');
        if(c.id!==undefined&&(typeof c.id!=='string'||! /^[tr]\d{1,4}$/.test(c.id)))throw new Error('验证目标 ID 无效');
        if(c.target!==undefined){
          if(!c.target||typeof c.target!=='object'||Array.isArray(c.target)||!Object.keys(c.target).length||Object.keys(c.target).some(k=>!descriptorKeys.includes(k))||!Object.values(c.target).every(v=>typeof v==='string'&&v.length<=500)||!['element','region'].includes(c.target.category)||!c.target.label&&!c.target.name&&!c.target.key)throw new Error('语义目标需要明确名称或标签');
        }
        if(['field_equals','text_present'].includes(c.kind)&&(typeof c.value!=='string'||c.value.length>(c.kind==='text_present'?300:4000)||c.kind==='text_present'&&!c.value))throw new Error('验证值无效');
        if(['checked_equals','selected_equals','expanded_equals'].includes(c.kind)&&typeof c.value!=='boolean')throw new Error('验证勾选值无效');
      }
    }
    return list;
  }
  function descriptor(item,page){
    const d={category:item.id.startsWith('r')?'region':'element',tag:item.tag||'',role:item.role||'',label:item.label||'',name:item.name||'',type:item.type||'',group:page.groups?.find(g=>g.id===item.group)?.label||''};
    if(!d.label&&!d.name)d.key=item.key||'';
    return d;
  }
  function bind(list,snapshot,policy=null){
    if(Array.isArray(list)&&!list.length)return [];
    validate(list);
    return list.map(c=>{
      const next={...c,documentId:snapshot.documentId||null};
      if(c.kind.startsWith('url_')){
        next.beforeURL=snapshot.url;
        if(c.kind==='url_equals'&&new URL(c.value).origin!==new URL(snapshot.url).origin&&!policy?.allowedOrigins?.includes(new URL(c.value).origin))throw new Error('验证目标超出当前站点');
      }else if(c.id){
        const item=[...snapshot.page.elements,...snapshot.page.regions||[]].find(e=>e.id===c.id);
        if(!item)throw new Error('验证目标不在当前快照中');
        next.target=descriptor(item,snapshot.page);
      }
      return next;
    });
  }
  function evaluate(list,snapshot){
    validate(list);
    const evidence=list.map(c=>{
      const base={kind:c.kind,target:c.target||c.id||null,expected:c.kind==='url_changed'?{differentFrom:c.beforeURL??null}:c.kind==='element_visible'?true:c.kind==='element_absent'?false:c.value??null};
      const answer=(matched,code,actual=null)=>({...base,matched,code,actual});
      if(c.kind==='url_changed')return answer(snapshot.url!==c.beforeURL,'URL_OBSERVED',snapshot.url);
      if(c.kind==='url_equals')return answer(snapshot.url===c.value,'URL_OBSERVED',snapshot.url);
      const all=[...snapshot.page.elements,...snapshot.page.regions||[]];
      if(c.target?.key&&c.documentId!==snapshot.documentId)return answer(null,'DOCUMENT_CHANGED');
      let matches=[];
      // References are never compared across documents. Semantic relocation is
      // read-only and must be unique, including within the original document.
      if(c.target&&Object.values(c.target).some(Boolean))matches=all.filter(item=>{
        const d=descriptor(item,snapshot.page);
        return Object.entries(c.target).every(([k,v])=>k!=='group'&&!v||d[k]===v);
      });
      else if(c.documentId&&snapshot.documentId===c.documentId)matches=all.filter(e=>e.id===c.id);
      if(matches.length>1)return answer(null,'AMBIGUOUS_TARGET');
      if(!matches.length){
        const coverage=snapshot.page.coverage;
        const full=c.target?.category==='region'?coverage?.regionsComplete:coverage?.elementsComplete;
        if(c.kind==='element_absent'&&full===true&&coverage?.absenceComplete!==false&&(!c.documentId||c.documentId===snapshot.documentId))return answer(true,'ABSENCE_VERIFIED');
        return answer(null,full===false?'TRUNCATED_SCOPE':'TARGET_MISSING');
      }
      const item=matches[0];
      if(c.kind==='element_visible')return answer(item.visible!==false,'VISIBILITY_OBSERVED',item.visible!==false);
      if(c.kind==='element_absent')return answer(false,'ELEMENT_PRESENT');
      if(c.kind==='field_equals')return answer(item.value===undefined?null:item.value===c.value,'FIELD_OBSERVED',item.value??null);
      if(c.kind==='checked_equals')return answer(typeof item.checked!=='boolean'?null:item.checked===c.value,'CHECKED_OBSERVED',item.checked??null);
      if(['selected_equals','expanded_equals'].includes(c.kind)){const key=c.kind==='selected_equals'?'selected':'expanded';return answer(typeof item[key]!=='boolean'?null:item[key]===c.value,key==='selected'?'SELECTED_OBSERVED':'EXPANDED_OBSERVED',item[key]??null);}
      if(item.text===undefined)return answer(null,'TEXT_SCOPE_UNAVAILABLE');
      const matched=item.text.includes(c.value);
      return answer(!matched&&item.textTruncated?null:matched,matched?'TEXT_FOUND':item.textTruncated?'TRUNCATED_SCOPE':'TEXT_NOT_FOUND',item.text.slice(0,500));
    });
    return {status:evidence.some(e=>e.matched===false)?'not_satisfied':evidence.some(e=>e.matched===null)?'unknown':'success',evidence};
  }
  function automatic(plan){
    if(plan.action==='navigate')return [{kind:'url_equals',value:plan.value}];
    if(plan.action==='fill'||plan.action==='select')return [{kind:'field_equals',id:plan.id,value:plan.value}];
    if(plan.action==='check')return [{kind:'checked_equals',id:plan.id,value:plan.value}];
    return [];
  }
  const api={validate,bind,evaluate,automatic,descriptor};root.PageAgentConditions=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
