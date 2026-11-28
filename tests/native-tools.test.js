const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');
const backend=require('../extension/backend.js');const C=require('../extension/core.js');const P=require('../extension/prompts.js');
const {createRuntime}=require('../extension/runtime.js');

function fakeChrome(config){
  const data={config:{endpoint:'https://api.test/v1',key:'PRIVATE_KEY',model:'m',language:'English',...config}};
  return {data,runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p},storage:{local:{async setAccessLevel(){},async get(k){return {[k]:structuredClone(data[k])};},async set(v){Object.assign(data,structuredClone(v));}}},permissions:{async contains(){return true;}}};
}
const options={id:'test',url:'chrome-extension://test/options.html'};
const reply=message=>new Response(JSON.stringify({choices:[{finish_reason:message.tool_calls?'tool_calls':'stop',message}],usage:{prompt_tokens:100}}));
const call=(name,args)=>({id:'call_1',type:'function',function:{name,arguments:typeof args==='string'?args:JSON.stringify(args)}});
function service(config,responses){
  const chrome=fakeChrome(config),requests=[];
  const s=backend.createService(chrome,async(url,opts)=>{requests.push(JSON.parse(opts.body));const next=responses.shift();return typeof next==='function'?next():next;});
  return {chrome,requests,s};
}

test('auto mode sends one native tool per registry action with forced single tool choice',async()=>{
  const {requests,s}=service({},[reply({tool_calls:[call('observe',{reply:'Look'})]})]);
  assert.equal(await s.agentProtocol(),'native');
  const result=await s.generateAgent('observe');
  const body=requests[0];
  // run_script is offered only when the runtime passes capabilities.scripts (permission + API available).
  assert.deepEqual(body.tools.map(t=>t.function.name),C.agentPublicTools(C.agentToolNames()).filter(name=>!['run_script','click_point'].includes(name)));
  assert.equal(body.tool_choice,'required');assert.equal(body.parallel_tool_calls,false);
  for(const tool of body.tools){assert.equal(tool.type,'function');assert.equal(tool.function.parameters.additionalProperties,false);assert.ok(tool.function.parameters.required.includes('reply'));}
  assert.match(body.messages[0].content,/Call exactly one of the provided tools per turn/);assert.doesNotMatch(body.messages[0].content,/Return ONLY strict JSON/);
  assert.deepEqual(JSON.parse(result.text),{reply:'Look',action:'observe'});
  assert.equal(P.agentTools().find(t=>t.function.name==='click').function.parameters.properties.timeoutMs.maximum,30000);
  assert.equal(P.agentTools().find(t=>t.function.name==='tab').function.parameters.properties.timeoutMs,undefined);
});

