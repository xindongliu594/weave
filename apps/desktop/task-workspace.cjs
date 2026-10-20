const {createHash} = require('node:crypto');
const {isDeepStrictEqual} = require('node:util');
const {validPath,decodeFiles,canonicalManifest,manifest,revision} = require('./local-executor.cjs');

const PROFILE = 'weiwu-task-workspace-v1';
const hash = value => createHash('sha256').update(value).digest('hex');
const compare = (a,b) => a.path<b.path?-1:a.path>b.path?1:0;
function reject(message,code='TASK_WORKSPACE_INVALID') { throw Object.assign(new Error(message),{code}); }
function record(value,required,optional=[]) {
 if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value))||
  required.some(key=>!Object.hasOwn(value,key))||Reflect.ownKeys(value).some(key=>!required.includes(key)&&!optional.includes(key))) reject('Unexpected task workspace schema');
}
function identity(value,max=240) {
 if(typeof value!=='string'||!value||value.trim()!==value||value.length>max||/[\x00-\x1f\x7f]/.test(value)) reject('Invalid task workspace identity');
 return value;
}
function digest(value) {
 if(typeof value!=='string'||! /^[a-f0-9]{64}$/.test(value)) reject('Invalid task workspace SHA256');
 return value;
}
function positive(value) {
 if(!Number.isSafeInteger(value)||value<=0) reject('Invalid task workspace generation or version');
 return value;
}
function checkedBinding(value) {
 record(value,['projectId','planVersion','runId','taskId','attemptId','assigneeId','generation','contractHash','permissionHash','backend']);
 record(value.backend,['kind','version','image','policyHash']);
 if(value.backend.kind!=='openshell'||value.backend.version!=='0.1.2') reject('Unsupported task workspace backend');
 return {projectId:identity(value.projectId),planVersion:positive(value.planVersion),runId:identity(value.runId),taskId:identity(value.taskId),
  attemptId:identity(value.attemptId),assigneeId:identity(value.assigneeId),generation:positive(value.generation),
  contractHash:digest(value.contractHash),permissionHash:digest(value.permissionHash),
  backend:{kind:'openshell',version:'0.1.2',image:identity(value.backend.image,1024),policyHash:digest(value.backend.policyHash)}};
}
function checkedFiles(value) {
 if(!Array.isArray(value)) reject('Expected task workspace file array');
 for(const entry of value) record(entry,['path','content']);
 return decodeFiles(value).map(({path,bytes})=>({path,content:bytes.toString('base64')}));
}
function checkedPaths(value) {
 if(!Array.isArray(value)) reject('Expected task workspace paths');
 // Use the executor's exact duplicate, prefix, canonical path and count rules.
 return decodeFiles(value.map(path=>({path,content:''}))).map(entry=>entry.path);
}
function checkedOrigins(value,readPaths) {
 if(!Array.isArray(value)||value.length!==readPaths.length) reject('Every input needs exactly one origin');
 const entries=value.map(entry=>{
  record(entry,['path','runId','taskId','attemptId','acceptedRevision'],['checkpointId']);
  return {path:validPath(entry.path),runId:identity(entry.runId),taskId:identity(entry.taskId),attemptId:identity(entry.attemptId),
   acceptedRevision:digest(entry.acceptedRevision),...(Object.hasOwn(entry,'checkpointId')?{checkpointId:identity(entry.checkpointId)}:{})};
 }).sort(compare);
 if(!isDeepStrictEqual(checkedPaths(entries.map(entry=>entry.path)),readPaths)) reject('Input origins do not match read paths');
 return entries;
}
function checkedManifest(value) {
 if(!Array.isArray(value)) reject('Expected canonical manifest');
 let total=0;
 for(const entry of value) {
  record(entry,['path','size','sha256']);validPath(entry.path);digest(entry.sha256);
  if(!Number.isSafeInteger(entry.size)||entry.size<0||entry.size>5*1024*1024||(total+=entry.size)>20*1024*1024) reject('Canonical manifest file size exceeds limit');
 }
 checkedPaths(value.map(entry=>entry.path));
 return canonicalManifest(value);
}
function scopeValue(workspace) {
 return {profile:workspace.profile,binding:workspace.binding,readPaths:workspace.readPaths,writePaths:workspace.writePaths,
  inputManifest:workspace.inputManifest,outputBaseline:workspace.outputBaseline,baseCanonicalManifest:workspace.baseCanonicalManifest,
  baseCanonicalRevision:workspace.baseCanonicalRevision};
}
function buildWorkspace(binding,readPaths,writePaths,canonical,importedFiles,origins) {
 const paths=[...new Set([...readPaths,...writePaths,...canonical.map(entry=>entry.path)])];
 checkedPaths(paths);
 const baseline=new Map(canonical.map(entry=>[entry.path,entry]));
 for(const path of readPaths) if(!baseline.has(path)) reject('Authorized input is absent from canonical baseline');
 for(const path of writePaths) if(baseline.has(path)&&!readPaths.includes(path)) reject('Existing output requires read authorization and origin');
 const importedManifest=manifest(importedFiles);
 if(!isDeepStrictEqual(importedManifest.map(entry=>entry.path),readPaths)) reject('Imported files do not match authorized reads');
 for(const entry of importedManifest) if(!isDeepStrictEqual(entry,baseline.get(entry.path))) reject('Imported file does not match canonical baseline');
 const workspace={profile:PROFILE,binding,readPaths,writePaths,importedFiles,
  inputManifest:importedManifest.map((entry,index)=>({...entry,origin:origins[index]})),
  outputBaseline:writePaths.map(path=>({path,sha256:baseline.get(path)?.sha256??null})),
  baseCanonicalManifest:canonical,baseCanonicalRevision:hash(JSON.stringify(canonical))};
 return {...workspace,scopeHash:hash(JSON.stringify(scopeValue(workspace)))};
}

