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
  // Skills are saved by the task review; the page only lists and deletes them.
  let skillVersion=null,skillNotes=[],skillRead=0,skillBusy=false;
  function skillControls(){$('site-skill-clear').disabled=skillBusy||skillVersion===null||!skillNotes.length;for(const button of $('site-skills').querySelectorAll('button'))button.disabled=skillBusy;}
  async function refreshSkills(){
    const target=tabId,version=selection,read=++skillRead;if(target===null||!tabOrigin)return;
    try{
      const data=await send('task:site-skills');if(target!==tabId||version!==selection||read!==skillRead)return;
      if(!data||data.origin!==tabOrigin||!Array.isArray(data.notes))throw new Error(t('commonMemoryReadFailed'));
      skillVersion=data.version;skillNotes=data.notes;$('site-skills').replaceChildren();
      for(const skill of data.notes){
        const item=document.createElement('div'),title=document.createElement('p'),steps=document.createElement('p');
        title.textContent=t('commonLabelValue',skill.id,skill.description);steps.textContent=skill.text;item.append(title,steps);
        const remove=document.createElement('button');remove.type='button';remove.textContent=t('commonDelete');remove.addEventListener('click',()=>void changeSkills('delete',{id:skill.id}));item.append(remove);
        $('site-skills').append(item);
      }
      $('site-skill-status').textContent=data.notes.length?t('mgSkillCount',data.notes.length):t('mgSkillEmpty');
    }catch(e){if(target===tabId&&version===selection&&read===skillRead){skillVersion=null;skillNotes=[];$('site-skill-status').textContent=e.message;}}
    finally{skillControls();}
  }
  async function changeSkills(action,extra={}){
    if(skillBusy||skillVersion===null||tabId===null)return;
    skillBusy=true;skillControls();
    try{await send('task:site-skill-change',{origin:tabOrigin,action,expectedVersion:skillVersion,...extra});}
    catch(e){$('site-skill-status').textContent=e.message;}
    finally{skillBusy=false;}
    await refreshSkills();
  }
  $('site-skill-clear').addEventListener('click',()=>void changeSkills('clear'));
  $('site-memory-refresh').addEventListener('click',()=>void refreshSiteMemory());
  $('site-memory-clear').addEventListener('click',()=>void changeSiteMemory('clear'));
  $('site-memory-form').addEventListener('submit',e=>{e.preventDefault();void changeSiteMemory('write',{id:$('site-memory-id').value.trim(),text:$('site-memory-text').value.trim()});});
  $('site-memory-export').addEventListener('click',()=>{
    if(!siteData||siteBusy)return;
    const url=URL.createObjectURL(new Blob([JSON.stringify({schema:'page-agent-site-memory',version:1,exportedAt:new Date().toISOString(),origin:siteData.origin,notes:siteData.notes},null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download='page-agent-memory-'+new URL(siteData.origin).hostname+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
  function choose(){
    selection++;const option=$('managed-tab').selectedOptions?.[0]||$('managed-tab').querySelector('option:checked');
    tabId=option?Number(option.value):null;tabOrigin=option?.dataset.origin||null;
    siteVersion=null;siteData=null;$('site-memories').replaceChildren();
    $('site-memory-id').value='';$('site-memory-text').value='';$('site-memory-status').textContent='';
    skillVersion=null;skillNotes=[];$('site-skills').replaceChildren();$('site-skill-status').textContent='';
    siteControls();void refreshSiteMemory();void refreshSkills();
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
  chrome.storage.onChanged.addListener((changes,area)=>{if(area==='session'&&tabId!==null){if(changes['task:'+tabId]&&$('site-memory-panel').open)void refreshSiteMemory();}});
  void tabs();
})();
