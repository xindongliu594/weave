const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {tmpdir}=require('node:os');
const {randomUUID,randomBytes}=require('node:crypto');
const {LocalExecutor,validPath,decodeFiles,exportFiles,revision,runCommand}=require('./local-executor.cjs');
const {LocalDeviceClient}=require('./local-client.cjs');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function fixture(){const root=fs.mkdtempSync(path.join(tmpdir(),'department-local-test-')),grant={id:randomUUID(),root,allowCommands:true},runId=randomUUID(),executor=new LocalExecutor(grant);return {root,grant,runId,executor,cleanup(){assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir())+path.sep+'department-local-test-'));fs.rmSync(root,{recursive:true,force:true});}};}
test('native workspace preserves file versions and rejects traversal, Windows aliases and links',async()=>{
 const f=fixture();try{
  const job={runId:f.runId,grantId:f.grant.id};await f.executor.execute({...job,name:'prepare',files:[]});
  await assert.rejects(f.executor.execute({...job,name:'prepare',files:[]}),/已存在/);
  const written=await f.executor.execute({...job,name:'artifact_write',arguments:{path:'out/report.txt',content:'version 1'}});
  const read=await f.executor.execute({...job,name:'filesystem',arguments:{path:'out/report.txt'}});assert.equal(read.content,'version 1');assert.equal(read.sha256,written.sha256);
  await assert.rejects(f.executor.execute({...job,name:'artifact_write',arguments:{path:'out/report.txt',content:'stale'}}),{code:'FILE_VERSION_CONFLICT'});
  await f.executor.execute({...job,name:'artifact_write',arguments:{path:'out/report.txt',content:'version 2',expectedSha256:read.sha256}});
  for(const name of ['../outside','C:/outside','a:stream','a\\b','CON.txt','COM¹.txt','LPT²','out/file?','out/file.','out/dir /file','/outside','.Agent-private'])assert.throws(()=>validPath(name));
  for(const paths of [['Report.txt','report.txt'],['Report','report/file.txt']])assert.throws(()=>decodeFiles(paths.map(path=>({path,content:''}))),/格式/);
  await assert.rejects(f.executor.execute({...job,grantId:randomUUID(),name:'filesystem',arguments:{path:'out/report.txt'}}),/授权已经变化/);
  const outside=path.join(f.root,'outside.txt');fs.writeFileSync(outside,'outside');fs.linkSync(outside,path.join(f.root,f.runId,'hardlink.txt'));
  await assert.rejects(f.executor.execute({...job,name:'filesystem',arguments:{path:'hardlink.txt'}}),/链接/);fs.unlinkSync(path.join(f.root,f.runId,'hardlink.txt'));
  const outsideDir=path.join(f.root,'outside-dir');fs.mkdirSync(outsideDir);fs.symlinkSync(outsideDir,path.join(f.root,f.runId,'link-dir'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(f.executor.execute({...job,name:'artifact_write',arguments:{path:'link-dir/escape.txt',content:'escape'}}),/链接/);assert.equal(fs.existsSync(path.join(outsideDir,'escape.txt')),false);
 }finally{f.cleanup();}
});
test('native commands require capability, matching approval and current workspace version',async()=>{
 const f=fixture();try{
  const job={runId:f.runId,grantId:f.grant.id};await f.executor.execute({...job,name:'prepare',files:[]});
  const command=process.platform==='win32'?"Write-Output 'native-ok'":"printf 'native-ok'";
  await assert.rejects(f.executor.execute({...job,name:'terminal_test',arguments:{command}}),/逐次批准/);
  const result=await f.executor.execute({...job,name:'terminal_test',approvalId:randomUUID(),arguments:{command,expectedWorkspaceRevision:revision(exportFiles(path.join(f.root,f.runId)))}});assert.equal(result.exitCode,0);assert.match(result.output,/native-ok/);
  await assert.rejects(f.executor.execute({...job,name:'terminal_test',approvalId:randomUUID(),arguments:{command,expectedWorkspaceRevision:'stale'}}),{code:'WORKSPACE_VERSION_CONFLICT'});
  const filesOnly=new LocalExecutor({...f.grant,allowCommands:false});await assert.rejects(filesOnly.execute({...job,name:'terminal_test',approvalId:randomUUID(),arguments:{command}}),/逐次批准/);
 }finally{f.cleanup();}
});
function childCommand(){
 const script="const fs=require('fs');fs.writeFileSync('child.pid',String(process.pid));setInterval(()=>fs.appendFileSync('child-alive.txt','x'),50)",code="eval(Buffer.from('"+Buffer.from(script).toString('base64')+"','base64').toString())";
 const executable=process.execPath.replace(/'/g,"''");
 const psArgument=('-e \"'+code+'\"').replace(/'/g,"''");
 return process.platform==='win32'?"Start-Process -WindowStyle Hidden -FilePath '"+executable+"' -ArgumentList '"+psArgument+"'; while (!(Test-Path 'child.pid')) { Start-Sleep -Milliseconds 50 }; Write-Output 'child started'":"'"+executable+"' -e \""+code+"\" >/dev/null 2>&1 & while [ ! -f child.pid ]; do sleep 0.05; done; printf 'child started'";
}
test('a command that changes files but exceeds receipt limits remains an executed mutation',async()=>{
 const f=fixture();try{
  const job={runId:f.runId,grantId:f.grant.id};await f.executor.execute({...job,name:'prepare',files:[]});
  const code="require('fs').writeFileSync('too-large.txt',Buffer.alloc(6*1024*1024))",command='node -e "'+code+'"';
  await assert.rejects(f.executor.execute({...job,name:'terminal_test',approvalId:randomUUID(),arguments:{command}}),{code:'LOCAL_FILE_LIMIT',notExecuted:false});
  assert.equal(fs.statSync(path.join(f.root,f.runId,'too-large.txt')).size,6*1024*1024);
 }finally{f.cleanup();}
});
test('command completion and cancellation clean ordinary background descendants',async()=>{
 const f=fixture();try{
  const done=await runCommand(childCommand(),f.root);assert.equal(done.exitCode,0,done.output);
  await wait(150);const marker=path.join(f.root,'child-alive.txt'),length=fs.existsSync(marker)?fs.statSync(marker).size:0;await wait(200);assert.equal(fs.existsSync(marker)?fs.statSync(marker).size:0,length);
  fs.unlinkSync(path.join(f.root,'child.pid'));if(fs.existsSync(marker))fs.unlinkSync(marker);
  const controller=new AbortController(),command=childCommand()+(process.platform==='win32'?'; Start-Sleep -Seconds 30':'; sleep 30');
  const running=runCommand(command,f.root,controller.signal);const observed=running.catch(error=>error);
  for(let i=0;i<200&&!fs.existsSync(path.join(f.root,'child.pid'));i++)await wait(50);
  assert.equal(fs.existsSync(path.join(f.root,'child.pid')),true);controller.abort(Error('fixture cancellation'));const error=await observed;assert.match(error.message,/fixture cancellation/);
  await wait(150);const stopped=fs.existsSync(marker)?fs.statSync(marker).size:0;await wait(200);assert.equal(fs.existsSync(marker)?fs.statSync(marker).size:0,stopped);
 }finally{f.cleanup();}
});
test('lost operation receipt and process restart resend the receipt without replaying a mutation',async()=>{
 const f=fixture(),id=randomUUID(),token=randomBytes(32).toString('hex'),operation=randomUUID(),claimToken=randomUUID();let phase='queued',loseReceipt=true,writes=0,received=0;
 const request=async(url,options)=>{
  assert.equal(options.headers['X-Local-Device-Key'],token);const endpoint=new URL(url).pathname,body=JSON.parse(options.body);let value={ok:true};
  if(endpoint.endsWith('/poll')){
   if(body.active)value={cancel:false};
   else if(phase==='queued'){phase='claimed';value={job:{id:operation,runId:f.runId,grantId:f.grant.id,name:'prepare',files:[],claimToken}};}
   else if(phase==='started')value={orphan:{id:operation,claimToken,started:true}};
   else value={job:null};
  }else if(endpoint.endsWith('/start')){phase='started';writes++;}
  else if(endpoint.endsWith('/result')){received++;if(loseReceipt)throw Error('fixture response lost');phase='completed';assert.equal(body.ok,true);}
  return new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
 };
 const options={connection:{server:'http://127.0.0.1:12345/',username:'fixture',password:'fixture'},device:{id,token,name:'fixture',grant:f.grant},journalRoot:path.join(f.root,'journal'),fetch:request,pollMs:20};
 let client;
 try{
  client=new LocalDeviceClient(options);await client.start();for(let i=0;i<100&&received===0;i++)await wait(20);assert.ok(received>0);await client.close();assert.equal(writes,1);
  loseReceipt=false;client=new LocalDeviceClient(options);await client.start();for(let i=0;i<100&&client.read(operation).phase!=='acknowledged';i++)await wait(20);assert.equal(phase,'completed');assert.equal(writes,1);assert.equal(client.read(operation).phase,'acknowledged');
 }finally{await client?.close();f.cleanup();}
});

test('transient Windows receipt rename failures do not repeat the underlying operation',async()=>{
 const f=fixture(),rename=fs.promises.rename,id=randomUUID();let retries=0,writes=0;
 const client=new LocalDeviceClient({connection:{server:'http://127.0.0.1:12345/'},device:{id:randomUUID(),token:randomBytes(32).toString('hex'),grant:f.grant},journalRoot:path.join(f.root,'journal')});
 client.api=async()=>({ok:true});client.executor.execute=async()=>{writes++;return {ok:true};};
 fs.promises.rename=async(source,target)=>{if(JSON.parse(fs.readFileSync(source,'utf8')).phase==='starting'&&retries++<2)throw Object.assign(Error('temporary scanner lock'),{code:'EPERM'});return rename(source,target);};
 try{
  client.run({id,runId:f.runId,claimToken:randomUUID()});await client.active.promise;
  assert.equal(writes,1);assert.equal(client.read(id).phase,'acknowledged');assert.equal(retries,3);assert.equal(client.stopped,false);
  assert.equal(fs.readdirSync(client.journalRoot).length,1,'temporary receipts are removed after replacement');
 }finally{fs.promises.rename=rename;await client.close();f.cleanup();}
});

test('persistent receipt failure retains an unknown executed outcome and never replays on reopen',async()=>{
 const f=fixture(),rename=fs.promises.rename,id=randomUUID(),options={connection:{server:'http://127.0.0.1:12345/'},device:{id:randomUUID(),token:randomBytes(32).toString('hex'),grant:f.grant},journalRoot:path.join(f.root,'journal')};let writes=0,attempts=0;
 const client=new LocalDeviceClient(options);client.api=async()=>({ok:true});client.executor.execute=async()=>{writes++;return {ok:true};};
 fs.promises.rename=async(source,target)=>{if(JSON.parse(fs.readFileSync(source,'utf8')).phase==='completed'){attempts++;throw Object.assign(Error('persistent receipt lock'),{code:'EPERM'});}return rename(source,target);};
 try{
  const job={id,runId:f.runId,claimToken:randomUUID()};client.run(job);await client.active.promise;
  assert.equal(writes,1);assert.equal(attempts,6);assert.equal(client.stopped,true);assert.equal(client.read(id).phase,'executing');
  fs.promises.rename=rename;const reopened=new LocalDeviceClient(options);reopened.executor.execute=async()=>{writes++;};
  reopened.run(job);assert.equal(reopened.pending.get(id).error.code,'LOCAL_OUTCOME_UNKNOWN');assert.equal(reopened.pending.get(id).error.notExecuted,false);assert.equal(writes,1);await reopened.close();
 }finally{fs.promises.rename=rename;await client.close();f.cleanup();}
});
