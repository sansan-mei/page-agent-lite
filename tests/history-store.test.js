const {test}=require('node:test');const assert=require('node:assert/strict');
const H=require('../extension/history-store.js');

test('saved conversations keep display fields and drop tokens, checkpoints, archives and approvals',()=>{
 const view=H.snapshot({taskId:'a',goal:'Goal',status:'completed',origin:'https://a.test',token:'secret-token',pending:{plan:{}},check:{deadline:1},contextArchive:[{id:'h1',results:[{result:'archived body'}]}],scriptRequest:{code:'alert(1)'},members:[{tabId:9}],events:[{time:1,text:'hi'}],results:[{action:'click',result:'ok'}],updatedAt:7});
 for(const field of ['token','pending','check','contextArchive','scriptRequest','members'])assert.equal(view[field],undefined,field);
 assert.equal(view.archived,true);assert.equal(view.events[0].text,'hi');assert.equal(view.results[0].result,'ok');assert.equal(view.updatedAt,7);
});

test('sensitive operation values are hidden everywhere they repeat, short values only in their own fields',()=>{
 const task={taskId:'s',goal:'Use pass hunter22 and pin 12',status:'completed',events:[{time:1,text:'Filled hunter22'}],
  lastOutcome:{evidence:[{actual:'hunter22'}]},
  results:[{action:'fill',label:'Password',sensitive:true,request:{action:'fill',id:'t0',value:'hunter22',reply:'type hunter22'},result:'Matched hunter22',outcome:{status:'success',dispatch:'sent',code:'CONDITIONS_MATCH',observed:{value:'hunter22'},message:'ok'}},
   {action:'fill',label:'PIN',sensitive:true,request:{action:'fill',value:'12'},result:'Matched'},
   {action:'fill',label:'Name',request:{action:'fill',value:'Alice'},result:'Matched'}]};
 const view=H.snapshot(task),text=JSON.stringify(view);
 assert.equal(text.includes('hunter22'),false);
 assert.equal(view.results[0].request.value,H.HIDDEN);assert.equal(view.results[0].outcome.observed,undefined);assert.equal(view.results[0].outcome.code,'CONDITIONS_MATCH');
 assert.equal(view.results[1].request.value,H.HIDDEN);assert.match(view.goal,/pin 12/);
 assert.equal(view.results[2].request.value,'Alice');
 assert.equal(task.results[0].request.value,'hunter22','the live task is not modified');
});

test('oversized conversations keep the newest records and mark the copy truncated',()=>{
 const results=Array.from({length:200},(_,i)=>({action:'observe',result:'r'+i+'x'.repeat(500)}));
 const view=H.snapshot({taskId:'big',goal:'Long goal',status:'ended',results,events:[{time:1,text:'e'}]},20000);
 assert.ok(JSON.stringify(view).length<=20000);assert.equal(view.truncated,true);assert.equal(view.goal,'Long goal');
 assert.equal(view.results.at(-1).result.slice(0,4),'r199');
});

test('history store reports a clear error when IndexedDB is unavailable',async()=>{
 const store=H.createHistoryStore({factory:null});
 await assert.rejects(store.save({taskId:'a'}),/不支持/);await assert.rejects(store.list(),/不支持/);
});