test('grouped model tools: 33 registry actions are offered as 23-25 tools and map back to registry actions',()=>{
  const names=caps=>P.agentTools(caps).map(t=>t.function.name);
  assert.equal(names().length,23);assert.equal(names({scripts:true,vision:true,realInput:true}).length,25);
  for(const gone of ['double_click','right_click','tab_switch','tab_open','tab_close','site_memory_read','site_memory_write','site_memory_delete','site_memory_clear','global_memory_read','global_memory_write','global_memory_delete','global_memory_clear'])assert.ok(!names({scripts:true,vision:true,realInput:true}).includes(gone),gone);
  const covered=new Set(names({scripts:true,vision:true,realInput:true}).flatMap(n=>C.agentToolMembers(n)));assert.deepEqual([...covered].sort(),C.agentToolNames().slice().sort(),'every registry action stays reachable');
  const spec=n=>P.agentTools().find(t=>t.function.name===n).function.parameters;
  assert.deepEqual(spec('site_memory').properties.op.enum,['read','write','delete','clear']);assert.deepEqual(spec('site_memory').required,['reply','op']);
  assert.deepEqual(spec('tab').properties.op.enum,['switch','open','close']);assert.deepEqual(spec('click').properties.op.enum,['double','right']);assert.ok(!spec('click').required.includes('op'));
  assert.match(P.agentSystem('English','json'),/action \(done\|pause\|[^)]*\bclick\|[^)]*\btab\|[^)]*site_memory\|global_memory\)/);
  const snap={nodes:new Map([['e1',true]])},plan=p=>C.agentModelPlan(JSON.stringify({reply:'r',...p}),snap);
  assert.equal(plan({action:'click',id:'e1'}).action,'click');assert.equal(plan({action:'click',id:'e1',op:'double'}).action,'double_click');assert.equal(plan({action:'click',id:'e1',op:'right'}).action,'right_click');
  assert.equal(plan({action:'tab',op:'switch',id:'open1'}).action,'tab_switch');assert.equal(plan({action:'tab',op:'open',value:'https://a.test/'}).action,'tab_open');assert.equal(plan({action:'tab',op:'close',id:'tab2'}).action,'tab_close');
  const w=plan({action:'global_memory',op:'write',id:'pref',value:'v'});assert.equal(w.action,'global_memory_write');assert.equal('op' in w,false);
  assert.deepEqual(plan({action:'read_references',value:[{action:'site_memory',id:'a'},{action:'global_memory',id:'b'},{action:'skill_read',id:'c'}]}).value.map(r=>r.action),['site_memory_read','global_memory_read','skill_read']);
  assert.equal(plan({action:'site_memory_read',id:'a'}).action,'site_memory_read','registry names stay accepted as aliases');
  for(const bad of [{action:'site_memory',id:'a'},{action:'site_memory',op:'append',id:'a'},{action:'tab',op:'double',id:'tab1'},{action:'click',id:'e1',op:'triple'},{action:'observe',op:'read'},{action:'tab',op:'close',id:'open1'},{action:'click',id:'e1',op:'double',trusted:true}])assert.throws(()=>plan(bad),undefined,JSON.stringify(bad));
  assert.deepEqual(C.agentPublicAction('tab_open'),{action:'tab',op:'open'});assert.deepEqual(C.agentPublicAction('click'),{action:'click'});assert.deepEqual(C.agentPublicAction('observe'),{action:'observe'});
});

test('a native tool call yields the same validated plan as the strict JSON text',()=>{
  const snap={nodes:new Map([['e1',true]])};
  const plans=[
    {reply:'Save',action:'click',id:'e1',expected:[{kind:'url_changed'}],timeoutMs:5000,notice:'Submitting'},
    {reply:'Type',action:'fill',id:'e1',value:'Ada'},
    {reply:'Which?',action:'pause',pauseReason:'user',choices:['A','B']},
    {reply:'Go',action:'navigate',value:'https://example.test/a'},
    {reply:'Plan',action:'observe',subgoals:[{id:'g1',title:'Find form',status:'active'}]}
  ];
  for(const plan of plans){
    const {action,...args}=plan;
    const native=backend.parseChatResponse(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[call(action,args)]}}]}),'native');
    assert.deepEqual(C.agentPlan(native.text,snap),C.agentPlan(JSON.stringify(plan),snap));
  }
  // Same whitelist and checks: unknown tools, stale targets and bad values fail exactly like JSON.
  for(const [name,args] of [['execute_javascript',{reply:'x',value:'1'}],['run_script',{reply:'x',value:''}],['click',{reply:'x',id:'e9'}],['check',{reply:'x',id:'e1',value:'yes'}],['click',{id:'e1'}]]){
    const text=backend.parseChatResponse(JSON.stringify({choices:[{message:{tool_calls:[call(name,args)]}}]}),'native').text;
    assert.throws(()=>C.agentPlan(text,snap));
  }
});

