import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {validateTaskOperationResult,readCommittedCanonical} from '../apps/api/src/task-canonical.ts';
const {createTaskWorkspace}=createRequire(import.meta.url)('../apps/desktop/task-workspace.cjs');
const {manifest,revision}=createRequire(import.meta.url)('../apps/desktop/local-executor.cjs');
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const file=(path:string,text:string)=>({path,content:Buffer.from(text).toString('base64')});
function fixture(){
 const key={runId:'run',taskId:'task',attemptId:'attempt',generation:1};
 const files=[file('in.txt','input'),file('out.txt','output')];
 const workspace=createTaskWorkspace({binding:{projectId:'project',planVersion:1,...key,assigneeId:'employee',contractHash:sha('contract'),permissionHash:sha('permission'),backend:{kind:'openshell',version:'0.1.2',image:'image',policyHash:sha('policy')}},readPaths:['in.txt'],writePaths:['out.txt'],canonicalFiles:[file('in.txt','input'),file('secret.txt','private')],origins:[{path:'in.txt',runId:'run',taskId:'task',attemptId:'attempt',acceptedRevision:sha('origin')}]});
 const scope={profile:'task-attempt-openshell-v1',key,workspace,workRevision:workspace.baseCanonicalRevision};
 const executionScope={profile:scope.profile,key,binding:workspace.binding,scopeHash:workspace.scopeHash,readPaths:workspace.readPaths,writePaths:workspace.writePaths,inputManifest:workspace.inputManifest,expectedWorkRevision:revision(workspace.importedFiles)};
 const row={id:'operation',payload:{runId:'run',name:'terminal',arguments:{command:'fixture'},taskScope:scope,executionScope}};
 const result={localWorkspace:'/sandbox',exitCode:3,output:'known failure',files,artifacts:manifest(files),workspaceRevision:revision(files),taskExecution:{profile:scope.profile,key,scopeHash:workspace.scopeHash,operationId:row.id,beforeWorkRevision:executionScope.expectedWorkRevision,afterWorkRevision:revision(files)}};
 return {row,result};
}
test('independent task receipt validation recomputes manifests and keeps revision domains distinct',async()=>{
 const sql=new PGlite();try{
  await sql.exec('CREATE TABLE usage(id text);CREATE TABLE model_reservations(id text)');
  const {row,result}=fixture();assert.notEqual(row.payload.taskScope.workRevision,result.taskExecution.beforeWorkRevision);
  assert.doesNotThrow(()=>validateTaskOperationResult(row,result));
  for(const [name,change] of Object.entries<(r:any)=>void>({
   artifacts:r=>r.artifacts[0].sha256=sha('forged'),revision:r=>r.workspaceRevision=sha('forged'),scope:r=>r.taskExecution.scopeHash=sha('forged'),operation:r=>r.taskExecution.operationId='other',key:r=>r.taskExecution.key.generation=2,before:r=>r.taskExecution.beforeWorkRevision=row.payload.taskScope.workRevision,after:r=>r.taskExecution.afterWorkRevision=sha('forged'),
   changedRead:r=>r.files[0]=file('in.txt','changed'),deletedRead:r=>r.files.shift(),undeclared:r=>r.files.push(file('unknown.txt','extra')),mixed:r=>r.files.push(file('secret.txt','illegal')),link:r=>r.files[0].type='symlink',
  })){
   const forged=structuredClone(result);change(forged);assert.throws(()=>validateTaskOperationResult(row,forged),name);
  }
  assert.equal((await sql.query('SELECT * FROM usage')).rows.length,0);assert.equal((await sql.query('SELECT * FROM model_reservations')).rows.length,0);
 }finally{await sql.close();}
});

test('canonical metadata is bounded and validated before any object file is opened',()=>{
 const base={version:1,revision:sha('head'),manifest:[],mergeId:null,receipt:null};
 const manifests=[
  Array.from({length:5},(_,i)=>({path:`part-${i}.bin`,size:5*1024*1024,sha256:sha('object')})),
  [{path:'../outside',size:0,sha256:sha('object')}],
  [{path:'a',size:0,sha256:sha('object')},{path:'A',size:0,sha256:sha('object')}],
  [{path:'a',size:-1,sha256:sha('object')}],
 ];
 for(const manifest of manifests)assert.throws(()=>readCommittedCanonical('nonexistent-canonical-fixture',{id:'run',canonical_workspace:{...base,manifest,revision:sha(JSON.stringify(manifest))}}),{code:'TASK_CANONICAL_INVALID'});
});
