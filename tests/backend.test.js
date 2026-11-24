const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');
const backend=fs.existsSync(require('node:path').join(__dirname,'../extension/backend.js'))?require('../extension/backend.js'):{};
function fake(){const data={};let granted=false;return {data,setGrant:v=>granted=v,runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p},storage:{local:{async setAccessLevel(x){data.level=x.accessLevel;},async get(k){return {[k]:data[k]};},async set(v){Object.assign(data,v);}}},permissions:{async contains(){return granted;}},scripting:{async registerContentScripts(x){data.scripts=x;},async getRegisteredContentScripts(){return [];},async unregisterContentScripts(){}}};}
const page={id:'test',url:'https://news.test/a?q=1#x',frameId:0,tab:{id:1}};
const options={id:'test',url:'chrome-extension://test/options.html'};
test('backend restricts storage, rejects untrusted senders and does not leak configuration',async()=>{
 assert.equal(typeof backend.createService,'function');const c=fake();const s=backend.createService(c,()=>{throw Error('unexpected');});await s.init();assert.equal(c.data.level,'TRUSTED_CONTEXTS');
 await assert.rejects(()=>s.handle({type:'settings'},page));await assert.rejects(()=>s.handle({type:'load'},{...page,id:'evil'}));await assert.rejects(()=>s.handle({type:'load'},{...page,frameId:1}));
 await assert.rejects(()=>s.handle({type:'configure',config:{endpoint:'https://api.test/v1',model:'m',key:'secret',language:'中文'}},options),/授权/);
 c.setGrant(true);await s.handle({type:'configure',config:{endpoint:'https://api.test/v1',model:'m',key:'secret',language:'中文'}},options);assert.equal((await s.handle({type:'settings'},options)).key,'secret');assert.deepEqual(await s.handle({type:'load'},page),{records:[],enabled:false});
});
test('site permission denial registers nothing; saved records survive restart and undo stays removed',async()=>{
 const c=fake(),s=backend.createService(c);await s.init();await assert.rejects(()=>s.handle({type:'enableSite',origin:'https://news.test'},options),/授权/);assert.equal(c.data.scripts,undefined);
 c.setGrant(true);await s.handle({type:'enableSite',origin:'https://news.test'},options);assert.equal(c.data.scripts[0].matches[0],'https://news.test/*');assert.equal(c.data.scripts[0].allFrames,false);
 const record={kind:'translation',target:{path:[0,0],tag:'p',text:'Original'},text:'译文'};
 await s.handle({type:'save',records:[record]},page);
 const restarted=backend.createService(c);assert.deepEqual((await restarted.handle({type:'load'}, {...page,url:'https://news.test/a?q=1#changed'})).records,[record]);
 assert.deepEqual((await restarted.handle({type:'load'},{...page,url:'https://news.test/a?q=2'})).records,[]);
 await restarted.handle({type:'save',records:[]},page);assert.deepEqual((await backend.createService(c).handle({type:'load'},page)).records,[]);
 await assert.rejects(()=>s.handle({type:'save',records:[{...record,key:'secret'}]},page));
 await assert.rejects(()=>s.handle({type:'save',records:Array(31).fill(record)},page));
 c.storage.local.set=async()=>{throw Error('QUOTA secret body');};await assert.rejects(()=>s.handle({type:'save',records:[record]},page),/存储空间/);
});
test('model uses background-only key and bounded task prompts; rejects errors without body leaks',async()=>{
 const c=fake();c.setGrant(true);c.data.config={endpoint:'https://api.test/v1',key:'secret-key',model:'model-one',language:'简体中文'};let request;
 const s=backend.createService(c,async(url,opts)=>{request={url,opts};return new Response(JSON.stringify({choices:[{message:{content:'翻译结果'}}]}));});
 assert.deepEqual(await s.handle({type:'model',task:'translate',text:'hello'},page),{text:'翻译结果'});assert.equal(request.url,'https://api.test/v1/chat/completions');assert.equal(request.opts.headers.Authorization,'Bearer secret-key');assert.equal(request.opts.redirect,'error');assert.match(JSON.parse(request.opts.body).messages[0].content,/简体中文/);
 await assert.rejects(()=>s.handle({type:'model',task:'translate',text:'x'.repeat(12001)},page));
 await assert.rejects(()=>s.handle({type:'model',task:'execute',text:'evil'},page));
 for(const status of [401,403,429,500]){const bad=backend.createService(c,async()=>new Response('secret-key private response',{status}));await assert.rejects(()=>bad.handle({type:'model',task:'summary',text:'article'},page),e=>!e.message.includes('secret-key')&&/API/.test(e.message));}
 const invalid=backend.createService(c,async()=>new Response('{bad'));await assert.rejects(()=>invalid.handle({type:'model',task:'summary',text:'article'},page),/响应/);
 const broken=backend.createService(c,async()=>new Response(new ReadableStream({start(controller){controller.error(Error('secret-key raw stream detail'));}})));
 await assert.rejects(()=>broken.handle({type:'model',task:'summary',text:'article'},page),e=>/响应/.test(e.message)&&!e.message.includes('secret-key'));
 const huge=backend.createService(c,async()=>new Response('x'.repeat(70000)));await assert.rejects(()=>huge.handle({type:'model',task:'summary',text:'article'},page),/过大/);
});
test('disabled sites never replay saved records; HTTP websites remain opt-in',async()=>{
 const c=fake(),s=backend.createService(c);c.setGrant(true);await s.init();
 await s.handle({type:'enableSite',origin:'http://news.test'},options);
 assert.equal(c.data.scripts[0].matches[0],'http://news.test/*');
 const p={...page,url:'http://news.test/a'};
 const record={kind:'summary',target:{path:[0],tag:'p',text:'Original'},text:'summary'};
 await s.handle({type:'save',records:[record]},p);
 await s.handle({type:'disableSite',origin:'http://news.test'},options);
 assert.deepEqual(await s.handle({type:'load'},p),{records:[],enabled:false});
 await assert.rejects(()=>s.handle({type:'sites'},page));
 assert.deepEqual(await s.handle({type:'sites'},options),[]);
});
test('trusted options opened in a real tab can read settings, but child frames and page senders cannot', async()=>{
 const c=fake(),s=backend.createService(c);await s.init();
 c.data.config={model:'test-model'};
 assert.equal((await s.handle({type:'settings'},{...options,frameId:0,tab:{id:4}})).model,'test-model');
 await assert.rejects(()=>s.handle({type:'settings'},{...options,frameId:1,tab:{id:4}}));
 await assert.rejects(()=>s.handle({type:'settings'},page));
});
test('input character limit defaults to 2000, validates range, persists and is readable by the side panel only among extension pages',async()=>{
 const c=fake(),s=backend.createService(c);await s.init();
 const panel={id:'test',url:'chrome-extension://test/sidepanel.html'};
 assert.equal((await s.handle({type:'agentPreferences'},panel)).inputChars,2000);
 for(const inputChars of [99,10001,1.5,'5000'])await assert.rejects(()=>s.handle({type:'setAgentPreferences',preferences:{maxSteps:50,inputChars}},options),/字符上限|设置无效/);
 assert.equal(c.data.agentPreferences,undefined);
 await s.handle({type:'setAgentPreferences',preferences:{maxSteps:50,inputChars:8000}},options);
 await s.handle({type:'setAgentPreferences',preferences:{maxSteps:60}},options);
 assert.equal((await s.handle({type:'agentPreferences'},panel)).inputChars,8000);
 await assert.rejects(()=>s.handle({type:'setAgentPreferences',preferences:{maxSteps:50,inputChars:3000}},panel));
 await assert.rejects(()=>s.handle({type:'agentPreferences'},{id:'test',url:'chrome-extension://test/other.html'}));
 await assert.rejects(()=>s.handle({type:'agentPreferences'},{...panel,frameId:1}));
});
module.exports={fake,page,options};