test('native parsing rejects several, malformed or missing tool calls and keeps the stable error codes',()=>{
  const parse=(message,finish_reason='tool_calls')=>backend.parseChatResponse(JSON.stringify({choices:[{finish_reason,message}]}),'native');
  const click=call('click',{reply:'PRIVATE_REPLY',id:'e1'});
  for(const [message,reason,code] of [
    [{tool_calls:[click,call('fill',{reply:'x',id:'e1',value:'1'})]},'tool_calls','MODEL_TOOL_CALL_MULTIPLE'],
    [{tool_calls:[call('click','{"reply":"PRIVATE_REPLY",')]},'tool_calls','MODEL_TOOL_ARGUMENTS_INVALID'],
    [{tool_calls:[call('click','[1]')]},'tool_calls','MODEL_TOOL_ARGUMENTS_INVALID'],
    [{tool_calls:[call('click',{reply:'x',action:'fill'})]},'tool_calls','MODEL_TOOL_ARGUMENTS_INVALID'],
    [{tool_calls:[{type:'custom',function:{name:'click',arguments:'{}'}}]},'tool_calls','MODEL_TOOL_CALL_INVALID'],
    [{tool_calls:[{type:'function',function:{arguments:'{}'}}]},'tool_calls','MODEL_TOOL_CALL_INVALID'],
    [{function_call:{name:'click',arguments:'{}'}},'function_call','MODEL_TOOL_CALL_INVALID'],
    [{content:'PRIVATE_REPLY I will click'},'stop','MODEL_TOOL_CALL_MISSING'],
    [{content:''},'stop','MODEL_OUTPUT_EMPTY'],
    [{tool_calls:[click]},'length','MODEL_OUTPUT_TRUNCATED'],
    [{tool_calls:[click]},'content_filter','MODEL_OUTPUT_REFUSED'],
    [{tool_calls:[click],refusal:'PRIVATE_REPLY'},'tool_calls','MODEL_OUTPUT_REFUSED'],
    [{tool_calls:[call('fill',{reply:'x',id:'e1',value:'y'.repeat(12001)})]},'tool_calls','MODEL_OUTPUT_TOO_LARGE'],
    [{tool_calls:[click]},'PRIVATE_FINISH','MODEL_FINISH_UNSUPPORTED']
  ])assert.throws(()=>parse(message,reason),e=>e.code===code&&!e.message.includes('PRIVATE_'),code);
  // Content next to a single tool call is ignored; 'stop' is accepted as the finish reason.
  assert.deepEqual(JSON.parse(parse({content:'thinking',tool_calls:[click]},'stop').text),{reply:'PRIVATE_REPLY',id:'e1',action:'click'});
});

test('auto mode falls back to strict JSON after a content-only reply and remembers it per model',async()=>{
  const plan={reply:'Done',action:'done'};
  const {chrome,requests,s}=service({},[reply({content:'Sure, I will click Save'}),reply({content:JSON.stringify(plan)}),reply({tool_calls:[call('done',{reply:'Done'})]})]);
  await assert.rejects(()=>s.generateAgent('goal'),e=>e.code==='MODEL_PROTOCOL_FALLBACK');
  assert.deepEqual(chrome.data.nativeToolsUnsupported,[await s.identity()]);assert.equal(await s.agentProtocol(),'json');
  assert.equal((await s.generateAgent('goal')).text,JSON.stringify(plan));
  assert.equal(requests[1].tools,undefined);assert.equal(requests[1].tool_choice,undefined);assert.match(requests[1].messages[0].content,/Return ONLY strict JSON/);
  // Another model identity still starts native; saving settings again re-probes native tools.
  chrome.data.config.model='other';assert.equal(await s.agentProtocol(),'native');chrome.data.config.model='m';
  await s.handle({type:'configure',config:{...chrome.data.config,toolMode:'auto'}},options);
  assert.deepEqual(chrome.data.nativeToolsUnsupported,[]);assert.equal(await s.agentProtocol(),'native');
  assert.equal(JSON.parse((await s.generateAgent('goal')).text).action,'done');assert.ok(requests[2].tools);
});

test('HTTP 400 naming tools falls back in auto mode; other 400s and native mode do not remember',async()=>{
  const rejected=()=>new Response('{"error":{"message":"tool_choice is not supported PRIVATE_BODY"}}',{status:400});
  let x=service({},[rejected]);
  await assert.rejects(()=>x.s.generateAgent('goal'),e=>e.code==='MODEL_PROTOCOL_FALLBACK'&&!e.message.includes('PRIVATE_'));
  assert.equal(await x.s.agentProtocol(),'json');
  x=service({},[()=>new Response('{"error":"bad model PRIVATE_BODY"}',{status:422})]);
  await assert.rejects(()=>x.s.generateAgent('goal'),e=>e.code===undefined&&/API 422/.test(e.message)&&!e.message.includes('PRIVATE_'));
  assert.equal(x.chrome.data.nativeToolsUnsupported,undefined);assert.equal(await x.s.agentProtocol(),'native');
  x=service({toolMode:'native'},[rejected,reply({content:'plain text'})]);
  await assert.rejects(()=>x.s.generateAgent('goal'),e=>e.code==='MODEL_TOOLS_UNSUPPORTED');
  await assert.rejects(()=>x.s.generateAgent('goal'),e=>e.code==='MODEL_TOOL_CALL_MISSING');
  assert.equal(x.chrome.data.nativeToolsUnsupported,undefined);assert.equal(await x.s.agentProtocol(),'native');
});

