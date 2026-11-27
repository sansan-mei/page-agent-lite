const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const {parseHTML}=require('linkedom');
const backend=require('../extension/backend.js');const C=require('../extension/core.js');
const {runUi}=require('./i18n-helper.js');
const flush=()=>new Promise(r=>setImmediate(r));

function service(config,responses){
  const data={config:{apiFormat:'anthropic',endpoint:'https://api.anthropic.test/v1',key:'PRIVATE_KEY',model:'claude-x',language:'English',...config}},requests=[];
  const chrome={data,runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p},storage:{local:{async setAccessLevel(){},async get(k){return {[k]:structuredClone(data[k])};},async set(v){Object.assign(data,structuredClone(v));}}},permissions:{async contains(){return true;}}};
  const s=backend.createService(chrome,async(url,opts)=>{requests.push({url,headers:opts.headers,body:JSON.parse(opts.body)});const next=responses.shift();return typeof next==='function'?next():next;});
  return {chrome,requests,s};
}
const message=(content,stop_reason='end_turn',usage={input_tokens:40,output_tokens:7,cache_read_input_tokens:900,cache_creation_input_tokens:60})=>new Response(JSON.stringify({type:'message',role:'assistant',content,stop_reason,usage}));
const options={id:'test',url:'chrome-extension://test/options.html'};

test('Claude format sends a Messages request with x-api-key, cached system prompt and one forced tool',async()=>{
  const {requests,s}=service({},[message([{type:'tool_use',id:'toolu_1',name:'observe',input:{reply:'Look'}}],'tool_use')]);
  const result=await s.generateAgent('observe the page');
  const [{url,headers,body}]=requests;
  assert.equal(url,'https://api.anthropic.test/v1/messages');
  assert.equal(headers['x-api-key'],'PRIVATE_KEY');assert.equal(headers.Authorization,undefined);
  assert.equal(headers['anthropic-version'],'2023-06-01');assert.equal(headers['anthropic-dangerous-direct-browser-access'],'true');
  assert.equal(body.model,'claude-x');assert.equal(body.max_tokens,4096);assert.equal(body.messages.length,1);assert.equal(body.messages[0].role,'user');
  assert.equal(body.system[0].cache_control.type,'ephemeral');assert.match(body.system[0].text,/Call exactly one of the provided tools/);
  assert.deepEqual(body.tool_choice,{type:'auto',disable_parallel_tool_use:true},'some Claude models reject any/tool choices');
  assert.deepEqual(body.tools.map(t=>t.name),C.agentToolNames().filter(name=>name!=='run_script'));
  assert.equal(body.tools[0].input_schema.additionalProperties,false);
  assert.equal(body.reasoning_effort,undefined);assert.equal(body.thinking,undefined);
  assert.deepEqual(JSON.parse(result.text),{reply:'Look',action:'observe'});
  assert.deepEqual(result.usage,{promptTokens:1000,completionTokens:7,cachedTokens:900});
});

test('Claude replies keep the shared safety checks: one tool only, truncation, refusal, fenced JSON',async()=>{
  const two=[{type:'tool_use',name:'observe',input:{reply:'a'}},{type:'tool_use',name:'scroll',input:{reply:'b',value:'down'}}];
  let x=service({toolMode:'native'},[message(two,'tool_use'),message([{type:'text',text:'cut'}],'max_tokens'),message([],'refusal'),message([{type:'text',text:'thinking aloud'}],'pause_turn')]);
  await assert.rejects(()=>x.s.generateAgent('g'),e=>e.code==='MODEL_TOOL_CALL_MULTIPLE');
  await assert.rejects(()=>x.s.generateAgent('g'),e=>e.code==='MODEL_OUTPUT_TRUNCATED');
  await assert.rejects(()=>x.s.generateAgent('g'),e=>e.code==='MODEL_OUTPUT_REFUSED');
  await assert.rejects(()=>x.s.generateAgent('g'),e=>e.code==='MODEL_FINISH_UNSUPPORTED');
  x=service({},[message([{type:'text',text:'```json\n{"completed":[],"remaining":[]}\n```'}])]);
  assert.equal((await x.s.summarizeAgent('history')).text,'{"completed":[],"remaining":[]}');
  assert.equal(x.requests[0].body.tools,undefined);assert.equal(x.requests[0].body.tool_choice,undefined);
  await assert.rejects(()=>service({},[()=>new Response('not json PRIVATE_BODY')]).s.summarizeAgent('h'),e=>e.code==='MODEL_RESPONSE_INVALID'&&!e.message.includes('PRIVATE'));
});

test('Claude auto mode falls back to JSON text when tools are rejected, and settings validate the format',async()=>{
  const x=service({},[()=>new Response('{"type":"error","error":{"message":"tool_choice not allowed PRIVATE_BODY"}}',{status:400}),message([{type:'text',text:'{"reply":"ok","action":"observe"}'}])]);
  await assert.rejects(()=>x.s.generateAgent('g'),e=>e.code==='MODEL_PROTOCOL_FALLBACK'&&!e.message.includes('PRIVATE'));
  assert.equal(await x.s.agentProtocol(),'json');
  assert.equal(JSON.parse((await x.s.generateAgent('g')).text).action,'observe');assert.equal(x.requests[1].body.tools,undefined);
  await assert.rejects(()=>x.s.handle({type:'configure',config:{...x.chrome.data.config,apiFormat:'gemini'}},options),/设置格式无效/);
  const openai=service({},[]);delete openai.chrome.data.config.apiFormat;
  assert.equal((await openai.s.handle({type:'settings'},options)).apiFormat,'openai');
  const before=await openai.s.identity();openai.chrome.data.config.apiFormat='openai';
  assert.equal(await openai.s.identity(),before,'saving the default format keeps existing model identities');
  openai.chrome.data.config.apiFormat='anthropic';assert.notEqual(await openai.s.identity(),before);
});

test('options page saves the chosen API format and switches the endpoint hint',async()=>{
  const {document,window}=parseHTML(fs.readFileSync('extension/options.html','utf8'));
  const sent=[];
  const chrome={runtime:{id:'test',async sendMessage(m){sent.push(m);if(m.type==='settings')return {ok:true,value:{apiFormat:'anthropic',endpoint:'https://api.anthropic.com/v1',model:'claude-x',key:'',language:'English'}};if(m.type==='agentPreferences')return {ok:true,value:{}};return {ok:true,value:{ok:true}};}},permissions:{async request(){return true;},async contains(){return false;},onAdded:{addListener(){}},onRemoved:{addListener(){}}},storage:{local:{async get(){return {};},async set(){}},onChanged:{addListener(){}}},tabs:{async query(){return [];}},userScripts:undefined};
  runUi('extension/options.js',{chrome,document,window,URL,Date,PageAgentCore:C});
  for(let i=0;i<5;i++)await flush();
  assert.equal(document.getElementById('apiFormat').value,'anthropic');
  assert.equal(document.getElementById('endpoint').placeholder,'https://api.anthropic.com/v1');
  assert.match(document.getElementById('connection-hint').textContent,/\/messages/);
  document.getElementById('config').dispatchEvent(new window.Event('submit',{cancelable:true}));
  for(let i=0;i<5;i++)await flush();
  assert.equal(sent.find(m=>m.type==='configure')?.config.apiFormat,'anthropic');
});
