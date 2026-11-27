'use strict';
(() => {
  const $=id=>document.getElementById(id),t=PageAgentI18n.t;
  async function send(type,extra={}){
    const result=await chrome.runtime.sendMessage({type,...extra});
    if(!result?.ok)throw new Error(result?.error||t('commonMessagingFailed'));return result.value;
  }
  let globalVersion=null,globalData=null,globalBusy=false,globalReadGeneration=0;
  function globalControls(){
    for(const button of $('global-memories').querySelectorAll('button'))button.disabled=globalBusy;
    for(const id of ['global-memory-save','global-memory-refresh','global-memory-clear','global-memory-export'])$(id).disabled=globalBusy||(id!=='global-memory-refresh'&&globalVersion===null);
  }
  async function refreshGlobalMemory(){
    const read=++globalReadGeneration;
    try{
      const data=await send('task:global-memory');if(read!==globalReadGeneration)return;
      if(!data||data.scope!=='global'||!Array.isArray(data.notes))throw new Error(t('commonMemoryReadFailed'));
      globalVersion=data.version;globalData=data;$('global-memories').replaceChildren();
      for(const note of data.notes){
        const item=document.createElement('div'),p=document.createElement('p');p.textContent=t('commonLabelValue',note.id,note.text);item.append(p);
        const edit=document.createElement('button');edit.type='button';edit.textContent=t('commonEdit');edit.addEventListener('click',()=>{$('global-memory-id').value=note.id;$('global-memory-text').value=note.text;});item.append(edit);
        const remove=document.createElement('button');remove.type='button';remove.textContent=t('commonDelete');remove.disabled=globalBusy;remove.addEventListener('click',()=>void changeGlobalMemory('delete',{id:note.id}));item.append(remove);$('global-memories').append(item);
      }
      $('global-memory-status').textContent=data.notes.length?t('gmCount',data.notes.length):t('gmEmpty');
    }catch(e){if(read===globalReadGeneration){globalVersion=null;globalData=null;$('global-memory-status').textContent=e.message;}}
    finally{globalControls();}
  }
  async function changeGlobalMemory(action,extra={}){
    if(globalBusy||globalVersion===null)return;
    globalBusy=true;globalControls();
    try{
      await send('task:global-memory-change',{action,expectedVersion:globalVersion,...extra});

      if(action==='write'&&$('global-memory-id').value===extra.id&&$('global-memory-text').value===extra.text){$('global-memory-id').value='';$('global-memory-text').value='';}
      await refreshGlobalMemory();$('management-status').textContent=t('gmUpdated');
    }catch(e){$('global-memory-status').textContent=e.message;globalVersion=null;}
    finally{globalBusy=false;globalControls();}
  }
  $('global-memory-refresh').addEventListener('click',()=>void refreshGlobalMemory());
  $('global-memory-clear').addEventListener('click',()=>void changeGlobalMemory('clear'));
  $('global-memory-form').addEventListener('submit',e=>{e.preventDefault();void changeGlobalMemory('write',{id:$('global-memory-id').value.trim(),text:$('global-memory-text').value.trim()});});
  $('global-memory-export').addEventListener('click',()=>{
    if(!globalData||globalBusy)return;
    const url=URL.createObjectURL(new Blob([JSON.stringify({schema:'page-agent-global-memory',version:1,exportedAt:new Date().toISOString(),scope:'global',notes:globalData.notes},null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download='page-agent-global-memory.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
  // Skills are one cross-site library saved by the task review; the page only lists and deletes them.
  let skillVersion=null,skillNotes=[],skillRead=0,skillBusy=false;
  function skillControls(){$('skill-clear').disabled=skillBusy||skillVersion===null||!skillNotes.length;for(const button of $('skills').querySelectorAll('button'))button.disabled=skillBusy;}
  async function refreshSkills(){
    const read=++skillRead;
    try{
      const data=await send('task:skills');if(read!==skillRead)return;
      if(!data||data.scope!=='skills'||!Array.isArray(data.notes))throw new Error(t('commonMemoryReadFailed'));
      skillVersion=data.version;skillNotes=data.notes;$('skills').replaceChildren();
      for(const skill of data.notes){
        const item=document.createElement('div'),title=document.createElement('p'),where=document.createElement('p'),steps=document.createElement('p');
        title.textContent=t('commonLabelValue',skill.id,skill.description);
        where.className='hint';where.textContent=skill.sites?.length?t('mgSkillSites',skill.sites.join(', ')):t('mgSkillGeneral');
        steps.textContent=skill.text;item.append(title,where,steps);
        const remove=document.createElement('button');remove.type='button';remove.textContent=t('commonDelete');remove.addEventListener('click',()=>void changeSkills('delete',{id:skill.id}));item.append(remove);
        $('skills').append(item);
      }
      $('skill-status').textContent=data.notes.length?t('mgSkillCount',data.notes.length):t('mgSkillEmpty');
    }catch(e){if(read===skillRead){skillVersion=null;skillNotes=[];$('skill-status').textContent=e.message;}}
    finally{skillControls();}
  }
  async function changeSkills(action,extra={}){
    if(skillBusy||skillVersion===null)return;
    skillBusy=true;skillControls();
    try{await send('task:skill-change',{action,expectedVersion:skillVersion,...extra});}
    catch(e){$('skill-status').textContent=e.message;}
    finally{skillBusy=false;}
    await refreshSkills();
  }
  $('skill-clear').addEventListener('click',()=>void changeSkills('clear'));

  globalControls();void refreshGlobalMemory();skillControls();void refreshSkills();
})();
