import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {createTaskWorkspace,validateTaskExport,planTaskMerge} = require('../apps/desktop/task-workspace.cjs');
const sha = value => createHash('sha256').update(value).digest('hex');
const file = (path,content='data') => ({path,content:Buffer.from(content).toString('base64')});
const clone = value => structuredClone(value);
const origin = path => ({path,runId:'source-run',taskId:'source-task',attemptId:'source-attempt',acceptedRevision:sha('accepted')});
const binding = () => ({projectId:'project',planVersion:1,runId:'run',taskId:'task',attemptId:'attempt',assigneeId:'employee',generation:1,
 contractHash:sha('contract'),permissionHash:sha('permission'),backend:{kind:'openshell',version:'0.1.2',image:'registry/image@sha256:'+sha('image'),policyHash:sha('policy')}});
const options = () => ({binding:binding(),readPaths:['inputs/source.txt','outputs/existing.txt'],writePaths:['outputs/new.txt','outputs/existing.txt'],
 canonicalFiles:[file('untouched/b.txt','B'),file('outputs/existing.txt','old'),file('inputs/source.txt','input')],
 origins:[origin('outputs/existing.txt'),origin('inputs/source.txt')]});
const exported = () => [file('outputs/new.txt','new'),file('inputs/source.txt','input'),file('outputs/existing.txt','updated')];

test('canonical order and scope are stable while unauthorized contents are not imported',()=>{
 const a=options(),b=clone(a);b.readPaths.reverse();b.writePaths.reverse();b.canonicalFiles.reverse();b.origins.reverse();
 const workspace=createTaskWorkspace(a);
 assert.deepEqual(workspace,createTaskWorkspace(b));
 assert.deepEqual(workspace.importedFiles,[file('inputs/source.txt','input'),file('outputs/existing.txt','old')]);
 assert.deepEqual(workspace.readPaths,['inputs/source.txt','outputs/existing.txt']);
 assert.deepEqual(workspace.outputBaseline,[{path:'outputs/existing.txt',sha256:sha('old')},{path:'outputs/new.txt',sha256:null}]);
 assert.equal(workspace.inputManifest[0].origin.acceptedRevision,sha('accepted'));
 assert.match(workspace.scopeHash,/^[0-9a-f]{64}$/);
});

test('merge returns a complete plan preserving disjoint files without mutating its inputs',()=>{
 const args=options(),workspace=createTaskWorkspace(args),before=clone({args,workspace});
 const delta=validateTaskExport(workspace,exported());
 assert.deepEqual(delta,[{path:'outputs/existing.txt',beforeSha256:sha('old'),afterSha256:sha('updated'),size:7,content:file('', 'updated').content},
  {path:'outputs/new.txt',beforeSha256:null,afterSha256:sha('new'),size:3,content:file('','new').content}]);
 const plan=planTaskMerge(workspace,exported(),args.canonicalFiles);
 assert.deepEqual(plan.mergedFiles,[file('inputs/source.txt','input'),file('outputs/existing.txt','updated'),file('outputs/new.txt','new'),file('untouched/b.txt','B')]);
 assert.equal(plan.scopeHash,workspace.scopeHash);assert.equal(plan.beforeRevision,workspace.baseCanonicalRevision);
 assert.notEqual(plan.beforeRevision,plan.afterRevision);assert.deepEqual(plan.delta,delta);
 assert.deepEqual({args,workspace},before);
});

test('unchanged export and absent new output produce no inferred deletion or completion assertion',()=>{
 const args=options(),workspace=createTaskWorkspace(args);
 assert.deepEqual(validateTaskExport(workspace,workspace.importedFiles),[]);
 assert.deepEqual(planTaskMerge(workspace,workspace.importedFiles,args.canonicalFiles).mergedFiles,
  [file('inputs/source.txt','input'),file('outputs/existing.txt','old'),file('untouched/b.txt','B')]);
});

test('unrelated revision changes and stale competing output baselines reject',()=>{
 const args=options(),workspace=createTaskWorkspace(args);
 for(const path of ['untouched/b.txt','outputs/existing.txt']) {
  const current=args.canonicalFiles.map(entry=>entry.path===path?file(path,'changed'):entry);
  assert.throws(()=>planTaskMerge(workspace,exported(),current),{code:'TASK_WORKSPACE_CONFLICT'});
 }
 const committed=planTaskMerge(workspace,exported(),args.canonicalFiles);
 assert.throws(()=>planTaskMerge(workspace,exported(),committed.mergedFiles),{code:'TASK_WORKSPACE_CONFLICT'});
});

test('modified or deleted read-only input and missing existing output reject the entire export',()=>{
 const workspace=createTaskWorkspace(options());
 for(const files of [exported().map(entry=>entry.path==='inputs/source.txt'?file(entry.path,'bad'):entry),
  exported().filter(entry=>entry.path!=='inputs/source.txt'),exported().filter(entry=>entry.path!=='outputs/existing.txt'),
  [...exported(),file('extra.txt')]]) assert.throws(()=>validateTaskExport(workspace,files));
});