test('json mode and summaries never send tools; settings expose and validate the tool mode',async()=>{
  const x=service({toolMode:'json'},[reply({content:'{"reply":"ok","action":"observe"}'}),reply({tool_calls:[call('observe',{reply:'ok'})]}),reply({content:'{}'})]);
  await x.s.generateAgent('goal');assert.equal(x.requests[0].tools,undefined);assert.match(x.requests[0].messages[0].content,/Return ONLY strict JSON/);
  await assert.rejects(()=>x.s.generateAgent('goal'),e=>e.code==='MODEL_TOOL_CALL_UNSUPPORTED');
  const auto=service({},[reply({content:'{}'})]);
  await auto.s.summarizeAgent('history');assert.equal(auto.requests[0].tools,undefined);assert.match(auto.requests[0].messages[0].content,/Summarize browser task history/);
  assert.equal(auto.chrome.data.nativeToolsUnsupported,undefined);
  assert.equal((await auto.s.handle({type:'settings'},options)).toolMode,'auto');
  await assert.rejects(()=>auto.s.handle({type:'configure',config:{...auto.chrome.data.config,toolMode:'xml'}},options),/设置格式无效/);
  await auto.s.handle({type:'configure',config:{...auto.chrome.data.config,toolMode:'json'}},options);assert.equal(auto.chrome.data.config.toolMode,'json');
});

test('token pressure includes the native tools schema',()=>{
  const task={prefs:{}},json=P.pressure(task,'{}',null,'json').estimatedTokens,native=P.pressure(task,'{}',null,'native').estimatedTokens;
  assert.ok(native-json>=P.estimateTokens(JSON.stringify(P.agentTools()))-P.estimateTokens(P.agentSystem('简体中文','json')),String(native-json));
  assert.ok(native>json);
});

test('run_script joins native tools and the prompt only when script capabilities are passed',async()=>{
  const names=caps=>P.agentTools(caps).map(t=>t.function.name);
  assert.ok(!names().includes('run_script'));assert.ok(!names({scripts:false}).includes('run_script'));
  assert.deepEqual(names({scripts:true,vision:true,realInput:true}),C.agentPublicTools(C.agentToolNames()));assert.ok(!names({scripts:true}).includes('click_point'));
  const tool=P.agentTools({scripts:true}).find(t=>t.function.name==='run_script');
  assert.deepEqual(tool.function.parameters.required,['reply','value']);
  assert.doesNotMatch(P.agentSystem('English','native'),/run_script/);assert.match(P.agentSystem('English','native',{scripts:true}),/OPTIONAL TOOL run_script[\s\S]*SCRIPT_REJECTED/);
  assert.match(P.agentSystem('English','json',{scripts:true}),/\|run_script\)/);
  assert.ok(P.pressure({prefs:{}},'{}',null,'native',{scripts:true}).estimatedTokens>P.pressure({prefs:{}},'{}',null,'native').estimatedTokens);
  // The backend forwards the runtime's per-turn flag into both the system prompt and the tools list.
  const {requests,s}=service({},[reply({tool_calls:[call('observe',{reply:'Look'})]}),reply({tool_calls:[call('observe',{reply:'Look'})]})]);
  await s.generateAgent('x',undefined,{scripts:true});await s.generateAgent('x');
  assert.ok(requests[0].tools.some(t=>t.function.name==='run_script'));assert.match(requests[0].messages[0].content,/OPTIONAL TOOL run_script/);
  assert.ok(!requests[1].tools.some(t=>t.function.name==='run_script'));assert.doesNotMatch(requests[1].messages[0].content,/run_script/);
});

