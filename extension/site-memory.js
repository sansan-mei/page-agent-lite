(function(root){
  'use strict';
  const conflict=()=>Object.assign(new Error('网站长期记忆已更新，请刷新后重试'),{code:'MEMORY_CONFLICT'});
  function originKey(value){
    const u=new URL(value);
    if(!['http:','https:'].includes(u.protocol)||u.origin!==value)throw new Error('长期记忆网站源无效');
    return u.origin;
  }
  function validNote(id,text){
    if(typeof id!=='string'||! /^[a-zA-Z0-9_-]{1,60}$/.test(id)||typeof text!=='string'||!text.trim()||text.length>2000)throw new Error('长期记忆名称或内容无效（名称限英文数字、下划线和短横线；内容最多 2000 字符）');
  }
  function createSiteMemory({factory=root.indexedDB,name='page-agent-memory',now=()=>Date.now()}={}){
    let opening;
    function open(){
      if(!opening){
        const pending=new Promise((resolve,reject)=>{
          if(!factory){reject(new Error('浏览器不支持长期记忆数据库'));return;}
          const request=factory.open(name,1);let blocked=false;
          request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains('sites'))request.result.createObjectStore('sites',{keyPath:'origin'});};
          request.onerror=()=>reject(new Error('无法打开长期记忆数据库'));
          request.onblocked=()=>{blocked=true;reject(new Error('长期记忆数据库被其他扩展页面占用，请关闭后重试'));};
          request.onsuccess=()=>{
            const db=request.result;if(blocked){db.close();return;}
            db.onversionchange=()=>{db.close();opening=null;};
            resolve(db);
          };
        });
        opening=pending;pending.catch(()=>{if(opening===pending)opening=null;});
      }
      return opening;
    }
    async function read(origin){
      originKey(origin);const db=await open();
      return new Promise((resolve,reject)=>{
        const tx=db.transaction('sites','readonly'),request=tx.objectStore('sites').get(origin);
        tx.oncomplete=()=>resolve(request.result||{origin,version:0,notes:[]});
        tx.onabort=()=>reject(new Error('读取长期记忆失败'));
        tx.onerror=()=>{};
      });
    }
    async function change(origin,{action,id,text,expectedVersion,source='user',signal}={}){
      originKey(origin);
      if(!['write','delete','clear'].includes(action)||!Number.isSafeInteger(expectedVersion)||expectedVersion<0)throw new Error('长期记忆操作无效');
      if(action==='write')validNote(id,text);
      if(action==='delete')validNote(id,'delete');
      const db=await open();
      if(signal?.aborted)throw new Error('长期记忆操作已取消');
      return new Promise((resolve,reject)=>{
        const tx=db.transaction('sites','readwrite'),store=tx.objectStore('sites');let saved,error;
        const abort=()=>{error=new Error('长期记忆操作已取消');try{tx.abort();}catch{}};
        signal?.addEventListener('abort',abort,{once:true});
        const clean=()=>signal?.removeEventListener('abort',abort);
        tx.oncomplete=()=>{clean();resolve(saved);};
        tx.onabort=()=>{clean();reject(error||new Error('保存长期记忆失败，原数据未修改'));};
        tx.onerror=()=>{};
        const request=store.get(origin);
        request.onsuccess=()=>{
          try{
            const current=request.result||{origin,version:0,notes:[]};
            if(current.version!==expectedVersion)throw conflict();
            let notes=current.notes.filter(n=>action==='clear'?false:n.id!==id);
            if(action==='write')notes.push({id,text:text.trim(),source:source==='model'?'model':'user',createdAt:current.notes.find(n=>n.id===id)?.createdAt||now(),updatedAt:now()});
            if(notes.length>32||JSON.stringify(notes).length>64000)throw new Error('长期记忆容量已满（每站 32 条 / 64000 字符），请先整理');
            saved={origin,version:current.version+1,notes};store.put(saved);
          }catch(e){error=e;tx.abort();}
        };
      });
    }
    async function close(){if(opening){const db=await opening;db.close();opening=null;}}
    return {read,change,close};
  }
  const api={createSiteMemory,validNote,originKey};root.PageAgentSiteMemory=api;
  if(typeof module!=='undefined')module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
