// Original native Office package inside the production OpenShell adapter.
// Zero model calls; component evidence, not employee model acceptance.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{spawnSync}=require('node:child_process');
const {OpenShellDeviceExecutor}=require('../../apps/desktop/openshell-executor.cjs');
async function main(){
 const [mode,configPath,bundleDir,out]=process.argv.slice(2);
 if(!['--run','--resume','--retire'].includes(mode)||!out||process.platform!=='linux')throw Error('Use --run|--resume|--retire config.json fixed-bundle-dir new-output-dir on JJ');
 const config=JSON.parse(fs.readFileSync(configPath)),manifest=JSON.parse(fs.readFileSync(path.join(bundleDir,'manifest.json'))),id=path.basename(bundleDir);
 const stateFile=path.join(out,'checkpoint.json'),files=['report.docx','metrics.xlsx','brief.pptx'];
 let state;if(mode==='--run'){
  fs.mkdirSync(out,{mode:0o700});fs.mkdirSync(path.join(out,'grant'));fs.mkdirSync(path.join(out,'artifacts'));
  state={kind:'native-openshell-component',runId:randomUUID(),grant:{id:randomUUID(),root:path.resolve(out,'grant'),allowCommands:false},pluginId:id,modelCalls:0,pluginCalls:0,firstPid:process.pid};
 }else state=JSON.parse(fs.readFileSync(stateFile));
 const save=()=>fs.writeFileSync(stateFile,JSON.stringify(state,null,2),{mode:0o600});
 const executor=new OpenShellDeviceExecutor({grant:state.grant,config,journalRoot:path.resolve(out,'journal'),loadNativeBundle:async requested=>{assert.equal(requested,id);return {manifest,compressed:fs.readFileSync(path.join(bundleDir,'bundle.gz')),metadata:fs.readFileSync(path.join(bundleDir,'package.json'))};}});
 const call=async(name,args,extra={})=>{const job={id:randomUUID(),runId:state.runId,grantId:state.grant.id,name,arguments:args,...extra};state.pending=job.id;save();const result=await executor.execute(job,AbortSignal.timeout(180000));state.pending=null;state.workspaceRevision=result.workspaceRevision;state.execution=result.execution;state.artifacts=result.artifacts;state.lastJob=job;save();for(const file of result.files)fs.writeFileSync(path.join(out,'artifacts',file.path),Buffer.from(file.content,'base64'));return result;};
 const native=async(name,args)=>{const result=await call('native_plugin',{pluginId:id,toolName:'plugin__office__'+name,originalName:name,arguments:args,readPaths:files,writePaths:name.endsWith('_read')?[]:files,expectedWorkspaceRevision:state.workspaceRevision},{context:{callId:randomUUID()}});assert.equal(result.nativeResult.isError,false,JSON.stringify(result.nativeResult));state.pluginCalls++;save();return result;};
 try{
  if(mode==='--retire'){
   assert.equal(state.pending,null);const scope=executor.read(state.runId);assert.ok(['ready','stopped'].includes(scope.phase));state.retirement=await executor.retireStorage(state.runId,{sandboxId:scope.sandboxId,workspaceRevision:scope.workspaceRevision});save();
  }else if(mode==='--run'){
   await call('prepare',{}, {files:[]});
   await native('docx_create',{destination_path:'report.docx',title:'OpenShell native report',content:[{type:'paragraph',text:'10 checks, 2 failures.'}]});
   await native('xlsx_write',{file_path:'metrics.xlsx',data:[['checks','failures'],[10,2]]});
   await native('pptx_create',{destination_path:'brief.pptx',slides:[{type:'title',title:'OpenShell native report',body:'10 checks, 2 failures.'}]});
   for(const [name,file]of [['docx_read',files[0]],['xlsx_read',files[1]],['pptx_read',files[2]]])assert.match(JSON.stringify((await native(name,{file_path:file,...(name==='xlsx_read'?{sheet:'Sheet1'}:{})})).nativeResult.value),/10/);
   state.beforeRestart={workspaceRevision:state.workspaceRevision,sandboxId:state.execution.sandboxId,pluginCalls:state.pluginCalls};
   await executor.close();assert.equal(executor.read(state.runId).phase,'stopped');save();
   const child=spawnSync(process.execPath,[__filename,'--resume',configPath,bundleDir,out],{stdio:'inherit',timeout:240000});if(child.status!==0)throw Error('Resume worker failed; no automatic replay');
   state=JSON.parse(fs.readFileSync(stateFile));assert.equal(state.passed,true);
  }else{
   assert.notEqual(state.firstPid,process.pid);assert.equal(state.pending,null);state.resumePid=process.pid;
   await assert.rejects(executor.execute(state.lastJob),/已经完成/);
   await native('docx_read',{file_path:files[0]});
   assert.equal(state.execution.sandboxId,state.beforeRestart.sandboxId);assert.equal(state.workspaceRevision,state.beforeRestart.workspaceRevision);assert.equal(state.pluginCalls,7);
   const AdmZip=require('adm-zip');for(const [file,part]of [[files[0],'word/document.xml'],[files[1],'xl/worksheets/sheet1.xml'],[files[2],'ppt/slides/slide1.xml']])assert.match(new AdmZip(fs.readFileSync(path.join(out,'artifacts',file))).readAsText(part),/10/);
   state.retirement=await executor.retireStorage(state.runId,{sandboxId:state.execution.sandboxId,workspaceRevision:state.workspaceRevision});state.passed=true;state.restartVerified=true;save();
  }
 }catch(error){state.error={message:error.message,code:error.code};save();throw error;}finally{await executor.close();}
 console.log(JSON.stringify({passed:state.passed,runId:state.runId,pluginCalls:state.pluginCalls,modelCalls:0,restartVerified:state.restartVerified}));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
