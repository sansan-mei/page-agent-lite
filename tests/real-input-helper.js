'use strict';
// Runtime fixtures whose subject is not the real-input approval itself: give each new task a task-scope approval
// (task.inputApproval) for its tab and origin, as if the user had clicked 本任务允许 once.
exports.preapprove=(runtime,store)=>{
  for(const name of ['start','submit']){
    const original=runtime[name];
    runtime[name]=async(tabId,...rest)=>{
      const created=await original(tabId,...rest),t=await store.get(tabId);
      if(t&&!t.inputApproval){t.inputApproval={scope:'task',origin:t.origin,tabId,grantedAt:0};await store.set(tabId,t);}
      return created;
    };
  }
  return runtime;
};
