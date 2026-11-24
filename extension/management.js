'use strict';
(() => {
  const $=id=>document.getElementById(id),t=PageAgentI18n.t;
  let tabId=null,tabOrigin=null,selection=0;
  async function send(type,extra={}) {
    const result=await chrome.runtime.sendMessage({type,tabId,...extra});
    if(!result?.ok)throw new Error(result?.error||t('commonMessagingFailed'));return result.value;
  }
  let siteVersion=null,siteData=null,siteBusy=false,siteReadGeneration=0;
  function siteControls(){
    for(const button of $('site-memories').querySelectorAll('button'))button.disabled=siteBusy;
    for(const id of ['site-memory-save','site-memory-refresh','site-memory-clear','site-memory-export'])$(id).disabled=siteBusy||tabId===null||!tabOrigin||(id!=='site-memory-refresh'&&siteVersion===null);
  }
  async function refreshSiteMemory(){
    const target=tabId,version=selection,read=++siteReadGeneration;if(target===null||!tabOrigin)return;
    try{
      const data=await send('task:site-memory');if(target!==tabId||version!==selection||read!==siteReadGeneration)return;
      if(!data||data.origin!==tabOrigin||!Array.isArray(data.notes))throw new Error(t('commonMemoryReadFailed'));
      siteVersion=data.version;siteData=data;$('site-memories').replaceChildren();
      for(const note of data.notes){
        const item=document.createElement('div'),p=document.createElement('p');p.textContent=t('commonLabelValue',note.id,note.text);item.append(p);
        const edit=document.createElement('button');edit.type='button';edit.textContent=t('commonEdit');edit.addEventListener('click',()=>{$('site-memory-id').value=note.id;$('site-memory-text').value=note.text;});item.append(edit);
        const remove=document.createElement('button');remove.type='button';remove.textContent=t('commonDelete');remove.disabled=siteBusy;remove.addEventListener('click',()=>void changeSiteMemory('delete',{id:note.id}));item.append(remove);$('site-memories').append(item);
      }
      $('site-memory-status').textContent=data.notes.length?t('mgSiteCount',data.origin,data.notes.length):t('mgSiteEmpty');
    }catch(e){if(target===tabId&&version===selection&&read===siteReadGeneration){siteVersion=null;siteData=null;$('site-memory-status').textContent=e.message;}}
    finally{siteControls();}
  }
  async function changeSiteMemory(action,extra={}){
    if(siteBusy||siteVersion===null||tabId===null)return;
    const target=tabId,version=selection;siteBusy=true;siteControls();
    try{
      await send('task:site-memory-change',{origin:tabOrigin,action,expectedVersion:siteVersion,...extra});
      if(target!==tabId||version!==selection)return;
      if(action==='write'&&$('site-memory-id').value===extra.id&&$('site-memory-text').value===extra.text){$('site-memory-id').value='';$('site-memory-text').value='';}
      await refreshSiteMemory();$('management-status').textContent=t('mgSiteUpdated');
    }catch(e){if(target===tabId&&version===selection){$('site-memory-status').textContent=e.message;siteVersion=null;}}
    finally{siteBusy=false;siteControls();}
  }
  async function refreshMemory(){
    const target=tabId,version=selection;if(target===null||!tabOrigin)return;
    try{
      const notes=await send('task:memory');if(target!==tabId||version!==selection)return;
      $('memories').replaceChildren();
      for(const note of notes){const p=document.createElement('p');p.textContent=t('commonLabelValue',note.id,note.text);$('memories').append(p);}
      if(!notes.length)$('memories').textContent=t('mgTempEmpty');
    }catch(e){if(target===tabId&&version===selection)$('memories').textContent=e.message;}
  }
  $('site-memory-refresh').addEventListener('click',()=>void refreshSiteMemory());
  $('site-memory-clear').addEventListener('click',()=>void changeSiteMemory('clear'));
  $('site-memory-form').addEventListener('submit',e=>{e.preventDefault();void changeSiteMemory('write',{id:$('site-memory-id').value.trim(),text:$('site-memory-text').value.trim()});});
  $('site-memory-export').addEventListener('click',()=>{
    if(!siteData||siteBusy)return;
    const url=URL.createObjectURL(new Blob([JSON.stringify({schema:'page-agent-site-memory',version:1,exportedAt:new Date().toISOString(),origin:siteData.origin,notes:siteData.notes},null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download='page-agent-memory-'+new URL(siteData.origin).hostname+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
  $('memory-refresh').addEventListener('click',()=>void refreshMemory());
  $('memory-clear').addEventListener('click',()=>void clearMemory());

  async function clearMemory(){
    const version=selection;
    try{await send('task:memory-clear');if(version===selection){await refreshMemory();$('management-status').textContent=t('mgTempCleared');}}
    catch(e){$('management-status').textContent=e.message;}
  }
  function choose(){
    selection++;const option=$('managed-tab').selectedOptions?.[0]||$('managed-tab').querySelector('option:checked');
    tabId=option?Number(option.value):null;tabOrigin=option?.dataset.origin||null;
    siteVersion=null;siteData=null;$('site-memories').replaceChildren();$('memories').replaceChildren();
    $('site-memory-id').value='';$('site-memory-text').value='';$('site-memory-status').textContent='';
    $('memory-clear').disabled=tabId===null;$('memory-refresh').disabled=tabId===null;
    siteControls();void refreshMemory();void refreshSiteMemory();
  }
  async function tabs(){
    try{
      const previous=tabId,items=await chrome.tabs.query({currentWindow:true});$('managed-tab').replaceChildren();
      for(const tab of items){
        if(!tab.url||!/^https?:$/.test(new URL(tab.url).protocol))continue;
        const option=document.createElement('option');option.value=String(tab.id);option.dataset.origin=new URL(tab.url).origin;option.textContent=(tab.title||tab.url)+' · '+option.dataset.origin;
        if(tab.id===previous)option.selected=true;$('managed-tab').append(option);
      }
      choose();if(tabId===null)$('management-status').textContent=t('mgNoTabs');
    }catch(e){$('management-status').textContent=e.message;}
  }
  $('managed-tab').addEventListener('change',choose);$('tabs-refresh').addEventListener('click',()=>void tabs());
  $('grant-all').addEventListener('click',()=>{
    const granted=chrome.permissions.request({origins:['http://*/*','https://*/*']});
    const status=$('grant-all-status')||$('management-status');void granted.then(ok=>{status.textContent=ok?t('mgGrantedAll'):t('mgGrantCanceled');}).catch(e=>{status.textContent=e.message;});
  });
  chrome.tabs.onUpdated.addListener((id,change)=>{if(id===tabId&&change.url)void tabs();});
  chrome.tabs.onRemoved.addListener(id=>{if(id===tabId)void tabs();});
  chrome.storage.onChanged.addListener((changes,area)=>{if(area==='session'&&tabId!==null){if(changes['memory:'+tabId])void refreshMemory();if(changes['task:'+tabId]&&$('site-memory-panel').open)void refreshSiteMemory();}});
  void tabs();
})();