test('legacy execution switches are ignored and removed when preferences are saved',async()=>{
 const c=fake(),s=backend.createService(c);c.data.agentPreferences={maxSteps:12,contextTokens:64000,autoFill:false,autoClick:false};
 assert.deepEqual(await s.preferences(),{maxSteps:12,contextTokens:64000,compressionThreshold:80,inputChars:2000});
 await s.handle({type:'setAgentPreferences',preferences:{maxSteps:20}},options);
 assert.deepEqual(c.data.agentPreferences,{maxSteps:20,contextTokens:64000,compressionThreshold:80,inputChars:2000});
 await assert.rejects(()=>s.handle({type:'setAgentPreferences',preferences:{maxSteps:20,autoClick:false}},options));
});

test('agent preferences are bounded, page-readable and writable only by options; agent uses configured model',async()=>{
 const c=fake();c.setGrant(true);c.data.config={endpoint:'https://api.test/v1',key:'secret',model:'chosen',language:'中文'};
 let body;const s=backend.createService(c,async(url,opts)=>{body=JSON.parse(opts.body);return new Response(JSON.stringify({choices:[{message:{content:'{"reply":"完成","action":"done"}'}}]}));});
 assert.deepEqual(await s.handle({type:'agentPreferences'},page),{maxSteps:100,contextTokens:100000,compressionThreshold:80,inputChars:2000});
 await assert.rejects(()=>s.handle({type:'setAgentPreferences',preferences:{maxSteps:2}},page));
 for(const maxSteps of [-1,1.5,Number.MAX_SAFE_INTEGER+1])await assert.rejects(()=>s.handle({type:'setAgentPreferences',preferences:{maxSteps}},options));
 for(const maxSteps of [0,100,500]){
  await s.handle({type:'setAgentPreferences',preferences:{maxSteps}},options);
  assert.equal((await s.handle({type:'agentPreferences'},page)).maxSteps,maxSteps);
 }
 await s.handle({type:'setAgentPreferences',preferences:{maxSteps:2}},options);
 assert.deepEqual(await s.handle({type:'agentPreferences'},page),{maxSteps:2,contextTokens:100000,compressionThreshold:80,inputChars:2000});
 await s.handle({type:'model',task:'agent',text:JSON.stringify({goal:'读页面',page:{text:'x'.repeat(15000)}})},page);
 assert.equal(body.model,'chosen');assert.match(body.messages[0].content,/ONE action/);assert.match(body.messages[0].content,/untrusted/);
});


