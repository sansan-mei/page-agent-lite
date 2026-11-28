(function(root){
  'use strict';
  const taskStoreWrites=new WeakMap();
  function createTaskStore(chrome) {
    const area=chrome.storage.session;
    const key=id=>'task:'+id;
    const rootKey=id=>'taskRoot:'+id;
    const originKey=(id,taskId,origin)=>'conversation-origin:'+id+':'+taskId+':'+encodeURIComponent(origin);
    const serial=fn=>{const operation=(taskStoreWrites.get(area)||Promise.resolve()).catch(()=>{}).then(fn);taskStoreWrites.set(area,operation);return operation;};
    const readRegistry=async()=>{const value=(await area.get('taskRegistry')).taskRegistry;return value?{...value,tabOwners:value.tabOwners||{}}:{version:1,revision:0,bindings:{},tabOwners:{}};};
    // tabOwners maps non-executing member tabs to their task; bindings keep the executing tab.
    const registryOf=(revision,bindings,tabOwners)=>({version:1,revision,bindings,tabOwners:tabOwners||{}});
    const releaseOwners=(owners,taskId)=>Object.fromEntries(Object.entries(owners||{}).filter(([,owner])=>owner.taskId!==taskId));
    const ownerError=()=>Object.assign(new Error('该标签页已属于其他任务，请到任务所在标签页操作或先移出'),{code:'TAB_OWNED'});
    const scopeError=()=>Object.assign(new Error('任务归属记录未完成，请重新加载扩展以只读核对'),{code:'TASK_SCOPE_INCONSISTENT'});
    async function get(id){
      const registry=await readRegistry();if(registry.pending?.tabId===id)throw scopeError();
      const binding=registry.bindings[id];if(!binding)return (await area.get(key(id)))[key(id)]||null;
      const task=(await area.get(rootKey(binding.taskId)))[rootKey(binding.taskId)];
      if(!task||task.taskId!==binding.taskId||task.tabId!==id||task.scopeRevision!==binding.revision)throw scopeError();
      return task;
    }
    async function finishMemberClose(registry){
      const intent=registry.pending,id=intent.tabId,binding=registry.bindings[id];
      if(!binding||binding.taskId!==intent.binding.taskId||binding.revision!==intent.binding.revision)throw scopeError();
      const task=(await area.get(rootKey(binding.taskId)))[rootKey(binding.taskId)];
      if(!task||task.taskId!==binding.taskId||task.scopeRevision!==binding.revision||task.tabId!==id)throw scopeError();
      // Terminal archive keeps unknown operation evidence; no browser effect or replay.
      const {token,...view}=task;
      const ended={...view,status:'ended',reason:'member_closed',members:[],activeTabId:null,activeOrigin:null,nextObservation:null,updatedAt:intent.closedAt,archived:true};
      await area.set({['conversation:'+id+':'+task.taskId]:ended,[rootKey(task.taskId)]:ended});
      await area.remove(key(id));
      const bindings={...registry.bindings};delete bindings[id];
      await area.set({taskRegistry:registryOf(registry.revision+1,bindings,releaseOwners(registry.tabOwners,task.taskId))});
      try{await area.remove(rootKey(task.taskId));}catch{ /* Archived unbound root is cleaned at startup. */ }
      return ended;
    }
    async function originView(id,taskId,origin,current){
      const base=current?.taskId===taskId?current:(await area.get('conversation:'+id+':'+taskId))['conversation:'+id+':'+taskId];
      if(!base||origin!=='browser'&&!(base.allowedOrigins||[base.origin]).includes(origin))return null;
      const saved=(await area.get(originKey(id,taskId,origin)))[originKey(id,taskId,origin)];
      const parts=(saved?.segments||[]).map(segment=>segment.view);
      if(base.origin===origin)parts.push(base);
      if(!parts.length)return null;
      const {token,pending,check,...view}=parts.at(-1);
      return {...view,taskId,origin,archived:base.origin!==origin||!!base.archived,results:parts.flatMap(v=>v.results||[]),events:parts.flatMap(v=>v.events||[]),contextArchive:parts.flatMap(v=>v.contextArchive||[])};
    }
    function rooted(id,task,revision,previous=null){
      if(!Number.isInteger(id)||id<0||task.tabId!==id||typeof task.taskId!=='string'||! /^[a-zA-Z0-9_-]{1,100}$/.test(task.taskId))throw new Error('任务根记录身份无效');
      if(previous&&task.origin!==previous.origin)throw scopeError();
      return {...task,version:3,scopeRevision:revision,initialTabId:previous?.initialTabId??id,initialOrigin:previous?.initialOrigin||task.origin,activeTabId:id,activeOrigin:task.origin,allowedOrigins:previous?.allowedOrigins||(task.origin==='browser'?[]:[task.origin]),members:previous?.members||[{tabId:id,tabRef:'tab0',kind:'initial',joinRevision:revision}],memberSeq:previous?.memberSeq??1,membersRevision:previous?.membersRevision??0};
    }
    return {
      get,
      async getByTaskId(taskId){const registry=await readRegistry();const entry=Object.entries(registry.bindings).find(([,binding])=>binding.taskId===taskId);if(!entry)return null;const task=await get(Number(entry[0]));return task?.taskId===taskId?task:null;},
      async set(id,task){return serial(async()=>{
        const registry=await readRegistry();if(registry.pending)throw scopeError();
        if(registry.tabOwners[id])throw ownerError();
        const binding=registry.bindings[id],previous=await get(id);
        if(Object.entries(registry.bindings).some(([tab,b])=>Number(tab)!==id&&b.taskId===task.taskId))throw new Error('任务已归属其他标签页');
        const same=binding?.taskId===task.taskId,revision=same?binding.revision:registry.revision+1;
        if(same&&task.scopeRevision!==undefined&&task.scopeRevision!==revision)throw scopeError();
        const record=rooted(id,task,revision,same?previous:null),values={[rootKey(task.taskId)]:record};
        if(previous?.taskId&&previous.taskId!==task.taskId){const {token,pending,check,...view}=previous;values['conversation:'+id+':'+previous.taskId]={...view,archived:true};}
        if(same){await area.set(values);return;}
        // Journal membership before root publication; a pending intent blocks execution.
        const next={taskId:task.taskId,revision};
        const nextOwners=previous?.taskId?releaseOwners(registry.tabOwners,previous.taskId):registry.tabOwners;
        await area.set({taskRegistry:{...registry,pending:{tabId:id,binding:next,previousTaskId:previous?.taskId||null,nextOwners}}});
        await area.set(values);
        await area.set({taskRegistry:registryOf(revision,{...registry.bindings,[id]:next},nextOwners)});
        try{await area.remove(key(id));}catch{ /* The committed root remains authoritative; startup retries legacy cleanup. */ }
        if(previous?.taskId&&previous.taskId!==task.taskId)try{await area.remove(rootKey(previous.taskId));}catch{ /* Unbound roots cannot execute; cleanup retries at startup. */ }
      });},
      async changeOrigins(id,{taskId,expectedRevision,origin,action,token,updatedAt}){return serial(async()=>{
        const registry=await readRegistry();if(registry.pending)throw scopeError();
        const task=await get(id),binding=registry.bindings[id];
        if(!task||task.taskId!==taskId||!binding||binding.revision!==expectedRevision||['ended','completed'].includes(task.status))throw scopeError();
        let url;try{url=new URL(origin);}catch{throw new Error('请输入完整 HTTP/HTTPS 站点来源');}
        if(!['http:','https:'].includes(url.protocol)||url.origin!==origin||url.username||url.password||url.hostname.includes('*')||origin.length>300||!['add','remove'].includes(action))throw new Error('站点来源或范围操作无效');
        const origins=task.allowedOrigins||[task.origin],exists=origins.includes(origin);
        if(action==='add'&&exists||action==='remove'&&!exists)return task;
        const allowedOrigins=action==='add'?[...origins,origin]:origins.filter(value=>value!==origin);
        if(allowedOrigins.length>16)throw new Error('每个任务最多授权 16 个站点来源');
        const revision=registry.revision+1,next={taskId,revision};
        const record={...task,token,updatedAt,scopeRevision:revision,allowedOrigins,status:'paused',reason:'scope_changed',nextObservation:null,contextSummary:null,contextUsage:null,contextPressure:null,compactionGuard:false,taskPlan:null,question:null,memoryReview:null,completionEvidence:null};
        await area.set({taskRegistry:{...registry,pending:{kind:'origins_changed',tabId:id,binding:next,previousTaskId:taskId}}});
        await area.set({[rootKey(taskId)]:record});
        await area.set({taskRegistry:registryOf(revision,{...registry.bindings,[id]:next},registry.tabOwners)});
        return record;
      });},
      async switchOrigin(id,{taskId,expectedRevision,expectedToken,origin,token,updatedAt,proof=null}){return serial(async()=>{
        const registry=await readRegistry();if(registry.pending)throw scopeError();
        const task=await get(id),binding=registry.bindings[id];
        if(!task||task.taskId!==taskId||task.token!==expectedToken||binding?.revision!==expectedRevision)throw scopeError();
        const url=new URL(origin);if(url.origin!==origin||!['http:','https:'].includes(url.protocol)||url.username||url.password||origin===task.origin)throw scopeError();
        const name=originKey(id,taskId,task.origin),saved=(await area.get(name))[name]||{version:1,taskId,tabId:id,origin:task.origin,segments:[]};
        const {token:oldToken,pending,check,...view}=task;
        if(proof)view.results=(view.results||[]).concat({action:check?.action||'navigate',request:check?.request,time:updatedAt,origin:task.origin,tabRef:(task.members||[]).find(member=>member.tabId===id)?.tabRef||'tab0',outcome:proof});
        if(!saved.segments.some(segment=>segment.id===task.scopeRevision))saved.segments.push({id:task.scopeRevision,view:{...view,archived:true}});
        if(JSON.stringify(saved).length>1000000)throw new Error('本站历史超过 100 万字符，未切换任务；原记录已保留');
        const destination=(await area.get(originKey(id,taskId,origin)))[originKey(id,taskId,origin)];
        const uncertainClicks=(destination?.segments.at(-1)?.view.uncertainClicks||[]).filter(guard=>{try{return new URL(guard.url).origin===origin;}catch{return false;}}).slice(-2);
        const revision=registry.revision+1,next={taskId,revision};
        const record={version:3,taskId,token,tabId:id,origin,uncertainClicks,initialTabId:task.initialTabId,initialOrigin:task.initialOrigin,activeTabId:id,activeOrigin:origin,allowedOrigins:[...new Set([...(task.allowedOrigins||[task.origin]),origin])],sensitiveAccess:task.sensitiveAccess,members:task.members,memberSeq:task.memberSeq,membersRevision:task.membersRevision,scopeRevision:revision,goal:task.goal,instructions:task.instructions||[],attachments:task.attachments,goalMode:task.goalMode===true,tabTrail:task.tabTrail,handoffs:task.handoffs,progress:task.progress,tabHops:task.tabHops,prefs:task.prefs,steps:task.steps,metrics:{...task.metrics,...(proof?{verifications:(task.metrics?.verifications||0)+1}:{})},updatedAt,status:'running',phase:'observe',results:[],contextArchive:[],events:[{time:updatedAt,text:'已切换站点，重新观察；旧站点内容不进入当前请求'}],pending:null,check:null,retries:0};
        await area.set({taskRegistry:{...registry,pending:{kind:'origin_changed',tabId:id,binding:next,previousTaskId:taskId,sourceOrigin:task.origin,sourceRevision:task.scopeRevision}}});
        await area.set({[name]:saved});
        await area.set({[rootKey(taskId)]:record});
        await area.set({taskRegistry:registryOf(revision,{...registry.bindings,[id]:next},registry.tabOwners)});
        return record;
      });},
      async owner(tabId){
        const registry=await readRegistry();
        if(registry.bindings[tabId])return {taskId:registry.bindings[tabId].taskId,taskTabId:tabId,role:'task'};
        const owner=registry.tabOwners[tabId];if(!owner)return null;
        const entry=Object.entries(registry.bindings).find(([,binding])=>binding.taskId===owner.taskId);
        return {taskId:owner.taskId,taskTabId:entry?Number(entry[0]):null,role:'member'};
      },
      // Member directory change (join / remove / closed). Uses the three-step journal but keeps the
      // binding revision, token and checkpoints: only the directory and tabOwners change.
      async changeMembers(id,{taskId,expectedMembersRevision,action,memberTabId,tabRef,updatedAt}){return serial(async()=>{
        const registry=await readRegistry();if(registry.pending)throw scopeError();
        const task=await get(id),binding=registry.bindings[id],owners=registry.tabOwners;
        if(!task||task.taskId!==taskId||!binding)throw scopeError();
        if(expectedMembersRevision!==undefined&&(task.membersRevision??0)!==expectedMembersRevision)throw Object.assign(new Error('任务标签页已变化，请刷新后重试'),{code:'MEMBERS_CHANGED'});
        const members=task.members||[],nextOwners={...owners},membersRevision=registry.revision+1;let nextMembers,memberSeq=task.memberSeq??members.length,text;
        if(action==='join'){
          if(['ended','completed'].includes(task.status))throw scopeError();
          if(!Number.isInteger(memberTabId)||memberTabId<0||memberTabId===id)throw new Error('标签页无效');
          if(registry.bindings[memberTabId]||owners[memberTabId]||members.some(member=>member.tabId===memberTabId))throw ownerError();
          if(members.length>=8)throw new Error('每个任务最多 8 个标签页');
          const ref='tab'+memberSeq;memberSeq+=1;
          nextMembers=[...members,{tabId:memberTabId,tabRef:ref,kind:'user_joined',joinRevision:membersRevision}];nextOwners[memberTabId]={taskId,revision:membersRevision};
          text='已加入标签页 '+ref+'；执行目标不变';
        }else if(action==='created'){
          // Browser-returned tabId of a tab this task just opened; never claimed by URL or title.
          if(['ended','completed'].includes(task.status))throw scopeError();
          if(!Number.isInteger(memberTabId)||memberTabId<0||memberTabId===id||registry.bindings[memberTabId]||owners[memberTabId]||members.some(member=>member.tabId===memberTabId))throw ownerError();
          if(members.length>=8)throw new Error('每个任务最多 8 个标签页');
          const ref='tab'+memberSeq;memberSeq+=1;
          nextMembers=[...members,{tabId:memberTabId,tabRef:ref,kind:'task_created',joinRevision:membersRevision}];nextOwners[memberTabId]={taskId,revision:membersRevision};
          text='已打开并登记任务标签页 '+ref;
        }else if(action==='remove'||action==='closed'||action==='release'){
          const member=members.find(item=>action==='remove'?item.tabRef===tabRef:item.tabId===memberTabId);
          if(!member){if(action!=='remove')return null;throw Object.assign(new Error('任务标签页已变化，请刷新后重试'),{code:'MEMBERS_CHANGED'});}
          if(member.tabId===id)throw new Error('不能移出正在执行的标签页');
          nextMembers=members.filter(item=>item!==member);delete nextOwners[member.tabId];
          text=action==='closed'?'成员标签页 '+member.tabRef+' 已关闭，已从任务移除':action==='release'?'标签页 '+member.tabRef+' 已释放，用于新任务':'已移出标签页 '+member.tabRef+'；网页未关闭或改动';

        }else throw new Error('成员操作无效');
        const events=(task.events||[]).concat({time:updatedAt,text}).slice(-40);while(events.length>1&&JSON.stringify(events).length>16000)events.shift();
        const record={...task,members:nextMembers,memberSeq,membersRevision,events,updatedAt};
        await area.set({taskRegistry:{...registry,pending:{kind:'members_changed',tabId:null,taskTabId:id,taskId,membersRevision,nextOwners}}});
        await area.set({[rootKey(taskId)]:record});
        await area.set({taskRegistry:registryOf(registry.revision+1,registry.bindings,nextOwners)});
        return record;
      });},
      // Move the execution target (binding) to another member. Same three-step journal; the old
      // executing tab stays an owned member unless it was closed. Temporary notes follow the task.
      async switchTab(id,{taskId,expectedRevision,expectedToken,toTabId,token,updatedAt,patch={},closed=false}){return serial(async()=>{
        const registry=await readRegistry();if(registry.pending)throw scopeError();
        const task=await get(id),binding=registry.bindings[id];
        if(!task||task.taskId!==taskId||!binding||binding.revision!==expectedRevision||expectedToken!==undefined&&task.token!==expectedToken)throw scopeError();
        const members=task.members||[];
        if(toTabId===id||!members.some(member=>member.tabId===toTabId)||registry.bindings[toTabId]||registry.tabOwners[toTabId]?.taskId!==taskId)throw Object.assign(new Error('目标标签页不属于本任务'),{code:'TAB_NOT_MEMBER'});
        const revision=registry.revision+1,next={taskId,revision},nextOwners={...registry.tabOwners};
        delete nextOwners[toTabId];if(!closed)nextOwners[id]={taskId,revision};
        const fields=['status','reason','phase','pending','check','waitDeadline','nextObservation','results','events','uncertainClicks','lastOutcome','contextUsage','retries','tabTrail','handoffs','tabHops','scriptRequest','inputRequest'];
        const record={...task,...Object.fromEntries(Object.entries(patch).filter(([name])=>fields.includes(name))),token,tabId:toTabId,activeTabId:toTabId,scopeRevision:revision,scriptApproval:null,inputApproval:null,tabRequest:null,tabCandidates:[],members:closed?members.filter(member=>member.tabId!==id):members,membersRevision:closed?revision:task.membersRevision,updatedAt};
        const bindings={...registry.bindings};delete bindings[id];bindings[toTabId]=next;
        await area.set({taskRegistry:{...registry,pending:{kind:'tab_switched',tabId:id,toTabId,binding:next,previousTaskId:taskId,nextOwners}}});
        await area.set({[rootKey(taskId)]:record});
        await area.set({taskRegistry:registryOf(revision,bindings,nextOwners)});
        return record;
      });},
      async history(id,origin){
        const all=await area.get(null),current=await get(id),ids=new Set();
        for(const [name,record] of Object.entries(all))if(name.startsWith('conversation:'+id+':')||name.startsWith('conversation-origin:'+id+':'))ids.add(record.taskId);
        if(current)ids.add(current.taskId);
        const views=await Promise.all([...ids].map(taskId=>originView(id,taskId,origin,current)));
        return views.filter(Boolean).sort((a,b)=>b.updatedAt-a.updatedAt).map(t=>({taskId:t.taskId,goal:t.goal,status:t.status,updatedAt:t.updatedAt,archived:!!t.archived}));
      },
      async historyGet(id,origin,taskId){
        const view=await originView(id,taskId,origin,await get(id));
        if(!view)throw new Error('对话不存在或不属于当前授权网站');
        return view;
      },
      async closeMember(id,expectedTaskId,closedAt){return serial(async()=>{
        const registry=await readRegistry();if(registry.pending)throw scopeError();
        const task=await get(id);if(!task||task.taskId!==expectedTaskId)return null;
        const binding=registry.bindings[id];
        if(!binding||!(task.members||[]).some(member=>member.tabId===id))throw scopeError();
        const pending={kind:'member_closed',tabId:id,binding,closedAt};
        const journal={...registry,pending};await area.set({taskRegistry:journal});
        return finishMemberClose(journal);
      });},
      async removeHistory(id){
        for(const name of Object.keys(await area.get(null)))if(name.startsWith('conversation:'+id+':')||name.startsWith('conversation-origin:'+id+':'))await area.remove(name);
      },
      // Whole conversation across tabs and origins, oldest origin segment first; read-only and token-free.
      async conversation(taskId){
        const all=await area.get(null),segments=new Map();let base=null;
        for(const [name,value] of Object.entries(all)){
          if(value?.taskId!==taskId)continue;
          if(name.startsWith('conversation-origin:'))for(const segment of value.segments||[])segments.set(segment.id,segment.view);
          else if((name===rootKey(taskId)||name.startsWith('conversation:')||name.startsWith('task:'))&&(!base||(value.updatedAt||0)>=(base.updatedAt||0)))base=value;
        }
        const parts=[...segments.entries()].sort((a,b)=>a[0]-b[0]).map(([,view])=>view);
        if(base)parts.push(base);
        if(!parts.length)return null;
        const {token,pending,check,...view}=parts.at(-1);
        return {...view,taskId,results:parts.flatMap(v=>v.results||[]),events:parts.flatMap(v=>v.events||[])};
      },
      async conversationIds(){
        const ids=new Set();
        for(const [name,value] of Object.entries(await area.get(null)))if(typeof value?.taskId==='string'&&(name.startsWith('taskRoot:')||name.startsWith('task:')||name.startsWith('conversation:')||name.startsWith('conversation-origin:')))ids.add(value.taskId);
        return [...ids];
      },
      async deleteConversation(taskId){return serial(async()=>{
        const registry=await readRegistry(),all=await area.get(null);
        if(registry.pending)throw scopeError();
        if(Object.values(registry.bindings).some(binding=>binding.taskId===taskId)||Object.entries(all).some(([name,value])=>name.startsWith('task:')&&value?.taskId===taskId))throw new Error('该对话仍在标签页中，请先结束或清空后再删除');
        for(const [name,value] of Object.entries(all))if(value?.taskId===taskId&&(name===rootKey(taskId)||name.startsWith('conversation:')||name.startsWith('conversation-origin:')))await area.remove(name);
      });},
      async remove(id){return serial(async()=>{
        const registry=await readRegistry();if(registry.pending)throw scopeError();const binding=registry.bindings[id],bindings={...registry.bindings};delete bindings[id];
        // Remove compatibility alias before releasing ownership; roots remain authoritative.
        if(binding)for(const name of Object.keys(await area.get(null)))if(name.startsWith('conversation-origin:'+id+':'+binding.taskId+':'))await area.remove(name);
        await area.remove(key(id));await area.set({taskRegistry:registryOf(registry.revision+1,bindings,binding?releaseOwners(registry.tabOwners,binding.taskId):registry.tabOwners)});
        if(binding)await area.remove(rootKey(binding.taskId));
      });},
      async list(){const registry=await readRegistry(),all=await area.get(null),ids=new Set([...Object.keys(registry.bindings),...Object.keys(all).filter(k=>k.startsWith('task:')).map(k=>k.slice(5))]);return Promise.all([...ids].map(id=>get(Number(id))));},
      async reconcile(){return serial(async()=>{
        const registry=await readRegistry(),intent=registry.pending;if(!intent)return;
        if(intent.kind==='member_closed'){await finishMemberClose(registry);return;}
        if(intent.kind==='tab_switched'){
          // Adopt the new binding only if its root was written; otherwise keep the old one. Pause either way.
          const root=(await area.get(rootKey(intent.binding.taskId)))[rootKey(intent.binding.taskId)];
          const adopted=root?.taskId===intent.binding.taskId&&root.scopeRevision===intent.binding.revision&&root.tabId===intent.toTabId;
          const bindings={...registry.bindings};if(adopted){delete bindings[intent.tabId];bindings[intent.toTabId]=intent.binding;}
          if(root&&(adopted||root.scopeRevision===registry.bindings[intent.tabId]?.revision))await area.set({[rootKey(root.taskId)]:{...root,status:['completed','ended','stopped'].includes(root.status)?root.status:'paused',reason:'scope_reconciled'}});
          await area.set({taskRegistry:registryOf(Math.max(registry.revision,intent.binding.revision),bindings,adopted?intent.nextOwners:registry.tabOwners)});
          return;
        }
        if(intent.kind==='members_changed'){
          // Directory-only change: adopt owners only if the root already shows it; execution state is untouched.
          const root=(await area.get(rootKey(intent.taskId)))[rootKey(intent.taskId)];
          const adopted=root?.taskId===intent.taskId&&root.membersRevision===intent.membersRevision;
          await area.set({taskRegistry:registryOf(registry.revision+1,registry.bindings,adopted?intent.nextOwners:registry.tabOwners)});
          return;
        }
        const id=intent.tabId,newBinding=intent.binding,root=(await area.get(rootKey(newBinding.taskId)))[rootKey(newBinding.taskId)];
        const binding=root?.scopeRevision===newBinding.revision&&root.tabId===id?newBinding:registry.bindings[id];
        if(intent.kind==='origin_changed'&&binding?.revision!==newBinding.revision){
          const name=originKey(id,newBinding.taskId,intent.sourceOrigin),saved=(await area.get(name))[name];
          if(saved){saved.segments=saved.segments.filter(segment=>segment.id!==intent.sourceRevision);if(saved.segments.length)await area.set({[name]:saved});else await area.remove(name);}
        }
        const record=binding?(await area.get(rootKey(binding.taskId)))[rootKey(binding.taskId)]:(await area.get(key(id)))[key(id)];
        if(binding?.taskId===newBinding.taskId&&intent.previousTaskId&&intent.previousTaskId!==newBinding.taskId){
          const previous=(await area.get(rootKey(intent.previousTaskId)))[rootKey(intent.previousTaskId)];
          if(previous){const {token,pending,check,...view}=previous;await area.set({['conversation:'+id+':'+previous.taskId]:{...view,archived:true}});}
        }
        if(record){const paused={...record,status:['completed','ended','stopped'].includes(record.status)?record.status:'paused',reason:'scope_reconciled'};await area.set(binding?{[rootKey(binding.taskId)]:paused}:{[key(id)]:paused});}
        const bindings={...registry.bindings};if(binding)bindings[id]=binding;else delete bindings[id];
        await area.set({taskRegistry:registryOf(Math.max(registry.revision,newBinding.revision),bindings,binding===newBinding&&intent.nextOwners?intent.nextOwners:registry.tabOwners)});
        if(binding)await area.remove(key(id));
      });},
      async migrate(){
        await this.reconcile();
        const registry=await readRegistry(),bound=new Set(Object.values(registry.bindings).map(b=>rootKey(b.taskId)));
        const liveOwners=Object.fromEntries(Object.entries(registry.tabOwners).filter(([,owner])=>bound.has(rootKey(owner.taskId))));
        if(Object.keys(liveOwners).length!==Object.keys(registry.tabOwners).length)await area.set({taskRegistry:registryOf(registry.revision+1,registry.bindings,liveOwners)});
        for(const [name,record] of Object.entries(await area.get(null)))if(name.startsWith('taskRoot:')&&!bound.has(name)){const archived=(await area.get('conversation:'+record.tabId+':'+record.taskId))['conversation:'+record.tabId+':'+record.taskId];if(archived)await area.remove(name);}
        for(const [name,old] of Object.entries(await area.get(null))){
          if(name.startsWith('task:')){const id=Number(name.slice(5));if(Number.isInteger(id)){const registry=await readRegistry();if(!registry.bindings[id])await this.set(id,{...old,metrics:old.metrics||{observations:0,verifications:0,actions:0},check:old.check||null,waitDeadline:old.waitDeadline||null});else {await get(id);await area.remove(name);}}}
          if(!name.startsWith('chat:'))continue;
          const tabId=Number(name.slice(5)),s=old?.state;
          if(Number.isInteger(tabId)&&s?.goal&&!await this.get(tabId))await this.set(tabId,{
            version:2,taskId:crypto.randomUUID(),token:crypto.randomUUID(),tabId,origin:old.origin,goal:s.goal,
            status:'paused',phase:'observe',steps:s.steps||0,prefs:{maxSteps:100},results:[],pending:null,retries:0,
            events:[{time:Date.now(),text:'已迁移旧版目标，点击继续以读取当前页'}],updatedAt:Date.now()
          });
          await area.remove(name);
        }
      }
    };
  }
  root.PageAgentTaskStore={createTaskStore};
  if(typeof module!=='undefined')module.exports=root.PageAgentTaskStore;
})(globalThis);
