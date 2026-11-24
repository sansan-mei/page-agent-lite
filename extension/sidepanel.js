'use strict';
(() => {
  const $=id=>document.getElementById(id),t=PageAgentI18n.t;
  let tabId=null,task=null,busy=false,selection=0,tabOrigin=null,composing=false,historyOpen=false,historyTask=null,historyIndex=[],historyRequest=0;
  let permissionCheck=0,taskRefresh=0,scopePending=false,refreshAfterAction=false;
  const switchTab=$('use-current');switchTab.textContent=t('spSwitchTab');switchTab.title=t('spUseCurrentTab');document.querySelector('.app-header').prepend(switchTab);
  async function refreshTask(){
    const target=tabId,view=selection,version=++taskRefresh;if(target===null)return;
    try{const value=await send('task:get');if(target!==tabId||view!==selection||version!==taskRefresh)return;const previousId=task?.taskId;task=value;if(task?.origin&&task.origin!=='browser'){tabOrigin=task.origin;void refreshPermissions();}render();if(historyOpen&&previousId!==task?.taskId)void loadHistory();}
    catch(error){if(target===tabId&&view===selection&&version===taskRefresh&&!scopePending)$('status').textContent=error.message;}
  }
  function invalidateTask(){if(busy){++taskRefresh;refreshAfterAction=true;}else void refreshTask();}
  async function refreshPermissions(){
    const version=++permissionCheck,origin=tabOrigin;
    if(!origin){$('grant').hidden=true;$('grant-all').hidden=true;return;}
    try{
      const [site,all]=await Promise.all([chrome.permissions.contains({origins:[origin+'/*']}),chrome.permissions.contains({origins:['http://*/*','https://*/*']})]);
      if(version!==permissionCheck||origin!==tabOrigin)return;
      $('grant').hidden=site;$('grant-all').hidden=all;
    }catch(e){
      if(version===permissionCheck&&origin===tabOrigin){$('grant').hidden=false;$('grant-all').hidden=false;}
    }
  }
  const labels={running:t('statusRunning'),waiting_page:t('statusWaitingPage'),waiting_confirmation:t('statusWaitingConfirmation'),paused:t('statusPaused'),stopped:t('statusStopped'),failed:t('statusFailed'),completed:t('statusCompleted'),ended:t('statusEnded')};
  async function send(type,extra={}){
    const result=await chrome.runtime.sendMessage({type,tabId,...extra});
    if(!result?.ok)throw new Error(result?.error||t('commonMessagingFailed'));return result.value;
  }
  function outcomeLabel(entry,status){
    const outcome=entry.outcome;
    const states={success:t('outcomeSuccess'),pending:t('outcomePending'),unknown:t('outcomeUnknown'),error:t('statusFailed'),not_satisfied:t('outcomeNotSatisfied'),returned:t('outcomeReturned')};
    if(status!=='unknown'||!outcome)return states[status]||status;
    if(outcome.dispatch==='not_sent'){
      if(outcome.code==='STALE')return t('outcomeStale');
      if(outcome.code==='TARGET_BLOCKED')return t('outcomeBlocked');
      return t('outcomeNotSent');
    }
    // Only ordinary dispatch receipts qualify; lost replies and failed checks stay unknown.
    if(outcome.dispatch==='sent'&&outcome.scope==='dispatch'&&['PAGE_CHANGED','NO_CHANGE'].includes(outcome.code)){
      const scroll=outcome.observed;
      if(entry.action==='scroll'&&scroll&&Number.isFinite(scroll.delta)){
        if(scroll.delta!==0)return t('outcomeScrolled');
        const direction=entry.request?.value;
        if((['up','left'].includes(direction)&&scroll.atStart===true)||(['down','right'].includes(direction)&&scroll.atEnd===true))return t('outcomeAtEdge');
        return t('outcomeNoScroll');
      }
      return t('outcomeSent');
    }
    return states[status];
  }
  function toolCard(entry,key,expanded){
    const card=document.createElement('details'),summary=document.createElement('summary');
    card.className='tool-call';card.dataset.callKey=key;card.open=expanded.has(key);
    const status=entry.pending?t('statusRunning'):entry.outcome?.status||(entry.result?.error?'error':'returned');
    card.dataset.status=status;
    summary.textContent=`ƒ ${entry.action} · ${entry.label||entry.request?.id||t('spToolCall')} · ${outcomeLabel(entry,status)}`;card.append(summary);
    for(const [label,value] of [[t('spRequest'),entry.request||{action:entry.action,[t('spNote')]:t('spLegacyRequest')}],[t('spResult'),entry.pending?t('spPendingResult'):entry.outcome||entry.result]]){
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
    $('target').parentElement.hidden=!tabOrigin;
    $('browser-target').hidden=historyOpen||!current?.browserTarget||current?.reason!=='browser_target';
    $('browser-target-url').textContent=current?.browserTarget?t('spOpenSite',current.browserTarget):'';
    $('browser-target-open').disabled=busy;
    const sensitiveRequest=!historyOpen&&current?.status==='paused'&&current?.reason==='sensitive_access'?current.sensitiveRequest:null;
    $('sensitive-confirmation').hidden=!sensitiveRequest;
    $('sensitive-reason').textContent=sensitiveRequest?.text||'';
    $('sensitive-allow').disabled=busy||!sensitiveRequest;$('sensitive-deny').disabled=busy||!sensitiveRequest;
    // Pending run_script: the full code is shown as text only (never parsed as HTML) before the user decides.
    const scriptRequest=!historyOpen&&current?.status==='paused'&&current?.reason==='script_approval'?current.scriptRequest:null;
    let scriptOrigin='';try{scriptOrigin=scriptRequest?new URL(scriptRequest.url).origin:'';}catch{scriptOrigin='';}
    $('script-approval').hidden=!scriptRequest;
    $('script-reason').textContent=scriptRequest?.reply||'';
    $('script-target').textContent=scriptRequest?t('spScriptTarget',scriptOrigin,t(scriptRequest.world==='MAIN'?'spScriptWorldMain':'spScriptWorldUser')):'';
    if($('script-code').textContent!==(scriptRequest?.code||''))$('script-code').textContent=scriptRequest?.code||'';
    $('script-approve').disabled=busy||!scriptRequest;$('script-approve-task').disabled=busy||!scriptRequest;$('script-reject').disabled=busy||!scriptRequest;
    // Task-scoped script approval stays visible with a Revoke control while the task keeps it.
    const scriptGrant=!historyOpen&&current?.scriptApproval?.scope==='task'&&current.status!=='ended'?current.scriptApproval:null;
    $('script-grant').hidden=!scriptGrant;$('script-grant-text').textContent=scriptGrant?t('spScriptGrant',scriptGrant.origin):'';$('script-revoke').disabled=busy||!scriptGrant;
    const editableScope=current&&Number.isSafeInteger(current.scopeRevision)&&!['ended','completed'].includes(current.status);
    if($('task-scope').dataset.taskId!==(current?.taskId||'')){$('task-scope').dataset.taskId=current?.taskId||'';$('scope-status').textContent='';$('member-status').textContent='';$('member-list').replaceChildren();$('member-candidate').replaceChildren();$('member-form').hidden=true;}
    $('task-scope').hidden=historyOpen||!editableScope;
    $('scope-add').disabled=busy||!editableScope;$('scope-origin').disabled=busy||!editableScope;
    const scopeSignature=JSON.stringify([current?.taskId,current?.scopeRevision,current?.allowedOrigins,busy]);
    if($('scope-origins').dataset.signature!==scopeSignature){
      $('scope-origins').dataset.signature=scopeSignature;$('scope-origins').replaceChildren();
      for(const origin of current?.allowedOrigins||[]){const li=document.createElement('li'),label=document.createElement('span'),button=document.createElement('button');label.textContent=origin;button.type='button';button.textContent=t('spRemoveFromTask');button.dataset.origin=origin;button.disabled=busy||!editableScope;li.append(label,button);$('scope-origins').append(li);}
    }
    const list=$('conversation-list');list.replaceChildren();
    const items=historyIndex.map(item=>item.taskId===current?.taskId&&current.origin===(tabOrigin||'browser')?current:item);
    if(current?.taskId&&current.origin===(tabOrigin||'browser')&&!items.some(t=>t.taskId===current.taskId))items.unshift(current);
    for(const item of items){
      const button=document.createElement('button');button.type='button';button.className='conversation-item';button.dataset.taskId=item.taskId;
      button.setAttribute('aria-pressed',String(historyTask?.taskId===item.taskId));
      button.textContent=(item.goal||t('spUntitledChat')).slice(0,100)+' · '+(labels[item.status]||item.status)+' · '+new Date(item.updatedAt||0).toLocaleString();
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
    $('context-usage').textContent=usage?t('spContextUsage',usage.promptTokens,usage.cachedTokens??t('spNotReported')):(task?.contextPressure?t('spContextEstimate',task.contextPressure.tokens):'');
    $('context-panel').hidden=!task?.contextSummary;
    $('context-meta').textContent=task?.contextSummary?t('spContextMeta',task.contextSummary.through,new Date(task.contextSummary.updatedAt).toLocaleTimeString()):'';
    $('context-summary').replaceChildren();
    for(const [key,label] of Object.entries({completed:t('summaryCompleted'),remaining:t('summaryRemaining'),facts:t('summaryFacts'),failed:t('summaryFailed'),uncertain:t('summaryUncertain')})){
      const items=task?.contextSummary?.content?.[key]||[];
      if(items.length){const p=document.createElement('p');p.textContent=t('commonLabelValue',label,'\n'+items.join('\n'));p.style.whiteSpace='pre-wrap';$('context-summary').append(p);}
    }
    const activity={observe:t('activityObserve'),thinking:t('activityThinking'),executing:t('activityExecuting'),verifying:t('activityVerifying'),compacting:t('activityCompacting')};
    const active=task&&['running','waiting_page'].includes(task.status);
    $('progress').textContent=!fresh?t('spProgress',active?(task.status==='waiting_page'?(task.check?.kind==='delay'?t('spDelayWait'):t('statusWaitingPage')):activity[task.phase]||labels[task.status]):labels[task.status]||task.status,task.steps,task.prefs.maxSteps||t('spUnlimited')):t('spReady');
    $('verification').hidden=!task?.check&&!task?.lastOutcome;
    const deadline=task?.check?.deadline;
    $('waiting').textContent=task?.check?(task.check.kind==='delay'?t('spWaitingDelay',new Date(deadline).toLocaleTimeString()):t('spWaitingCheck',task.check.expected.length,new Date(deadline).toLocaleTimeString())):task?.lastOutcome?t('spLastOutcome',task.lastOutcome.status,task.lastOutcome.code):'';
    $('evidence').replaceChildren();
    for(const item of task?.lastOutcome?.evidence||[]){
      const p=document.createElement('p');p.textContent=t('spEvidence',item.kind,item.matched===true?t('spMatched'):item.matched===false?t('spMismatched'):t('commonUnknown'),item.code||'',JSON.stringify(item.target),JSON.stringify(item.expected),JSON.stringify(item.actual));$('evidence').append(p);
    }
    $('task-meta').textContent=task?t('spTaskMeta',task.taskId||'—',new Date(task.updatedAt||Date.now()).toLocaleTimeString()):'';
    const phases={observe:t('activityObserve'),thinking:t('phaseThinking'),executing:t('phaseExecuting'),verifying:t('phaseVerifying'),confirm:t('statusWaitingConfirmation'),compacting:t('activityCompacting'),idle:t('phaseIdle')};
    $('metrics').textContent=task?t('spMetrics',phases[task.phase]||task.phase||'—',task.metrics?.observations||0,task.metrics?.actions||0,task.metrics?.verifications||0)+(task.reason?t('spReasonCode',task.reason):''):'';
    $('export-diagnostics').hidden=!task||task.taskId!==current?.taskId||task.origin!==current?.origin;
    $('export-diagnostics').disabled=busy;
    const timingLabels={model:t('timingModel'),summary:t('timingSummary'),tool:t('timingTool')};
    for(const [kind,label] of Object.entries(timingLabels)){
      const timing=task?.metrics?.timings?.[kind];if(!timing)continue;
      const missing=Math.max(0,timing.attempts-timing.completed-timing.failed);
      $('metrics').textContent+=t('spTiming',label,timing.attempts,t('spSeconds',(timing.totalMs/1000).toFixed(2)),timing.lastMs===null?t('spNotReported'):t('spSeconds',(timing.lastMs/1000).toFixed(2)),timing.failed)+(missing?t('spUnreported',missing):'');
    }
    const records=task?.results||[];
    $('record-count').textContent=records.length?t('spRecordCount',records.length):'';
    const results=$('results'),signature=JSON.stringify([task?.taskId,task?.contextSummary?.through,records]);
    if(results.dataset.signature!==signature){
      const expanded=new Set([...results.querySelectorAll('details[open]')].map(el=>el.dataset.index));
      results.dataset.signature=signature;results.replaceChildren();
      for(let index=records.length-1;index>=0;index--){
        const entry=records[index],card=document.createElement('article');card.className='step-card';
        const heading=document.createElement('h3');heading.textContent=t('spRecordHeading',(task.contextSummary?.through||0)+index+1,entry.action);card.append(heading);
        for(const [label,value] of [[t('spTarget'),entry.label],[t('spResultLabel'),typeof entry.result==='string'?entry.result:entry.outcome?.message],[t('spStatusLabel'),entry.outcome?`${entry.outcome.status} · ${entry.outcome.code}`:null]]){
          if(value){const p=document.createElement('p');p.textContent=t('commonLabelValue',label,value);card.append(p);}
        }
        const details=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');
        details.dataset.index=String(index);details.open=expanded.has(String(index));summary.textContent=t('spResultDetails');pre.textContent=JSON.stringify(entry,null,2);details.append(summary,pre);card.append(details);results.append(card);
      }
      if(!records.length){const p=document.createElement('p');p.className='hint';p.textContent=task?t('spNoResults'):t('spResultsHint');results.append(p);}
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
      if(!task?.pending&&task?.check?.request&&!records.some(r=>r.outcome?.operationId===task.check.operationId))entries.push({time:task.check.time??Date.now(),entry:{action:task.check.request.action,request:task.check.request,outcome:task.lastOutcome||{status:'pending',message:t('spWaitingReadonly')},label:t('spCurrentCheck')},key:task.taskId+':check'});
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
      const row=document.createElement('li'),state={pending:t('planPending'),active:t('planActive'),completed:t('planCompleted'),blocked:t('planBlocked')}[goal.status]||t('commonUnknown');
      row.textContent=t('commonLabelValue',state,goal.title)+(goal.verification&&goal.verification.status!=='success'?t('spPlanCheck',goal.verification.status):'');$('task-plan-items').append(row);
    }
    const question=!historyOpen&&task?.status==='paused'&&task.reason==='question'?task.question:null;
    $('choice-form').hidden=!question;
    if($('choice-form').dataset.questionId!==(question?.id||'')){
      $('choice-form').dataset.questionId=question?.id||'';$('choice-options').replaceChildren();$('choice-question').textContent=question?.text||'';
      for(const [index,text] of (question?.options||[]).entries()){const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.value=String(index);label.append(input,document.createTextNode(text));$('choice-options').append(label);}
    }
    $('choice-submit').disabled=busy;
    $('important-notice').hidden=historyOpen||!task?.notice;$('important-notice').textContent=task?.notice?t('spNotice',task.notice):'';
    $('confirmation').hidden=task?.status!=='waiting_confirmation';
    const pending=task?.pending;
    $('operation').textContent=pending?`${pending.plan.action} → ${pending.label}${pending.plan.value!==undefined?t('spOperationValue',String(pending.plan.value)):''}`:'';
    $('start').disabled=busy||tabId===null;
    for(const id of ['grant','grant-all'])$(id).disabled=busy||tabId===null||!tabOrigin;
    const ongoing=task&&!['completed','ended'].includes(task.status);
    $('start').textContent=t('spSend');
    $('start').title=ongoing?t('spSendContinue'):t('spSendStart');
    $('instruction').placeholder=ongoing?t('spPlaceholderOngoing'):t('spPlaceholderNew');
    $('takeover').hidden=!task||['completed','ended'].includes(task.status)||task.reason==='user_takeover';
    $('takeover').disabled=busy;
    $('resume').textContent=task?.reason==='user_takeover'?t('spTakeoverDone'):t('spResume');
    $('stop').hidden=!task||!['running','waiting_page','waiting_confirmation'].includes(task.status);
    $('resume').hidden=!task||['running','waiting_page','ended'].includes(task.status)||task.reason==='script_approval'&&!!task.scriptRequest;
    $('stop').disabled=!task||!['running','waiting_page','waiting_confirmation'].includes(task.status);
    $('resume').disabled=busy||!task||['running','waiting_page','ended'].includes(task.status);
    $('finish').disabled=busy||!current||current.status==='ended';
    $('clear').hidden=historyOpen&&(!historyTask||historyTask.taskId!==current?.taskId||historyTask.origin!==current?.origin);
    $('clear').disabled=busy||!current;$('approve').disabled=busy||!pending;
  }
  async function selectTab(useCurrent=false){
    const version=++selection,refreshVersion=++taskRefresh;
    try{
      const tab=(await chrome.tabs.query({active:true,currentWindow:true}))[0];
      if(version!==selection)return;
      if(!useCurrent&&tabId!==null&&task&&task.status!=='ended'&&tab?.id!==tabId){$('use-current').hidden=false;return;}
      const nextId=tab?.id??null,nextOrigin=tab?.url&&['http:','https:'].includes(new URL(tab.url).protocol)?new URL(tab.url).origin:null;
      const value=nextId===null?null:await send('task:get',{tabId:nextId});
      if(version!==selection||refreshVersion!==taskRefresh)return;
      if(nextId!==tabId||nextOrigin!==tabOrigin){scopePending=false;refreshAfterAction=false;++historyRequest;historyTask=null;historyIndex=[];historyOpen=false;$('status').textContent='';}
      tabId=nextId;tabOrigin=nextOrigin;task=value;$('use-current').hidden=true;
      const title=tabOrigin?tab.title||t('spCurrentPage'):'',signature=JSON.stringify([title,tabOrigin]);
      if($('target').dataset.signature!==signature){
        $('target').dataset.signature=signature;$('target').replaceChildren();
        for(const [text,className] of (tabOrigin?[[title,'site-title'],[tabOrigin,'site-origin']]:[])){
          const line=document.createElement('span');line.className=className;line.textContent=text;$('target').append(line);
        }
        $('target').title=tabOrigin?`${title} · ${tabOrigin}`:'';
      }
      if(!tab?.url)$('status').textContent=t('spTabUnreadable');
      render();void refreshPermissions();
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
    finally{busy=false;render();if(refreshAfterAction&&!scopePending){refreshAfterAction=false;void refreshTask();}}
  }
  for(const [id,allow,scope] of [['script-approve',true,'once'],['script-approve-task',true,'task'],['script-reject',false,'once']])$(id).addEventListener('click',()=>{if(task?.scriptRequest)void action('task:script-approval',{taskId:task.taskId,requestId:task.scriptRequest.id,allow,scope});});
  $('script-revoke').addEventListener('click',()=>{if(task?.scriptApproval)void action('task:script-revoke',{taskId:task.taskId});});
  for(const [id,allow] of [['sensitive-allow',true],['sensitive-deny',false]])$(id).addEventListener('click',()=>{if(task?.sensitiveRequest)void action('task:sensitive-access',{taskId:task.taskId,requestId:task.sensitiveRequest.id,allow});});
  function editScope(action,origin,continueTask=false){
    if(busy||!task||!Number.isSafeInteger(task.scopeRevision))return;
    const target=tabId,taskId=task.taskId,expectedRevision=task.scopeRevision,view=selection,draft=$('scope-origin').value;
    let permission;
    try{permission=action==='add'?chrome.permissions.request({origins:[origin+'/*']}):Promise.resolve(true);}catch(error){$('scope-status').textContent=error.message;return;}
    busy=true;render();$('scope-status').textContent='';
    void (async()=>{
      try{
        if(!await permission)throw new Error(t('spScopeCanceled'));
        if(view!==selection||target!==tabId||task?.taskId!==taskId||task.scopeRevision!==expectedRevision)throw new Error(t('spScopeTaskChanged'));
        let value=await send('task:scope-change',{tabId:target,taskId,expectedRevision,origin,action});
        if(continueTask)value=await send('task:resume',{tabId:target});
        if(view===selection&&target===tabId){task=value;$('scope-status').textContent=continueTask?t('spScopeContinued'):t('spScopeUpdated');if(action==='add'&&$('scope-origin').value===draft)$('scope-origin').value='';}
      }catch(error){if(view===selection)$('scope-status').textContent=error.message;}
      finally{busy=false;render();if(refreshAfterAction&&!scopePending){refreshAfterAction=false;void refreshTask();}void refreshPermissions();}
    })();
  }
  $('use-current').addEventListener('click',()=>void selectTab(true));
  $('browser-target-open').addEventListener('click',()=>{if(task?.browserTarget)editScope('add',new URL(task.browserTarget).origin,true);});
  $('scope-form').addEventListener('submit',event=>{
    event.preventDefault();const raw=$('scope-origin').value.trim();
    try{const url=new URL(raw);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hostname.includes('*')||url.pathname!=='/'||url.search||url.hash||raw.length>300)throw new Error(t('spScopeInvalid'));editScope('add',url.origin);}
    catch(error){$('scope-status').textContent=error.message;}
  });
  $('scope-origins').addEventListener('click',event=>{const origin=event.target.dataset?.origin;if(origin)editScope('remove',origin);});
  let memberView=null,memberRequest=0;
  const memberKinds={initial:t('memberInitial'),user_joined:t('memberUserJoined'),task_created:t('memberTaskCreated')};
  function renderMembers(){
    const list=$('member-list'),select=$('member-candidate');list.replaceChildren();select.replaceChildren();
    const usable=memberView&&memberView.taskId===task?.taskId;$('member-form').hidden=!usable;if(!usable)return;
    for(const member of memberView.members){
      const li=document.createElement('li'),label=document.createElement('span');
      label.textContent=[member.tabRef,memberKinds[member.kind]||member.kind,member.active?t('spActiveMember'):'',member.open?(member.title||t('spUntitled'))+' · '+(member.origin||t('spNotWebpage')):t('spClosed'),member.open&&member.origin&&!member.authorized?t('spSiteNotAllowed'):''].filter(Boolean).join(' · ');li.append(label);
      if(!member.active){const button=document.createElement('button');button.type='button';button.textContent=t('spRemove');button.dataset.tabRef=member.tabRef;button.disabled=busy;li.append(button);}
      list.append(li);
    }
    for(const candidate of memberView.candidates){
      const option=document.createElement('option');option.value=String(candidate.tabId);option.disabled=candidate.occupied;
      option.textContent=(candidate.title||t('spUntitled'))+' · '+candidate.origin+(candidate.occupied?' · '+t('spOccupied'):candidate.authorized?'':' · '+t('spSiteNotAllowed'));select.append(option);
    }
    $('member-add').disabled=busy||!memberView.candidates.some(candidate=>!candidate.occupied);
  }
  async function loadMembers(){
    if(tabId===null||!task?.taskId)return;
    const target=tabId,taskId=task.taskId,view=selection,version=++memberRequest;
    try{const value=await send('task:members',{tabId:target,taskId});if(view!==selection||target!==tabId||version!==memberRequest||task?.taskId!==taskId)return;memberView=value;renderMembers();}
    catch(error){if(view===selection&&version===memberRequest)$('member-status').textContent=error.message;}
  }
  async function editMembers(extra,done){
    if(busy||!memberView||memberView.taskId!==task?.taskId)return;
    const target=tabId,view=selection;busy=true;render();renderMembers();$('member-status').textContent='';
    try{
      const value=await send('task:member-change',{tabId:target,taskId:memberView.taskId,expectedMembersRevision:memberView.membersRevision,...extra});
      if(view===selection&&target===tabId){$('member-status').textContent=done;if(value?.taskId===task?.taskId)task=value;}
    }catch(error){if(view===selection)$('member-status').textContent=error.message;}
    finally{busy=false;render();if(view===selection&&target===tabId)await loadMembers();}
  }
  $('members-refresh').addEventListener('click',()=>void loadMembers());
  $('member-form').addEventListener('submit',event=>{event.preventDefault();const id=Number($('member-candidate').value);if(Number.isInteger(id))void editMembers({action:'join',memberTabId:id},t('spMemberJoined'));});
  $('member-list').addEventListener('click',event=>{const ref=event.target.dataset?.tabRef;if(ref)void editMembers({action:'remove',tabRef:ref},t('spMemberRemoved'));});
  $('chat').addEventListener('submit',e=>{e.preventDefault();const draft=$('instruction').value;if(!draft.trim())return;void action('task:submit',{goal:draft.trim()},draft);});
  $('instruction').addEventListener('compositionstart',()=>{composing=true;});
  $('instruction').addEventListener('compositionend',()=>{composing=false;});
  $('instruction').addEventListener('keydown',e=>{
    if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&!composing&&e.keyCode!==229){e.preventDefault();$('chat').requestSubmit();}
  });
  for(const [id,type] of Object.entries({takeover:'task:takeover',stop:'task:stop',resume:'task:resume',finish:'task:finish',clear:'task:clear'}))$(id).addEventListener('click',()=>void action(type));
  $('choice-form').addEventListener('submit',e=>{e.preventDefault();const indices=[...$('choice-options').querySelectorAll('input')].filter(n=>n.checked).map(n=>Number(n.value));if(!indices.length){$('status').textContent=t('spChooseOne');return;}void action('task:choose',{taskId:task?.taskId,questionId:task?.question?.id,indices});});
  $('export-diagnostics').addEventListener('click',async()=>{
    const target=tabId,identity=task?.taskId;if(!identity)return;
    try{
      const value=await send('task:diagnostics',{taskId:identity});
      if(target!==tabId||identity!==task?.taskId)return;
      const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));
      try{const link=document.createElement('a');link.href=url;link.download='page-agent-diagnostics-'+Date.now()+'.json';link.click();}finally{URL.revokeObjectURL(url);}
      $('status').textContent=t('spDiagnosticsExported');
    }catch(error){$('status').textContent=error.message||t('spDiagnosticsFailed');}
  });
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
        if(!await grant)throw new Error(t('spGrantCanceled'));
        await send('task:connect',{tabId:id});
        if(tabId===id)$('status').textContent=all?t('spGrantedAll'):t('spGrantedSite');
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
  async function loadInputLimit(){
    try{const value=await send('agentPreferences');if(Number.isInteger(value?.inputChars)&&value.inputChars>0)$('instruction').setAttribute('maxlength',String(value.inputChars));}catch{}
  }
  chrome.storage.onChanged.addListener((changes,area)=>{
    if(area==='local'&&changes.agentPreferences){void loadInputLimit();return;}
    if(area!=='session'||tabId===null)return;
    const registry=changes.taskRegistry;
    if(registry){
      const before=registry.oldValue||{},after=registry.newValue||{};
      const relevant=before.pending?.tabId===tabId||after.pending?.tabId===tabId||JSON.stringify(before.bindings?.[tabId])!==JSON.stringify(after.bindings?.[tabId]);
      if(relevant){scopePending=after.pending?.tabId===tabId;if(scopePending){++taskRefresh;return;}invalidateTask();return;}
    }
    if(!scopePending&&task?.taskId&&changes['taskRoot:'+task.taskId])invalidateTask();
  });
  void loadInputLimit();
  void selectTab();
})();