function fixture(fetcher,config={}){
  const data=new Map(),executed=[];let seq=0;
  const store={async get(id){return structuredClone(data.get(id)||null);},async set(id,t){data.set(id,structuredClone(t));},async remove(id){data.delete(id);},async list(){return [...data.values()].map(t=>structuredClone(t));},async getMemory(){return [];},async setMemory(){},async removeMemory(){}};
  const tools={async tab(id){return {id,url:'https://example.test/1',status:'complete'};},async observe(){return {url:'https://example.test/1',snapshotId:'snap',page:{text:'Form',elements:[{id:'t0',label:'Save',tag:'button'}]}};},async execute(id,p){executed.push(p);return {version:2,status:'success',dispatch:'sent',scope:'ui',code:'CONDITIONS_MATCH',recovery:'none',message:'Matched'};}};
  const chrome=fakeChrome(config),requests=[];
  const s=backend.createService(chrome,async(url,opts)=>{requests.push(JSON.parse(opts.body));return fetcher(requests.length);});
  const runtime=createRuntime({store,tools,schedule:()=>{},cancelSchedule:async()=>{},uuid:()=>String(++seq),preferences:async()=>({maxSteps:50,contextTokens:32768}),
    model:s.generateAgent,summarize:s.summarizeAgent,identity:()=>s.identity(),protocol:()=>s.agentProtocol()});
  return {runtime,executed,requests,chrome};
}

test('runtime executes one native tool call once and the fallback turn counts as a step without side effects',async()=>{
  let f=fixture(()=>reply({tool_calls:[call('click',{reply:'Save',id:'t0'})]}));
  await f.runtime.start(1,'Save');await f.runtime.tick(1);
  assert.equal(f.executed.length,1);assert.equal(f.executed[0].plan.action,'click');assert.equal((await f.runtime.get(1)).steps,1);

  f=fixture(n=>n===1?reply({content:'I will click Save now'}):reply({content:JSON.stringify({reply:'Save',action:'click',id:'t0'})}));
  await f.runtime.start(1,'Save');await f.runtime.tick(1);
  let task=await f.runtime.get(1);
  assert.equal(f.executed.length,0);assert.equal(task.steps,1);assert.equal(task.retries,1);assert.equal(task.status,'running');
  assert.equal(task.lastOutcome.code,'MODEL_PROTOCOL_FALLBACK');assert.equal(task.lastOutcome.dispatch,'not_sent');
  await f.runtime.tick(1);task=await f.runtime.get(1);
  assert.equal(f.requests.length,2);assert.ok(f.requests[0].tools);assert.equal(f.requests[1].tools,undefined);
  assert.equal(f.executed.length,1);assert.equal(task.steps,2);assert.doesNotMatch(JSON.stringify(task),/PRIVATE_KEY/);
});

test('runtime never executes several native tool calls and does not retry them automatically',async()=>{
  const f=fixture(()=>reply({tool_calls:[call('click',{reply:'Save',id:'t0'}),call('click',{reply:'Again',id:'t0'})]}));
  await f.runtime.start(1,'Save');await f.runtime.tick(1);await f.runtime.tick(1);
  const task=await f.runtime.get(1);
  assert.equal(f.executed.length,0);assert.equal(f.requests.length,1);assert.equal(task.lastOutcome.code,'MODEL_TOOL_CALL_MULTIPLE');assert.equal(task.lastOutcome.dispatch,'not_sent');assert.notEqual(task.status,'running');
  assert.equal(f.chrome.data.nativeToolsUnsupported,undefined);
});

test('auto mode reuses a strict JSON text reply for this turn without marking native unsupported',async()=>{
  const {chrome,requests,s}=service({},[reply({content:JSON.stringify({reply:'Look',action:'observe'})}),reply({tool_calls:[call('observe',{reply:'Again'})]})]);
  const first=await s.generateAgent('observe');
  assert.deepEqual(JSON.parse(first.text),{reply:'Look',action:'observe'});
  assert.deepEqual(chrome.data.nativeToolsUnsupported||[],[]);
  assert.equal(await s.agentProtocol(),'native');
  await s.generateAgent('observe');assert.ok(requests[1].tools);
});
