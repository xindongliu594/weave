import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { workspaceRevision, inspectArtifact } from '../services/agent-runtime/handoff.mjs';
import { listArtifacts, RunSandbox } from '../services/agent-runtime/sandbox.mjs';
import { resumeHandoff } from '../apps/api/src/handoff-checkpoints.ts';
const { LocalExecutor, exportFiles, manifest, revision, canonicalManifest } = createRequire(import.meta.url)('../apps/desktop/local-executor.cjs');
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');

test('native receipts, backend native mirror and host/sandbox share mixed-case Unicode/nested workspace revision independent of enumeration/locale',async()=>{
 const root=await mkdtemp(join(tmpdir(),'workspace-revision-')),runId=randomUUID(),grantId=randomUUID(),executor=new LocalExecutor({id:grantId,root,allowCommands:false});
 try{
  const names=['README.md','acceptance.test.mjs','server.mjs','todo.test.mjs','a/nested.txt','a-outer.txt','équipe.txt','中文.txt','😀.txt'];
  // Reverse insertion order also differs from depth-first filesystem traversal.
  const files=names.slice().reverse().map(path=>({path,content:Buffer.from('fixture '+path).toString('base64')}));
  await executor.execute({runId,grantId,name:'prepare',files});const workspace=join(root,runId);
  const expected=hash(JSON.stringify(manifest(files))),original=String.prototype.localeCompare;
  try{
   String.prototype.localeCompare=function(){throw Error('Workspace hashing must not depend on locale');};
   const before=JSON.stringify(listArtifacts(workspace)),canonical=canonicalManifest(listArtifacts(workspace));
   assert.equal(JSON.stringify(listArtifacts(workspace)),before,'Canonical projection does not mutate source metadata');
   assert.deepEqual(canonical.map((row:any)=>row.path),names.slice().sort());
   assert.equal(workspaceRevision(workspace),expected);assert.equal(new RunSandbox(runId,workspace).revision(),expected);
   assert.equal(revision(exportFiles(workspace)),expected,'Backend LocalRunExecutor uses this same existing exportFiles/revision pair');
   const read=await executor.execute({runId,grantId,name:'filesystem',arguments:{path:'README.md',expectedWorkspaceRevision:expected}});
   assert.equal(read.workspaceRevision,expected);assert.deepEqual(read.artifacts,canonical);
   assert.equal(hash(JSON.stringify(canonicalManifest(canonical.slice().reverse().map((row:any)=>({sha256:row.sha256,ignored:'not a hash field',size:row.size,path:row.path}))))),expected,'Order of inputs and object fields does not affect fixed hash fields');
  }finally{String.prototype.localeCompare=original;}
  const old=workspaceRevision(workspace);await writeFile(join(workspace,'README.md'),'changed fixture');
  assert.notEqual(workspaceRevision(workspace),old);assert.equal(workspaceRevision(workspace),revision(exportFiles(workspace)));
  await assert.rejects(executor.execute({runId,grantId,name:'filesystem',arguments:{path:'README.md',expectedWorkspaceRevision:old}}),{code:'WORKSPACE_VERSION_CONFLICT'});
  await mkdir(join(workspace,'new-dir'));await writeFile(join(workspace,'new-dir','file.txt'),'new');
  assert.equal(workspaceRevision(workspace),new RunSandbox(runId,workspace).revision());
 }finally{await rm(root,{recursive:true,force:true});}
});

test('an old locale-based completed seal is preserved byte-for-byte on recovery while current file SHA checks still reject tampering',async()=>{
 const root=await mkdtemp(join(tmpdir(),'workspace-old-seal-'));
 try{
  const paths=['README.md','acceptance.test.mjs','server.mjs','todo.test.mjs'];for(const path of paths)await writeFile(join(root,path),'old fixture '+path);
  const outputs=paths.map(path=>inspectArtifact(root,{path})),legacy=hash(JSON.stringify(listArtifacts(root).sort((a:any,b:any)=>a.path.localeCompare(b.path))));
  assert.notEqual(legacy,workspaceRevision(root),'Fixture exercises the historical upper/lower-case collation difference');
  const record={taskId:'qa',attemptId:'old-attempt',runId:'old-source-run',workspaceRevision:legacy,outputs,commands:[{command:'node --test acceptance.test.mjs',exitCode:0,workspaceRevision:legacy,evidence:{runId:'old-source-run'}}]};
  const snapshot={agents:[],tasks:[{id:'qa',dependencies:[],outputs:paths.map(path=>({path})),verify:['node --test acceptance.test.mjs']},{id:'manager',dependencies:['qa'],inputs:paths.map(path=>({path,producerTaskId:'qa'})),outputs:[]}]};
  const events=[{type:'handoff/accepted',data:record}],completed=new Map([['qa',{attemptId:'old-attempt',status:'completed'}]]),before=JSON.stringify(record);
  const resumed=resumeHandoff(snapshot,events,completed,root);assert.equal(JSON.stringify(resumed[0]),before);assert.equal(JSON.stringify(record),before);
  assert.equal(resumed[0].workspaceRevision,legacy);assert.equal(resumed[0].commands[0].workspaceRevision,legacy,'Old evidence retains its original hash basis; it is not rewritten to canonical');
  await writeFile(join(root,'acceptance.test.mjs'),'tampered');assert.throws(()=>resumeHandoff(snapshot,events,completed,root),/已变化/);
  assert.equal(JSON.stringify(record),before,'Failed compatibility validation also leaves historical records unchanged');
 }finally{await rm(root,{recursive:true,force:true});}
});