test('task compaction uses separate trusted summary system and configured model',async()=>{
 const c=fake();c.setGrant(true);c.data.config={endpoint:'https://api.test/v1',key:'secret-key',model:'summary-model',language:'中文'};let body;
 const s=backend.createService(c,async(url,request)=>{body=JSON.parse(request.body);return new Response(JSON.stringify({choices:[{message:{content:'{"completed":[],"remaining":[],"facts":[],"failed":[],"uncertain":[]}'}}]}));});
 await s.summarizeAgent('{"olderResults":[]}',new AbortController().signal);
 assert.equal(body.model,'summary-model');assert.match(body.messages[0].content,/exactly five arrays/);assert.doesNotMatch(body.messages[0].content,/Perform ONE action/);assert.equal(body.messages[1].content,'{"olderResults":[]}');
 await assert.rejects(()=>s.handle({type:'model',task:'agent',text:'summarize',summarize:true},page));
});


test('trusted agent accepts long prompts and reports normalized usage and model identity',async()=>{
 const c=fake();c.setGrant(true);c.data.config={endpoint:'https://api.test/v1',key:'key',model:'m',language:'中文'};
 const s=backend.createService(c,async()=>new Response(JSON.stringify({choices:[{message:{content:'{"action":"observe","reply":"ok"}'}}],usage:{prompt_tokens:20000,completion_tokens:10,prompt_tokens_details:{cached_tokens:18000}}})));
 const first=await s.generateAgent('x'.repeat(200000));assert.deepEqual(first.usage,{promptTokens:20000,completionTokens:10,cachedTokens:18000});assert.match(first.modelIdentity,/^[a-f0-9]{64}$/);
 c.data.config.model='other';assert.notEqual(await s.identity(),first.modelIdentity);
 await assert.rejects(()=>s.handle({type:'model',task:'agent',text:'x'.repeat(200000)},page));
});

