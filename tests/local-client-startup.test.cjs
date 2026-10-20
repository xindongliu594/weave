const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtempSync,rmSync,mkdirSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {LocalDeviceClient}=require('../apps/desktop/local-client.cjs');

test('approved enterprise device starts with its poll credential and never self-registers',async()=>{
  const root=mkdtempSync(join(tmpdir(),'weiwu-approved-device-')),workspace=join(root,'workspaces');
  mkdirSync(workspace);const calls=[];
  const device={id:'11111111-1111-4111-8111-111111111111',token:'a'.repeat(64),name:'fixture',grant:{id:'22222222-2222-4222-8222-222222222222',root:workspace,allowCommands:false}};
  const client=new LocalDeviceClient({connection:{server:'http://127.0.0.1:4311/'},device,journalRoot:join(root,'journal'),
    registerOnStart:false,pollMs:10000,executor:{async execute(){throw Error('unexpected operation');}},
    fetch:async(input,options)=>{calls.push({path:new URL(input).pathname,key:options.headers['X-Local-Device-Key']});return {ok:true,json:async()=>({job:null})};}});
  try{
    await client.start();await client.close();
    assert.ok(calls.length>0);
    assert.ok(calls.every(call=>call.path===`/api/local-devices/${device.id}/poll`&&call.key===device.token));
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('enterprise start rejects denied, changed-grant and unreachable first poll before connected',async()=>{
  for(const scenario of [
    {name:'revoked',status:403},
    {name:'unknown device',status:401},
    {name:'changed grant',status:403},
    {name:'server unavailable',throwError:true},
  ]){
    const root=mkdtempSync(join(tmpdir(),'weiwu-denied-device-')),states=[];
    const device={id:'11111111-1111-4111-8111-111111111111',token:'a'.repeat(64),name:'fixture',grant:{id:'22222222-2222-4222-8222-222222222222',root,allowCommands:false}};
    const client=new LocalDeviceClient({connection:{server:'http://127.0.0.1:4311/'},device,journalRoot:join(root,'journal'),
      registerOnStart:false,pollMs:10000,executor:{async execute(){throw Error('unexpected operation');}},onState:state=>states.push(state),
      fetch:async()=>{if(scenario.throwError)throw Error('fixture network failed');return {ok:false,status:scenario.status,json:async()=>({message:'fixture denied'})};}});
    try{
      await assert.rejects(client.start(),scenario.name);
      assert.equal(states.some(state=>state.status==='connected'),false,scenario.name);
      assert.equal(client.stopped,true,scenario.name);
    }finally{await client.close();rmSync(root,{recursive:true,force:true});}
  }
});

test('first successful enterprise poll retains its durable job receipt',async()=>{
  const root=mkdtempSync(join(tmpdir(),'weiwu-first-job-'));
  const device={id:'11111111-1111-4111-8111-111111111111',token:'a'.repeat(64),name:'fixture',grant:{id:'22222222-2222-4222-8222-222222222222',root,allowCommands:false}};
  const job={id:'33333333-3333-4333-8333-333333333333',claimToken:'44444444-4444-4444-8444-444444444444',runId:'55555555-5555-4555-8555-555555555555',name:'fixture',arguments:{},
    executionScope:{profile:'task-attempt-openshell-v1',key:'bound-key',scopeHash:'bound-hash',expectedWorkRevision:'revision'}};
  let polled=0,executions=0;const requests=[];
  const client=new LocalDeviceClient({connection:{server:'http://127.0.0.1:4311/'},device,journalRoot:join(root,'journal'),registerOnStart:false,pollMs:10,
    executor:{async execute(){executions++;return {ok:true};}},fetch:async(input,options)=>{
      const path=new URL(input).pathname;requests.push({path,body:JSON.parse(options.body)});
      if(path.endsWith('/poll'))return {ok:true,json:async()=>++polled===1?{job}:{job:null}};
      return {ok:true,json:async()=>({ok:true})};
    }});
  try{
    await client.start();assert.ok(client.active);await client.active.promise;await client.close();
    assert.equal(executions,1);
    assert.equal(requests.filter(request=>request.path.endsWith('/register')).length,0);
    assert.equal(requests.filter(request=>request.path.endsWith('/start')).length,1);
    const receipts=requests.filter(request=>request.path.endsWith('/result'));
    assert.ok(receipts.length>=1);
    for(const receipt of receipts){
      assert.equal(receipt.path,`/api/local-devices/${device.id}/operations/${job.id}/result`);
      assert.deepEqual(receipt.body,{claimToken:job.claimToken,ok:true,result:{ok:true}});
    }
    const saved=client.read(job.id);assert.equal(saved.phase,'acknowledged');assert.equal(saved.runId,job.runId);
    assert.equal(saved.claimToken,job.claimToken);assert.deepEqual(saved.receipt,{claimToken:job.claimToken,ok:true,result:{ok:true}});
    assert.deepEqual(saved.taskExecution,{key:'bound-key',scopeHash:'bound-hash',expectedWorkRevision:'revision',operationId:job.id});
  }finally{await client.close();rmSync(root,{recursive:true,force:true});}
});
