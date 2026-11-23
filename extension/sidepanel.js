'use strict';
(() => {
  const $=id=>document.getElementById(id);
  let tabId=null,task=null,busy=false,selection=0,tabOrigin=null,composing=false,historyOpen=false,historyTask=null,historyIndex=[],historyRequest=0;
  let permissionCheck=0;
  async function refreshPermissions(){
    const version=++permissionCheck,origin=tabOrigin;
    $('grant').hidden=true;$('grant-all').hidden=true;
    if(!origin)return;
    try{
      const [site,all]=await Promise.all([chrome.permissions.contains({origins:[origin+'/*']}),chrome.permissions.contains({origins:['http://*/*','https://*/*']})]);
      if(version!==permissionCheck||origin!==tabOrigin)return;
      $('grant').hidden=site;$('grant-all').hidden=all;
    }catch(e){
      if(version===permissionCheck&&origin===tabOrigin){$('grant').hidden=false;$('grant-all').hidden=false;}
    }
  }
  const labels={running:'执行中',waiting_page:'等待网页',waiting_confirmation:'等待确认',paused:'已暂停',stopped:'已停止',failed:'执行失败',completed:'已完成',ended:'已结束'};
  async function send(type,extra={}){
    const result=await chrome.runtime.sendMessage({type,tabId,...extra});
    if(!result?.ok)throw new Error(result?.error||'扩展通信失败');return result.value;
  }
  function outcomeLabel(entry,status){
    const outcome=entry.outcome;
    const states={success:'已核实',pending:'等待核对',unknown:'结果未知',error:'执行失败',not_satisfied:'未满足预期',returned:'已返回'};
    if(status!=='unknown'||!outcome)return states[status]||status;
    if(outcome.dispatch==='not_sent'){
      if(outcome.code==='STALE')return '目标过期，未执行';
      if(outcome.code==='TARGET_BLOCKED')return '目标被遮挡，未执行';
      return '未执行';
    }
    // Only ordinary dispatch receipts qualify; lost replies and failed checks stay unknown.
    if(outcome.dispatch==='sent'&&outcome.scope==='dispatch'&&['PAGE_CHANGED','NO_CHANGE'].includes(outcome.code)){
      const scroll=outcome.observed;
      if(entry.action==='scroll'&&scroll&&Number.isFinite(scroll.delta)){
        if(scroll.delta!==0)return '已滚动';
        const direction=entry.request?.value;
        if((['up','left'].includes(direction)&&scroll.atStart===true)||(['down','right'].includes(direction)&&scroll.atEnd===true))return '已到边界';
        return '未观察到滚动';
      }
      return '已派发，待核对';
    }
    return states[status];
  }
  function toolCard(entry,key,expanded){
    const card=document.createElement('details'),summary=document.createElement('summary');
    card.className='tool-call';card.dataset.callKey=key;card.open=expanded.has(key);
    const status=entry.pending?'执行中':entry.outcome?.status||(entry.result?.error?'error':'returned');
    card.dataset.status=status;
    summary.textContent=`ƒ ${entry.action} · ${entry.label||entry.request?.id||'工具调用'} · ${outcomeLabel(entry,status)}`;card.append(summary);
    for(const [label,value] of [['请求参数',entry.request||{action:entry.action,说明:'旧记录未保存完整参数'}],['返回结果',entry.pending?'操作已准备或派发，等待工具返回':entry.outcome||entry.result]]){
      const title=document.createElement('h4'),pre=document.createElement('pre');title.textContent=label;pre.textContent=typeof value==='string'?value:JSON.stringify(value??null,null,2);card.append(title,pre);
    }
    return card;
  }
  function resizeInstruction(){
    const input=$('instruction');input.style.height='0px';input.style.height=input.scrollHeight+'px';
  }
  $('instruction').addEventListener('input',resizeInstruction);
  window.addEventListener('resize',resizeInstruction);
  function render(view=task){
    const current=view;
    view=historyOpen&&historyTask?historyTask:view;
    renderView(view,current);resizeInstruction();
  }
  function renderView(task,current){
    const conversation=$('conversation');
    const follow=conversation.scrollHeight-conversation.scrollTop-conversation.clientHeight<48||!conversation.dataset.taskId||conversation.dataset.taskId!==task?.taskId;
    $('conversation').hidden=historyOpen;$('history-view').hidden=!historyOpen;
    $('history').setAttribute('aria-expanded',String(historyOpen));
    $('composer').hidden=historyOpen;
    const list=$('conversation-list');list.replaceChildren();
    const items=historyIndex.map(item=>item.taskId===current?.taskId?current:item);
    if(current?.taskId&&current.origin===tabOrigin&&!items.some(t=>t.taskId===current.taskId))items.unshift(current);
    for(const item of items){
      const button=document.createElement('button');button.type='button';button.className='conversation-item';button.dataset.taskId=item.taskId;
      button.setAttribute('aria-pressed',String(historyTask?.taskId===item.taskId));
      button.textContent=(item.goal||'未命名对话').slice(0,100)+' · '+(labels[item.status]||item.status)+' · '+new Date(item.updatedAt||0).toLocaleString();
      button.addEventListener('click',()=>void openConversation(item.taskId));list.append(button);
    }
    $('history-empty').hidden=!!items.length;$('history-goal').textContent=historyTask?.goal||'';
    const messageList=$('timeline');
    if(historyOpen&&historyTask)$('history-messages').append(messageList);
    else $('conversation').insertBefore(messageList,$('confirmation'));
    $('history-messages').hidden=!historyTask;
    const fresh=!task||task.status==='ended';
    $('empty-state').hidden=!fresh;$('task').hidden=fresh;$('timeline').hidden=historyOpen?!historyTask:fresh;$('run-details').hidden=historyOpen?!historyTask:!task;
    $('goal').textContent=task?.goal||'';
    $('goal').title=task?.goal||'';
    const usage=task?.contextUsage;
    $('context-usage').textContent=usage?`上次请求输入 ${usage.promptTokens} token · 缓存 ${usage.cachedTokens??'未报告'} token`:(task?.contextPressure?`上下文约 ${task.contextPressure.tokens} token（估算）`:'');
    $('context-panel').hidden=!task?.contextSummary;
    $('context-meta').textContent=task?.contextSummary?`已整理 ${task.contextSummary.through} 条较早结果 · ${new Date(task.contextSummary.updatedAt).toLocaleTimeString()}`:'';
    $('context-summary').replaceChildren();
    for(const [key,label] of Object.entries({completed:'已完成及证据',remaining:'待完成',facts:'关键事实与纠正',failed:'失败方法',uncertain:'未确定的操作'})){
      const items=task?.contextSummary?.content?.[key]||[];
      if(items.length){const p=document.createElement('p');p.textContent=label+'：\n'+items.join('\n');p.style.whiteSpace='pre-wrap';$('context-summary').append(p);}
    }
    const activity={observe:'读取页面',thinking:'正在思考',executing:'正在操作',verifying:'正在核对',compacting:'整理上下文'};
    const active=task&&['running','waiting_page'].includes(task.status);
    $('progress').textContent=!fresh?`${active?(task.status==='waiting_page'?(task.check?.kind==='delay'?'延时等待':'等待网页'):activity[task.phase]||labels[task.status]):labels[task.status]||task.status} · ${task.steps} / ${task.prefs.maxSteps||'不限'} 轮`:'准备就绪';
    $('verification').hidden=!task?.check&&!task?.lastOutcome;
    const deadline=task?.check?.deadline;
    $('waiting').textContent=task?.check?(task.check.kind==='delay'?`正在延时等待；到期 ${new Date(deadline).toLocaleTimeString()}`:`正在核对 ${task.check.expected.length} 项预期；截止 ${new Date(deadline).toLocaleTimeString()}`):task?.lastOutcome?`${task.lastOutcome.status} · ${task.lastOutcome.code}（仅代表本次工具结果）`:'';
    $('evidence').replaceChildren();
    for(const item of task?.lastOutcome?.evidence||[]){
      const p=document.createElement('p');p.textContent=`${item.kind} · ${item.matched===true?'匹配':item.matched===false?'不匹配':'未知'} · ${item.code||''} · 目标 ${JSON.stringify(item.target)} · 预期 ${JSON.stringify(item.expected)} · 实际 ${JSON.stringify(item.actual)}`;$('evidence').append(p);
    }
    $('task-meta').textContent=task?`任务 ${task.taskId||'—'} · 更新 ${new Date(task.updatedAt||Date.now()).toLocaleTimeString()}`:'';
    const phases={observe:'读取页面',thinking:'请求模型',executing:'执行操作',verifying:'核对结果',confirm:'等待确认',compacting:'整理上下文',idle:'空闲'};
    $('metrics').textContent=task?`阶段：${phases[task.phase]||task.phase||'—'} · 观察 ${task.metrics?.observations||0} · 操作 ${task.metrics?.actions||0} · 核对 ${task.metrics?.verifications||0}${task.reason?' · 暂停/失败代码：'+task.reason:''}`:'';
    const records=task?.results||[];
    $('record-count').textContent=records.length?`· ${records.length} 条保留结果`:'';
    const results=$('results'),signature=JSON.stringify([task?.taskId,task?.contextSummary?.through,records]);
    if(results.dataset.signature!==signature){
      const expanded=new Set([...results.querySelectorAll('details[open]')].map(el=>el.dataset.index));
      results.dataset.signature=signature;results.replaceChildren();
      for(let index=records.length-1;index>=0;index--){
        const entry=records[index],card=document.createElement('article');card.className='step-card';
        const heading=document.createElement('h3');heading.textContent=`记录 #${(task.contextSummary?.through||0)+index+1} · ${entry.action}`;card.append(heading);
        for(const [label,value] of [['目标',entry.label],['结果',typeof entry.result==='string'?entry.result:entry.outcome?.message],['状态',entry.outcome?`${entry.outcome.status} · ${entry.outcome.code}`:null]]){
          if(value){const p=document.createElement('p');p.textContent=label+'：'+value;card.append(p);}
        }
        const details=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');
        details.dataset.index=String(index);details.open=expanded.has(String(index));summary.textContent='操作结果详情';pre.textContent=JSON.stringify(entry,null,2);details.append(summary,pre);card.append(details);results.append(card);
      }
      if(!records.length){const p=document.createElement('p');p.className='hint';p.textContent=task?'尚无工具结果，状态消息见下方。':'开始任务后，这里显示操作与核对结果。';results.append(p);}
    }
    const timeline=$('timeline'),events=task?.events||[];
    const messageSignature=JSON.stringify([task?.taskId,task?.goal,events,records,task?.pending,task?.check,task?.lastOutcome,task?.phase]);
    if(timeline.dataset.signature!==messageSignature){
      const expanded=new Set([...timeline.querySelectorAll('.tool-call[open]')].map(el=>el.dataset.callKey));
      timeline.dataset.signature=messageSignature;timeline.replaceChildren();$('event-log').replaceChildren();
      const successMessages=new Set(records.filter(r=>r.outcome?.status==='success').map(r=>r.result));
      let previousRole='user';
      const entries=events.map(e=>({time:e.time,event:e}));
      const shown=[];
      for(let i=0;i<records.length;i++){
        const record=records[i],id=record.outcome?.operationId,previous=id?shown.find(r=>r.entry.outcome?.operationId===id):null;
        if(previous)previous.entry={...previous.entry,...record,action:previous.entry.action,request:record.request||previous.entry.request,time:previous.entry.time};
        else shown.push({entry:record,index:i});
      }
      for(const {entry:record,index:i} of shown){
        const operationId=record.outcome?.operationId;
        const current=operationId&&operationId===task?.check?.operationId&&task.lastOutcome?{...record,outcome:task.lastOutcome}:record;
        entries.push({time:record.time??events.at(-1)?.time??0,entry:current,key:task?.taskId+':'+(operationId||((task?.contextSummary?.through||0)+i))});
      }
      if(task?.pending?.plan)entries.push({time:task.pending.time??Date.now(),entry:{action:task.pending.plan.action,request:task.pending.plan,label:task.pending.label,pending:true},key:task.taskId+':'+(task.pending.operationId||'pending')});
      if(!task?.pending&&task?.check?.request&&!records.some(r=>r.outcome?.operationId===task.check.operationId))entries.push({time:task.check.time??Date.now(),entry:{action:task.check.request.action,request:task.check.request,outcome:task.lastOutcome||{status:'pending',message:'等待只读核对'},label:'当前核对'},key:task.taskId+':check'});
      entries.sort((a,b)=>a.time-b.time);
      for(const item of entries){
        if(item.entry){timeline.append(toolCard(item.entry,item.key,expanded));previousRole='tool';continue;}
        const e=item.event;
        const raw=document.createElement('p'),time=document.createElement('time');time.textContent=new Date(e.time).toLocaleTimeString();raw.append(time,document.createTextNode(e.text));$('event-log').prepend(raw);
        const user=e.text.startsWith('你：')||e.text.startsWith('你（补充指令）：');
        const text=user?e.text.replace(/^你(?:（补充指令）)?：/,''):e.text;
        if((user&&text===task.goal)||text==='任务已开始'||successMessages.has(text))continue;
        const role=user?'user':'assistant',message=document.createElement('div'),p=document.createElement('p');message.className='message '+role;
        if(!user&&previousRole!=='assistant'){const label=document.createElement('span');label.className='message-label';label.textContent='Page Agent';message.append(label);}
        p.textContent=text;message.append(p);timeline.append(message);previousRole=role;
      }
      if(follow)conversation.scrollTop=conversation.scrollHeight;
      conversation.dataset.taskId=task?.taskId||'';
    }
    $('task-plan').hidden=historyOpen||!task?.taskPlan?.length;
    $('task-plan-items').replaceChildren();
    for(const goal of task?.taskPlan||[]){
      const row=document.createElement('li'),state={pending:'待处理',active:'进行中',completed:'曾核对通过',blocked:'受阻'}[goal.status]||'未知';
      row.textContent=state+'：'+goal.title+(goal.verification&&goal.verification.status!=='success'?'（核对：'+goal.verification.status+'）':'');$('task-plan-items').append(row);
    }
    const question=!historyOpen&&task?.status==='paused'&&task.reason==='question'?task.question:null;
    $('choice-form').hidden=!question;
    if($('choice-form').dataset.questionId!==(question?.id||'')){
      $('choice-form').dataset.questionId=question?.id||'';$('choice-options').replaceChildren();$('choice-question').textContent=question?.text||'';
      for(const [index,text] of (question?.options||[]).entries()){const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.value=String(index);label.append(input,document.createTextNode(text));$('choice-options').append(label);}
    }
    $('choice-submit').disabled=busy;
    $('important-notice').hidden=historyOpen||!task?.notice;$('important-notice').textContent=task?.notice?'重要操作提示：'+task.notice:'';
    $('confirmation').hidden=task?.status!=='waiting_confirmation';
    const pending=task?.pending;
    $('operation').textContent=pending?`${pending.plan.action} → ${pending.label}${pending.plan.value!==undefined?'；内容：'+String(pending.plan.value):''}`:'';
    for(const id of ['start','grant','grant-all'])$(id).disabled=busy||tabId===null||!tabOrigin;
    const ongoing=task&&!['completed','ended'].includes(task.status);
    $('start').textContent='发送';
    $('start').title=ongoing?'发送并继续当前任务':'发送并开始任务';
    $('instruction').placeholder=ongoing?'补充要求，或告诉我下一步…':'告诉我你想做什么…';
    $('takeover').hidden=!task||['completed','ended'].includes(task.status)||task.reason==='user_takeover';
    $('takeover').disabled=busy;
    $('resume').textContent=task?.reason==='user_takeover'?'操作完成，重新观察':'继续任务';
    $('stop').hidden=!task||!['running','waiting_page','waiting_confirmation'].includes(task.status);
    $('resume').hidden=!task||['running','waiting_page','ended'].includes(task.status);
    $('stop').disabled=!task||!['running','waiting_page','waiting_confirmation'].includes(task.status);
    $('resume').disabled=busy||!task||['running','waiting_page','ended'].includes(task.status);
    $('finish').disabled=busy||!current||current.status==='ended';
    $('clear').hidden=historyOpen&&(!historyTask||historyTask.taskId!==current?.taskId);
    $('clear').disabled=busy||!current;$('approve').disabled=busy||!pending;
  }
  async function selectTab(){
    const version=++selection;++historyRequest;historyTask=null;historyIndex=[];historyOpen=false;tabId=null;tabOrigin=null;task=null;render();void refreshPermissions();
    $('status').textContent='';
    try{
      const tabs=await chrome.tabs.query({active:true,currentWindow:true});
      if(version!==selection)return;
      const tab=tabs[0];tabId=tab?.id??null;
      if(tab?.url&&['http:','https:'].includes(new URL(tab.url).protocol))tabOrigin=new URL(tab.url).origin;
      void refreshPermissions();
      $('target').replaceChildren();
      for(const [text,className] of [[tabOrigin?(tab.title||'当前网页'):'请选择普通 HTTP/HTTPS 网页','site-title'],[tabOrigin||'','site-origin']]){
        const line=document.createElement('span');line.className=className;line.textContent=text;$('target').append(line);
      }
      $('target').title=tabOrigin?`${tab.title||'当前网页'} · ${tabOrigin}`:'请选择普通 HTTP/HTTPS 网页';
      if(!tabOrigin)$('status').textContent=tab?.url?'浏览器内部页、扩展页面等不支持操作。':'无法读取网页地址，请重新加载扩展并确认新增权限。';
      if(tabId===null){render();return;}
      const value=await send('task:get');if(version!==selection)return;task=value;render();
    }catch(e){if(version===selection)$('status').textContent=e.message;}
  }
  async function action(type,extra,draft){
    if(tabId===null||busy)return;
    const target=tabId,previousDraft=$('instruction').value;busy=true;render();$('status').textContent='';
    try{
      const value=await send(type,extra);
      if(tabId===target){task=value;historyTask=null;historyIndex=[];}
      if(type==='task:finish'&&tabId===target){historyOpen=false;if($('instruction').value===previousDraft)$('instruction').value='';$('instruction').focus?.();}
      if(type==='task:submit'&&tabId===target){historyOpen=false;if($('instruction').value===draft)$('instruction').value='';}
    }
    catch(e){$('status').textContent=e.message;}
    finally{busy=false;render();}
  }
  $('chat').addEventListener('submit',e=>{e.preventDefault();const draft=$('instruction').value;if(!draft.trim())return;void action('task:submit',{goal:draft.trim()},draft);});
  $('instruction').addEventListener('compositionstart',()=>{composing=true;});
  $('instruction').addEventListener('compositionend',()=>{composing=false;});
  $('instruction').addEventListener('keydown',e=>{
    if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&!composing&&e.keyCode!==229){e.preventDefault();$('chat').requestSubmit();}
  });
  for(const [id,type] of Object.entries({takeover:'task:takeover',stop:'task:stop',resume:'task:resume',finish:'task:finish',clear:'task:clear'}))$(id).addEventListener('click',()=>void action(type));
  $('choice-form').addEventListener('submit',e=>{e.preventDefault();const indices=[...$('choice-options').querySelectorAll('input')].filter(n=>n.checked).map(n=>Number(n.value));if(!indices.length){$('status').textContent='请至少选择一项';return;}void action('task:choose',{taskId:task?.taskId,questionId:task?.question?.id,indices});});
  $('approve').addEventListener('click',()=>void action('task:approve',{taskId:task?.taskId}));
  async function loadHistory(){
    const request=++historyRequest,target=tabId;
    try{const value=await send('task:history');if(request!==historyRequest||target!==tabId||!historyOpen)return;historyIndex=Array.isArray(value)?value:[];render();}
    catch(e){if(request===historyRequest&&target===tabId)$('status').textContent=e.message;}
  }
  async function openConversation(taskId){
    const request=++historyRequest,target=tabId;
    try{const value=await send('task:history-get',{taskId});if(request!==historyRequest||target!==tabId||!historyOpen)return;historyTask=value;$('run-details').open=true;render();}
    catch(e){if(request===historyRequest&&target===tabId)$('status').textContent=e.message;}
  }
  function showHistory(open){++historyRequest;historyOpen=open;historyTask=null;render();if(open)void loadHistory();}
  $('history').addEventListener('click',()=>showHistory(!historyOpen));
  $('history-back').addEventListener('click',()=>showHistory(false));
  $('settings').addEventListener('click',()=>void chrome.runtime.openOptionsPage());
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
      finally{busy=false;render();void refreshPermissions();}
    })();
  }
  $('grant').addEventListener('click',()=>authorize(false));
  $('grant-all').addEventListener('click',()=>authorize(true));
  chrome.permissions.onAdded.addListener(()=>void refreshPermissions());
  chrome.permissions.onRemoved.addListener(()=>void refreshPermissions());
  chrome.tabs.onActivated.addListener(()=>void selectTab());
  chrome.tabs.onUpdated.addListener((id,change)=>{
    if(id===tabId&&(change.url||change.status==='complete'))void selectTab();
  });
  chrome.storage.onChanged.addListener((changes,area)=>{
    if(area==='session'&&tabId!==null&&changes['task:'+tabId]){const previousId=task?.taskId;task=changes['task:'+tabId].newValue||null;if(historyTask?.taskId===task?.taskId)historyTask=task;render();if(historyOpen&&previousId!==task?.taskId)void loadHistory();}
  });
  void selectTab();
})();