test('every read requires an exact baseline and provenance; existing write targets require read authorization',()=>{
 for(const mutate of [args=>args.origins.pop(),args=>args.origins.push(origin('untouched/b.txt')),
  args=>args.origins.push(clone(args.origins[0])),args=>args.origins[0].acceptedRevision='bad',
  args=>args.origins[0].runId='',args=>args.origins[0].checkpointId='',args=>args.origins[0].extra=true,
  args=>args.readPaths.push('missing.txt'),args=>args.readPaths.splice(1,1)]) {
  const args=options();mutate(args);assert.throws(()=>createTaskWorkspace(args));
 }
});

test('binding identities, hashes and fixed backend are strict and bounded',()=>{
 for(const mutate of [b=>b.projectId='',b=>b.taskId='x'.repeat(241),b=>b.runId='run\n',b=>b.planVersion=0,b=>b.generation=1.5,
  b=>b.contractHash='A'.repeat(64),b=>b.permissionHash='f'.repeat(63),b=>b.backend.policyHash='bad',
  b=>b.backend.version='0.1.3',b=>b.backend.kind='native',b=>b.backend.image='',b=>b.backend.extra=true,b=>b.authorized=true]) {
  const args=options();mutate(args.binding);assert.throws(()=>createTaskWorkspace(args));
 }
});

test('whole workspace is revalidated for mutations, extra schema fields, forged hashes and internal consistency',()=>{
 const workspace=createTaskWorkspace(options());
 for(const mutate of [w=>w.profile='other',w=>w.schema=2,w=>w.binding.taskId='other',w=>w.binding.backend.policyHash=sha('other'),
  w=>w.inputManifest[0].origin.taskId='other',w=>w.scopeHash='0'.repeat(64),w=>w.baseCanonicalRevision=sha('other'),
  w=>w.outputBaseline[0].sha256=sha('other'),w=>w.inputManifest[0].sha256=sha('other'),
  w=>w.inputManifest[0].size++,w=>w.importedFiles[0].content=file('','tamper').content,w=>w.baseCanonicalManifest.pop(),
  w=>w.readPaths.reverse()]) {
  const changed=clone(workspace);mutate(changed);assert.throws(()=>validateTaskExport(changed,exported()));
  assert.throws(()=>planTaskMerge(changed,exported(),options().canonicalFiles));
 }
});

test('noncanonical paths, case collisions and file-directory prefixes reject in every file boundary',()=>{
 for(const path of ['../escape','a//b','a\\b','/absolute','C:drive','CON.txt','a.','a/.agent-private','a/../b','a\u0000b','x'.repeat(241)]) {
  const args=options();args.writePaths.push(path);assert.throws(()=>createTaskWorkspace(args));
  assert.throws(()=>validateTaskExport(createTaskWorkspace(options()),[...exported(),file(path)]));
 }
 for(const pair of [['a','A'],['a','a/b'],['A','a/b']]) {
  const args=options();args.writePaths.push(...pair);assert.throws(()=>createTaskWorkspace(args));
  assert.throws(()=>validateTaskExport(createTaskWorkspace(options()),[...exported(),...pair.map(path=>file(path))]));
 }
 const args=options();args.writePaths.push('UNTOUCHED/b.txt');assert.throws(()=>createTaskWorkspace(args));
});

test('file limits and canonical base64 apply to baseline, exported and merged file sets',()=>{
 const workspace=createTaskWorkspace(options());
 const oversized=file('outputs/new.txt','x'.repeat(5*1024*1024+1));
 for(const files of [[oversized],Array.from({length:129},(_,i)=>file('f'+i)),
  [file('outputs/new.txt','')].map(entry=>({...entry,content:'YQ='})),
  [{path:'outputs/new.txt',content:'YR=='}]]) {
  assert.throws(()=>createTaskWorkspace({...options(),canonicalFiles:files}));
  assert.throws(()=>validateTaskExport(workspace,files));
 }
 const large=Array.from({length:5},(_,i)=>file('big'+i,'x'.repeat(5*1024*1024)));
 assert.throws(()=>createTaskWorkspace({...options(),canonicalFiles:large}));
 const args={binding:binding(),readPaths:[],writePaths:['new'],origins:[],canonicalFiles:Array.from({length:128},(_,i)=>file('f'+i))};
 assert.throws(()=>planTaskMerge(createTaskWorkspace(args),[file('new')],args.canonicalFiles));
});

test('caller-supplied file metadata and authority assertions are not accepted',()=>{
 const args=options();args.canonicalFiles[0].sha256=sha('forged');assert.throws(()=>createTaskWorkspace(args));
 assert.throws(()=>createTaskWorkspace({...options(),authorized:true}));
 const workspace=createTaskWorkspace(options());
 assert.throws(()=>validateTaskExport(workspace,[...exported().slice(1),{...exported()[0],sha256:sha('forged')}]));
});
