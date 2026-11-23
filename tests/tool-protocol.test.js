const {test}=require('node:test');const assert=require('node:assert/strict');const T=require('../extension/tool-protocol.js');
test('compatibility maps evidence and lost replies without reading display messages',()=>{
 const a=T.normalize({message:'anything',verification:{verified:true,actual:'4'}});
 assert.equal(a.status,'success');assert.equal(a.scope,'ui');
 const b=T.normalize({message:'success!',connection:'reconnected'});assert.equal(b.status,'unknown');assert.equal(b.dispatch,'unknown');
 const c=T.normalize({message:'failure!'});assert.equal(c.status,'unknown');assert.equal(c.code,'LEGACY_UNVERIFIED');
 assert.equal(T.failure({code:'PERMISSION_DENIED',message:'x'}).recovery,'pause');
 assert.equal(T.failure({code:'PAGE_BUSY'}).status,'pending');
});
test('V2 preserves document identity, validates enums and bounds returned evidence',()=>{
 const raw=T.result({documentId:'d1',status:'success',code:'CONDITIONS_MATCH'});
 assert.equal(T.normalize(raw,{documentId:undefined}).documentId,'d1');
 assert.throws(()=>T.result({status:'sure'}));
 assert.equal(T.result({observed:'x'.repeat(5000)}).observed.truncated,true);
 assert.equal(T.result({evidence:Array(10).fill({kind:'field',matched:true})}).evidence.length,5);
});

test('model receives canonical outcome, not contradictory compatibility verification after DOM relocation',()=>{
 const P=require('../extension/prompts.js');
 const outcome={...T.result({status:'success',code:'CONDITIONS_MATCH'}),verification:{verified:false}};
 const input=JSON.parse(P.agentInput({goal:'保存',steps:1,results:[{action:'fill',outcome,verification:{verified:false}}],lastOutcome:outcome},{elements:[]}));
 assert.equal(input.results[0].outcome.status,'success');assert.equal(input.results[0].outcome.verification,undefined);assert.equal(input.lastOutcome.verification,undefined);
});
