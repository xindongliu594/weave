import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
import {RunSandbox,validArtifactPath,artifactFile,command} from './sandbox.mjs';
test('sandbox bounds paths, denies symlink reads, has no host mounts or network, and preserves artifacts',{timeout:30000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'sandbox-test-')),sandbox=new RunSandbox(randomUUID(),root);
 try{
  for(const path of ['/etc/passwd','../secret','a/../../secret','a\\b','a//b'])assert.throws(()=>validArtifactPath(path));
  const signal=AbortSignal.timeout(20000);
  const written=await sandbox.execute('artifact_write',{path:'result/report.md',content:'# 验收\n本地沙箱测试通过。'},signal);assert.equal(written.artifacts.length,1);
  assert.match((await sandbox.execute('filesystem',{path:'result/report.md'},signal)).content,/验收/);
  const state=JSON.parse(await command(['inspect',sandbox.name]));assert.equal(state[0].HostConfig.NetworkMode,'none');assert.equal(state[0].HostConfig.ReadonlyRootfs,true);assert.equal(state[0].Mounts.length,0);assert.equal(state[0].HostConfig.Memory,512*1024*1024);
  const run=await sandbox.execute('terminal_test',{command:'node -e "console.log(2+2)"'},signal);assert.match(run.output,/4/);assert.match(run.output,/exit_code=0/);
  await sandbox.execute('filesystem',{path:'result/report.md'},signal);
  await command(['exec',sandbox.name,'ln','-s','/etc/passwd','/workspace/escaped'],{signal});await assert.rejects(sandbox.execute('filesystem',{path:'escaped'},signal),/Symlinks/);
  assert.match(await readFile(artifactFile(root,'result/report.md'),'utf8'),/本地沙箱/);
  await sandbox.execute('terminal',{command:'rm result/report.md'},signal);await assert.rejects(readFile(join(root,'result/report.md')));
 }finally{await sandbox.close();await rm(root,{recursive:true,force:true});}
});

test('concurrent edits require the observed file version and approvals pin the workspace', {timeout:30000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'sandbox-conflict-')),sandbox=new RunSandbox(randomUUID(),root),signal=AbortSignal.timeout(25000);
 try{
  const first=await sandbox.execute('artifact_write',{path:'shared.txt',content:'original'},signal);
  const edits=await Promise.allSettled(['first edit','second edit'].map(content=>sandbox.execute('artifact_write',{path:'shared.txt',content,expectedSha256:first.sha256},signal)));
  assert.equal(edits.filter(r=>r.status==='fulfilled').length,1);assert.match(edits.find(r=>r.status==='rejected').reason.message,/FILE_VERSION_CONFLICT/);
  const current=await sandbox.execute('filesystem',{path:'shared.txt'},signal);assert.equal(current.content,'first edit');
  await assert.rejects(sandbox.execute('artifact_write',{path:'shared.txt',content:'blind overwrite'},signal),/FILE_VERSION_CONFLICT/);
  const approved=sandbox.revision();await sandbox.execute('artifact_write',{path:'other.txt',content:'new'},signal);
  await assert.rejects(sandbox.execute('terminal',{command:'echo overwritten > shared.txt',expectedWorkspaceRevision:approved},signal),/WORKSPACE_VERSION_CONFLICT/);
  assert.equal((await sandbox.execute('filesystem',{path:'shared.txt'},signal)).content,'first edit');
  await sandbox.execute('terminal',{command:'(sleep 2; echo background > shared.txt) >/dev/null 2>&1 &',expectedWorkspaceRevision:sandbox.revision()},signal);
  assert.equal(sandbox.started,false);assert.equal((await sandbox.execute('filesystem',{path:'shared.txt'},signal)).content,'first edit');
 }finally{await sandbox.close();await rm(root,{recursive:true,force:true});}
});