// Only a trusted service may choose the binding and paths from an approved task.
// This digest detects inconsistent data; it authenticates neither caller nor scope.
function createTaskWorkspace(options) {
 record(options,['binding','readPaths','writePaths','canonicalFiles','origins']);
 const binding=checkedBinding(options.binding),readPaths=checkedPaths(options.readPaths),writePaths=checkedPaths(options.writePaths);
 const files=checkedFiles(options.canonicalFiles),origins=checkedOrigins(options.origins,readPaths);
 const wanted=new Set(readPaths);
 return buildWorkspace(binding,readPaths,writePaths,manifest(files),files.filter(entry=>wanted.has(entry.path)),origins);
}
function checkedWorkspace(value) {
 record(value,['profile','binding','readPaths','writePaths','importedFiles','inputManifest','outputBaseline','baseCanonicalManifest','baseCanonicalRevision','scopeHash']);
 if(value.profile!==PROFILE) reject('Unsupported task workspace profile');
 const binding=checkedBinding(value.binding),readPaths=checkedPaths(value.readPaths),writePaths=checkedPaths(value.writePaths);
 const canonical=checkedManifest(value.baseCanonicalManifest),files=checkedFiles(value.importedFiles);
 digest(value.baseCanonicalRevision);digest(value.scopeHash);
 if(!Array.isArray(value.inputManifest)||!Array.isArray(value.outputBaseline)) reject('Invalid task workspace manifests');
 for(const entry of value.inputManifest) {record(entry,['path','size','sha256','origin']);digest(entry.sha256);}
 for(const entry of value.outputBaseline) {record(entry,['path','sha256']);if(entry.sha256!==null) digest(entry.sha256);}
 const origins=checkedOrigins(value.inputManifest.map(entry=>entry.origin),readPaths);
 const rebuilt=buildWorkspace(binding,readPaths,writePaths,canonical,files,origins);
 if(!isDeepStrictEqual(value,rebuilt)) reject('Task workspace was changed or is inconsistent');
 return rebuilt;
}
function exportDelta(workspace,exportedFiles) {
 const files=checkedFiles(exportedFiles),after=new Map(manifest(files).map(entry=>[entry.path,entry]));
 const imported=new Map(workspace.inputManifest.map(entry=>[entry.path,entry]));
 const outputs=new Map(workspace.outputBaseline.map(entry=>[entry.path,entry.sha256]));
 for(const entry of workspace.inputManifest) {
  const actual=after.get(entry.path);
  if(!actual) reject('Imported files cannot be deleted');
  if(!outputs.has(entry.path)&&(actual.sha256!==entry.sha256||actual.size!==entry.size)) reject('Read-only input was modified');
 }
 for(const entry of files) if(!imported.has(entry.path)&&!outputs.has(entry.path)) reject('Undeclared exported file');
 return files.filter(entry=>outputs.has(entry.path)&&outputs.get(entry.path)!==after.get(entry.path).sha256).map(entry=>({
  path:entry.path,beforeSha256:outputs.get(entry.path),afterSha256:after.get(entry.path).sha256,size:after.get(entry.path).size,content:entry.content}));
}
function validateTaskExport(workspace,exportedFiles) {
 return exportDelta(checkedWorkspace(workspace),exportedFiles);
}
function planTaskMerge(workspace,exportedFiles,currentCanonicalFiles) {
 const scope=checkedWorkspace(workspace),delta=exportDelta(scope,exportedFiles),current=checkedFiles(currentCanonicalFiles);
 const beforeRevision=revision(current),currentManifest=new Map(manifest(current).map(entry=>[entry.path,entry]));
 if(beforeRevision!==scope.baseCanonicalRevision) reject('Canonical revision changed','TASK_WORKSPACE_CONFLICT');
 for(const entry of scope.outputBaseline) if((currentManifest.get(entry.path)?.sha256??null)!==entry.sha256) reject('Output baseline changed','TASK_WORKSPACE_CONFLICT');
 const merged=new Map(current.map(entry=>[entry.path,entry]));
 for(const entry of delta) merged.set(entry.path,{path:entry.path,content:entry.content});
 const mergedFiles=checkedFiles([...merged.values()]);
 return {mergedFiles,beforeRevision,afterRevision:revision(mergedFiles),scopeHash:scope.scopeHash,delta};
}

module.exports={createTaskWorkspace,validateTaskExport,planTaskMerge};
