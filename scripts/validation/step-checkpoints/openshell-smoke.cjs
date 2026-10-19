// Isolated engineering probe, not employee-produced delivery or model acceptance.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {OpenShellDeviceExecutor}=require('../../../apps/desktop/openshell-executor.cjs');
const {revision}=require('../../../apps/desktop/local-executor.cjs');
async function main(){
 const [configPath,out,mode]=process.argv.slice(2);
 if(process.platform!=='linux'||!out||!path.resolve(out).startsWith('/home/jj/.local/share/weiwu/validation/step-checkpoints-20261020/'))throw Error('Use on JJ inside the dedicated validation directory');
 if(mode==='--retire'){
  const stateFile=path.join(out,'result.json'),state=JSON.parse(fs.readFileSync(stateFile));assert.match(state.runId,/^[a-f0-9-]{36}$/);assert.equal(state.pendingOperation,null);
  const journalRoot=path.join(out,'journal'),scope=JSON.parse(fs.readFileSync(path.join(journalRoot,'openshell-scopes',state.runId+'.json')));
  assert.equal(scope.runId,state.runId);assert.equal(scope.activeOperation,null);assert.ok(['ready','stopped'].includes(scope.phase));
  const executor=new OpenShellDeviceExecutor({grant:{id:scope.grantId,root:path.join(out,'grant'),allowCommands:true},config:JSON.parse(fs.readFileSync(configPath)),journalRoot});
  try{state.retirement=await executor.retireStorage(state.runId,{sandboxId:scope.sandboxId,workspaceRevision:scope.workspaceRevision});fs.writeFileSync(stateFile,JSON.stringify(state,null,2));}
  finally{await executor.close();}
  console.log(JSON.stringify({runId:state.runId,retired:state.retirement.state==='retired',modelCalls:0}));return;
 }
 assert.equal(mode,undefined);
 fs.mkdirSync(out,{mode:0o700});const grant={id:randomUUID(),root:path.join(out,'grant'),allowCommands:true};fs.mkdirSync(grant.root);
 const config=JSON.parse(fs.readFileSync(configPath,'utf8')),runId=randomUUID(),journalRoot=path.join(out,'journal');
 const state={runId,modelCalls:0,commandExecutions:0,passed:false};
 const save=()=>fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(state,null,2),{mode:0o600});
 let executor=new OpenShellDeviceExecutor({grant,config,journalRoot});
 try{
  const code="import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import cp from 'node:child_process';test('confined verification',()=>{assert.equal(2+3,5);assert.throws(()=>fs.readFileSync('/etc/passwd'),{code:'ERR_ACCESS_DENIED'});assert.throws(()=>fs.writeFileSync('extra.txt','x'),{code:'ERR_ACCESS_DENIED'});assert.throws(()=>cp.spawn('node',['-v']),{code:'ERR_ACCESS_DENIED'});});\n";
  const files=[{path:'unit.mjs',content:Buffer.from(code).toString('base64')}];
  const prepared=await executor.execute({id:randomUUID(),runId,grantId:grant.id,name:'prepare',arguments:{},files},AbortSignal.timeout(180000));
  const job={id:randomUUID(),runId,grantId:grant.id,name:'terminal_test',approvalId:randomUUID(),verificationProfile:'node-permission-workspace-v1',arguments:{command:'node --test unit.mjs',expectedWorkspaceRevision:prepared.workspaceRevision}};
  state.pendingOperation=job.id;save();
  const result=await executor.execute(job,AbortSignal.timeout(180000));state.pendingOperation=null;state.commandExecutions++;
  assert.equal(result.exitCode,0,result.output);assert.equal(result.verificationProfile,job.verificationProfile);assert.equal(result.workspaceRevision,revision(result.files));
  assert.equal(result.workspaceRevision,prepared.workspaceRevision);assert.match(result.output,/[#ℹ] pass 1\b/);
  fs.writeFileSync(path.join(out,'test-output.txt'),result.output);state.execution=result.execution;state.workspaceRevision=result.workspaceRevision;save();
  await executor.close();assert.equal(executor.read(runId).phase,'stopped');
  executor=new OpenShellDeviceExecutor({grant,config,journalRoot});
  await assert.rejects(executor.execute(job),/已经完成/);
  const actual=await executor.inspectStorage(runId);assert.equal(actual.workspaceRevision,state.workspaceRevision);assert.equal(actual.sandboxId,state.execution.sandboxId);
  state.retirement=await executor.retireStorage(runId,{sandboxId:state.execution.sandboxId,workspaceRevision:state.workspaceRevision});
  state.passed=true;state.reopened=true;save();
 }catch(error){state.error={code:error.code,message:error.message};save();throw error;}finally{await executor.close();}
 console.log(JSON.stringify({passed:state.passed,runId,commandExecutions:state.commandExecutions,modelCalls:0,reopened:true,retired:state.retirement.state==='retired'}));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
