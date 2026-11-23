'use strict';
(() => {
  const $=id=>document.getElementById(id);
  let tabId=null,task=null,busy=false,selection=0,tabOrigin=null;
  const labels={running:'执行中',waiting_page:'等待网页',waiting_confirmation:'等待确认',paused:'已暂停',stopped:'已停止',failed:'执行失败',completed:'已完成',ended:'已结束'};
  let siteVersion=null,siteData=null,siteBusy=false,siteReadGeneration=0;
  function siteControls(){
    for(const button of $('site-memories').querySelectorAll('button'))button.disabled=siteBusy;
    for(const id of ['site-memory-save','site-memory-refresh','site-memory-clear','site-memory-export'])$(id).disabled=siteBusy||tabId===null||!tabOrigin||(id!=='site-memory-refresh'&&siteVersion===null);
  }
  async function refreshSiteMemory(){
    const target=tabId,version=selection,read=++siteReadGeneration;if(target===null||!tabOrigin)return;
    try{
      const data=await send('task:site-memory');if(target!==tabId||version!==selection||read!==siteReadGeneration)return;
      if(!data||data.origin!==tabOrigin||!Array.isArray(data.notes))throw new Error('长期记忆读取失败');
      siteVersion=data.version;siteData=data;$('site-memories').replaceChildren();
      for(const note of data.notes){
        const item=document.createElement('div'),p=document.createElement('p');p.textContent=note.id+'：'+note.text;item.append(p);
        const edit=document.createElement('button');edit.type='button';edit.textContent='编辑';edit.addEventListener('click',()=>{$('site-memory-id').value=note.id;$('site-memory-text').value=note.text;});item.append(edit);
        const remove=document.createElement('button');remove.type='button';remove.textContent='删除';remove.disabled=siteBusy;remove.addEventListener('click',()=>void changeSiteMemory('delete',{id:note.id}));item.append(remove);$('site-memories').append(item);
      }
      $('site-memory-status').textContent=data.notes.length?`${data.origin} · ${data.notes.length}/32 条`:'本站暂无长期记忆';
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
      await refreshSiteMemory();$('status').textContent='网站长期记忆已更新，相关运行任务已暂停，可点击继续。';
    }catch(e){if(target===tabId&&version===selection){$('site-memory-status').textContent=e.message;siteVersion=null;}}
    finally{siteBusy=false;siteControls();}
  }
  async function refreshMemory(){
    const target=tabId,version=selection;if(target===null||!tabOrigin)return;
    try{
      const notes=await send('task:memory');if(target!==tabId||version!==selection)return;
      $('memories').replaceChildren();
      for(const note of notes){const p=document.createElement('p');p.textContent=note.id+'：'+note.text;$('memories').append(p);}
      if(!notes.length)$('memories').textContent='暂无临时记忆';
    }catch(e){if(target===tabId&&version===selection)$('memories').textContent=e.message;}
  }
  async function send(type,extra={}){
    const result=await chrome.runtime.sendMessage({type,tabId,...extra});
    if(!result?.ok)throw new Error(result?.error||'扩展通信失败');return result.value;
  }
  function render(){
    siteControls();
    $('goal').textContent=task?.goal||'还没有任务';
    const usage=task?.contextUsage;
    $('context-usage').textContent=usage?`上次请求输入 ${usage.promptTokens} token · 缓存 ${usage.cachedTokens??'未报告'} token`:(task?.contextPressure?`上下文约 ${task.contextPressure.tokens} token（估算）`:'');
    $('context-panel').hidden=!task?.contextSummary;
    $('context-meta').textContent=task?.contextSummary?`已整理 ${task.contextSummary.through} 条较早结果 · ${new Date(task.contextSummary.updatedAt).toLocaleTimeString()}`:'';
    $('context-summary').replaceChildren();
    for(const [key,label] of Object.entries({completed:'已完成及证据',remaining:'待完成',facts:'关键事实与纠正',failed:'失败方法',uncertain:'未确定的操作'})){
      const items=task?.contextSummary?.content?.[key]||[];
      if(items.length){const p=document.createElement('p');p.textContent=label+'：\n'+items.join('\n');p.style.whiteSpace='pre-wrap';$('context-summary').append(p);}
    }
    $('progress').textContent=task?`${labels[task.status]||task.status} · 已执行 ${task.steps} 轮 / ${task.prefs.maxSteps||'不限'} · ${task.prefs.autoClick?'自动点击':'点击需确认'}${task.phase==='thinking'?' · 正在思考':task.phase==='compacting'?' · 正在整理上下文':''}`:'';
    $('verification').hidden=!task?.check&&!task?.lastOutcome;
    const deadline=task?.check?.deadline;
    $('waiting').textContent=task?.check?`正在核对 ${task.check.expected.length} 项预期；截止 ${new Date(deadline).toLocaleTimeString()}`:task?.lastOutcome?`${task.lastOutcome.status} · ${task.lastOutcome.code}（仅代表本次工具结果）`:'';
    $('evidence').replaceChildren();
    for(const item of task?.lastOutcome?.evidence||[]){
      const p=document.createElement('p');p.textContent=`${item.kind} · ${item.matched===true?'匹配':item.matched===false?'不匹配':'未知'} · ${item.code||''} · 目标 ${JSON.stringify(item.target)} · 预期 ${JSON.stringify(item.expected)} · 实际 ${JSON.stringify(item.actual)}`;$('evidence').append(p);
    }
    $('timeline').replaceChildren();
    for(const e of [...(task?.events||[])].reverse()){const p=document.createElement('p'),time=document.createElement('time');time.textContent=new Date(e.time).toLocaleTimeString();p.append(time,document.createTextNode(e.text));$('timeline').append(p);}
    $('confirmation').hidden=task?.status!=='waiting_confirmation';
    const pending=task?.pending;
    $('operation').textContent=pending?`${pending.plan.action} → ${pending.label}${pending.plan.value!==undefined?'；内容：'+String(pending.plan.value):''}`:'';
    for(const id of ['start','article','grant','grant-all'])$(id).disabled=busy||tabId===null||!tabOrigin;
    const ongoing=task&&!['completed','ended'].includes(task.status);
    $('start').textContent=ongoing?'发送并继续当前任务':'发送并开始任务';
    $('stop').disabled=!task||!['running','waiting_page','waiting_confirmation'].includes(task.status);
    $('resume').disabled=busy||!task||['running','waiting_page','ended'].includes(task.status);
    $('finish').disabled=busy||!ongoing;
    for(const id of ['memory-clear','memory-refresh'])$(id).disabled=busy||tabId===null||!tabOrigin;
    $('clear').disabled=busy||!task;$('approve').disabled=busy||!pending;
  }
  async function selectTab(){
    const version=++selection;tabId=null;tabOrigin=null;task=null;siteVersion=null;siteData=null;$('site-memories').replaceChildren();$('site-memory-id').value='';$('site-memory-text').value='';render();
    $('memories').replaceChildren();
    $('status').textContent='';
    try{
      const tabs=await chrome.tabs.query({active:true,currentWindow:true});
      if(version!==selection)return;
      const tab=tabs[0];tabId=tab?.id??null;
      if(tab?.url&&['http:','https:'].includes(new URL(tab.url).protocol))tabOrigin=new URL(tab.url).origin;
      $('target').textContent=tabOrigin?`${tab.title||'当前网页'} · ${tabOrigin}`:'请选择普通 HTTP/HTTPS 网页';
      if(!tabOrigin)$('status').textContent=tab?.url?'浏览器内部页、扩展页面等不支持操作。':'无法读取网页地址，请重新加载扩展并确认新增权限。';
      if(tabId===null){render();return;}
      const value=await send('task:get');if(version!==selection)return;task=value;render();void refreshMemory();void refreshSiteMemory();
    }catch(e){if(version===selection)$('status').textContent=e.message;}
  }
  async function action(type,extra,draft){
    if(tabId===null||busy)return;
    const target=tabId;busy=true;render();$('status').textContent='';
    try{
      const value=await send(type,extra);
      if(tabId===target&&!['task:article','task:memory-clear'].includes(type))task=value;
      if(type==='task:memory-clear'){void refreshMemory();$('status').textContent='当前网站临时记忆已清空。';}
      if(type==='task:submit'&&tabId===target&&$('instruction').value===draft)$('instruction').value='';
    }
    catch(e){$('status').textContent=e.message;}
    finally{busy=false;render();}
  }
  $('chat').addEventListener('submit',e=>{e.preventDefault();const draft=$('instruction').value;if(!draft.trim())return;void action('task:submit',{goal:draft.trim()},draft);});
  for(const [id,type] of Object.entries({stop:'task:stop',resume:'task:resume',finish:'task:finish',clear:'task:clear',article:'task:article'}))$(id).addEventListener('click',()=>void action(type));
  $('approve').addEventListener('click',()=>void action('task:approve',{taskId:task?.taskId}));
  $('settings').addEventListener('click',()=>void chrome.runtime.openOptionsPage());
  $('site-memory-refresh').addEventListener('click',()=>void refreshSiteMemory());
  $('site-memory-clear').addEventListener('click',()=>void changeSiteMemory('clear'));
  $('site-memory-form').addEventListener('submit',e=>{e.preventDefault();void changeSiteMemory('write',{id:$('site-memory-id').value.trim(),text:$('site-memory-text').value.trim()});});
  $('site-memory-export').addEventListener('click',()=>{
    if(!siteData||siteBusy)return;
    const url=URL.createObjectURL(new Blob([JSON.stringify({schema:'page-agent-site-memory',version:1,exportedAt:new Date().toISOString(),origin:siteData.origin,notes:siteData.notes},null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download='page-agent-memory-'+new URL(siteData.origin).hostname+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
  $('memory-refresh').addEventListener('click',()=>void refreshMemory());
  $('memory-clear').addEventListener('click',()=>void action('task:memory-clear'));
  function authorize(all){
    if(busy||!tabOrigin||tabId===null)return;
    const id=tabId,origin=tabOrigin;
    busy=true;render();
    // Request directly from this gesture, before any awaited messages.
    const grant=chrome.permissions.request({origins:all?['http://*/*','https://*/*']:[origin+'/*']});
    void (async()=>{
      try{
        if(!await grant)throw new Error('你取消了网站授权，尚未连接网页');
        await send('task:connect',{tabId:id});
        if(tabId===id)$('status').textContent=all?'所有普通网站已授权，当前网页已连接。':'网站已授权并连接，可以开始或继续任务。';
      }catch(e){if(tabId===id)$('status').textContent=e.message;}
      finally{busy=false;render();}
    })();
  }
  $('grant').addEventListener('click',()=>authorize(false));
  $('grant-all').addEventListener('click',()=>authorize(true));
  $('site-memory-panel').addEventListener('toggle',()=>{if($('site-memory-panel').open)void refreshSiteMemory();});
  chrome.tabs.onActivated.addListener(()=>void selectTab());
  chrome.tabs.onUpdated.addListener((id,change)=>{
    if(id===tabId&&(change.url||change.status==='complete'))void selectTab();
  });
  chrome.storage.onChanged.addListener((changes,area)=>{
    if(area==='session'&&tabId!==null&&changes['task:'+tabId]){task=changes['task:'+tabId].newValue||null;render();if($('site-memory-panel').open)void refreshSiteMemory();}
    if(area==='session'&&tabId!==null&&changes['memory:'+tabId])void refreshMemory();
  });
  void selectTab();
})();