test('context preferences validate ranges and legacy saves preserve configured budgets',async()=>{
 const c=fake(),s=backend.createService(c);await s.init();
 await s.handle({type:'setAgentPreferences',preferences:{maxSteps:50,contextTokens:131072,compressionThreshold:85}},options);
 await s.handle({type:'setAgentPreferences',preferences:{maxSteps:60}},options);
 assert.equal((await s.handle({type:'agentPreferences'},options)).contextTokens,131072);
 for(const p of [{contextTokens:8000},{contextTokens:300000},{compressionThreshold:99}])await assert.rejects(()=>s.handle({type:'setAgentPreferences',preferences:{maxSteps:50,...p}},options));
});

test('reasoning defaults, saved effort, summary requests and compatibility fallback reach API',async()=>{
 const c=fake();c.setGrant(true);c.data.config={endpoint:'https://api.test/v1',key:'secret',model:'m',language:'中文'};
 const requests=[];const s=backend.createService(c,async(url,request)=>{requests.push(JSON.parse(request.body));return new Response(JSON.stringify({choices:[{message:{content:'{}'}}]}));});
 assert.equal((await s.handle({type:'settings'},options)).reasoningEffort,'medium');
 await s.generateAgent('observe');assert.equal(requests.at(-1).reasoning_effort,'medium');assert.equal(requests.at(-1).temperature,undefined);assert.equal(requests.at(-1).max_tokens,undefined);
 const identity=await s.identity();
 for(const effort of ['low','high','medium','default']){
  await s.handle({type:'configure',config:{...c.data.config,reasoningEffort:effort}},options);
  await s.summarizeAgent('summarize');const body=requests.at(-1);
  assert.equal(body.reasoning_effort,effort==='default'?undefined:effort);
  assert.equal(body.max_tokens,effort==='default'?2000:undefined);
 }
 assert.notEqual(await s.identity(),identity);
 await assert.rejects(()=>s.handle({type:'configure',config:{...c.data.config,reasoningEffort:'invalid'}},options));
 await assert.rejects(()=>s.handle({type:'configure',config:{...c.data.config,reasoningEffort:'low'}},page));
 assert.equal(c.data.config.reasoningEffort,'default');
});

test('chat response parsing rejects truncated, refused and unsupported completions without leaking response data',()=>{
 const valid='{"reply":"Observe","action":"observe"}';
 const parse=(message,finish_reason)=>backend.parseChatResponse(JSON.stringify({choices:[{message,finish_reason}],usage:{prompt_tokens:10,completion_tokens:4,prompt_tokens_details:{cached_tokens:8}}}));
 assert.deepEqual(parse({content:valid},'stop'),{text:valid,usage:{promptTokens:10,completionTokens:4,cachedTokens:8}});
 assert.equal(parse({content:valid}).text,valid);assert.equal(parse({content:valid,tool_calls:null,refusal:null},'stop').text,valid);
 for(const [message,reason,code] of [[{content:valid},'length','MODEL_OUTPUT_TRUNCATED'],[{content:'PRIVATE_RESPONSE'},'content_filter','MODEL_OUTPUT_REFUSED'],[{content:valid,refusal:'PRIVATE_RESPONSE'},'stop','MODEL_OUTPUT_REFUSED'],[{content:valid,tool_calls:[{function:{arguments:'PRIVATE_RESPONSE'}}]},'stop','MODEL_TOOL_CALL_UNSUPPORTED'],[{content:valid},'tool_calls','MODEL_TOOL_CALL_UNSUPPORTED'],[{content:[{type:'text',text:'PRIVATE_RESPONSE'}]},'stop','MODEL_CONTENT_UNSUPPORTED'],[{content:''},'stop','MODEL_OUTPUT_EMPTY'],[{content:'x'.repeat(12001)},'stop','MODEL_OUTPUT_TOO_LARGE'],[{content:valid},'PRIVATE_FINISH','MODEL_FINISH_UNSUPPORTED']])assert.throws(()=>parse(message,reason),e=>e.code===code&&!e.message.includes('PRIVATE_'));
 assert.throws(()=>backend.parseChatResponse('{PRIVATE_INVALID'),e=>e.code==='MODEL_RESPONSE_INVALID'&&!e.message.includes('PRIVATE_'));
});
