// Serialized into the trusted OpenShell transport. No plugin code is imported
// by the device daemon; only the isolated child loads native DSH definitions.
async function runNativeTool({root,tempRoot,bundle,originalName,args,callId,readPaths,writePaths},{signal,checkStorage=()=>{}}={}) {
 const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto'),{gunzipSync}=require('node:zlib'),{spawn}=require('node:child_process');
 const fail=(message)=>Object.assign(Error(message),{notExecuted:true});
 const hash=value=>createHash('sha256').update(value).digest('hex');
 const file=value=>{
  if(typeof value!=='string'||!value||value.length>240||/[\\:*?\0]/.test(value)||value.startsWith('/')||value.split('/').some(p=>!p||p==='.'||p==='..'))throw fail('NATIVE_PATH_DENIED');
  let at=root;const parts=value.split('/');for(let index=0;index<parts.length;index++){at=path.join(at,parts[index]);try{const stat=fs.lstatSync(at);if(stat.isSymbolicLink()||stat.isFile()&&stat.nlink!==1||index===parts.length-1&&!stat.isFile())throw fail('NATIVE_PATH_DENIED');}catch(error){if(error.code!=='ENOENT')throw error;}}return at;
 };
 if(!Array.isArray(readPaths)||!Array.isArray(writePaths)||readPaths.length>128||writePaths.length>128||typeof bundle?.compressed!=='string'||bundle.compressed.length>6*1024*1024||typeof bundle.metadata!=='string'||bundle.metadata.length>24000)throw fail('NATIVE_BUNDLE_INVALID');
 readPaths.forEach(file);writePaths.forEach(file);
 const compressed=Buffer.from(bundle.compressed,'base64'),metadata=Buffer.from(bundle.metadata,'base64');
 if(hash(compressed)!==bundle.sha256||hash(metadata)!==bundle.metadataSha256)throw fail('NATIVE_BUNDLE_MISMATCH');
 const code=gunzipSync(compressed,{maxOutputLength:24*1024*1024});
 if(hash(code)!==bundle.codeSha256)throw fail('NATIVE_BUNDLE_MISMATCH');
 signal?.throwIfAborted();checkStorage();
 // Fresh staging plus serialized sandbox operations prevents stale bundles.
 // The worker cannot write here, spawn children, addons or workers. OpenShell
 // supplies network and process isolation; Node permission alone is not it.
 const staging=fs.mkdtempSync(path.join(tempRoot,'weiwu-native-'));
 try{
  fs.mkdirSync(path.join(staging,'lib'));fs.writeFileSync(path.join(staging,'lib/runner.mjs'),code,{flag:'wx'});fs.writeFileSync(path.join(staging,'package.json'),metadata,{flag:'wx'});
  const workspace=path.join(staging,'work');fs.mkdirSync(workspace);
  const allowed=new Set([...readPaths,...writePaths]),outputSet=new Set(writePaths),before=new Map();let inputBytes=0;
  for(const relative of allowed){const source=file(relative),target=path.join(workspace,relative);fs.mkdirSync(path.dirname(target),{recursive:true});if(fs.existsSync(source)){const stat=fs.statSync(source);inputBytes+=stat.size;if(inputBytes>20*1024*1024)throw fail('NATIVE_STORAGE_LIMIT');const bytes=fs.readFileSync(source);before.set(relative,hash(bytes));fs.writeFileSync(target,bytes,{flag:'wx'});}}
  // Libraries may mkdir destination parents. Give them a private copy of only
  // admitted files, never write access to the shared project workspace.
  const argv=['--permission',`--allow-fs-read=${path.join(staging,'lib')}`,`--allow-fs-read=${path.join(staging,'package.json')}`,`--allow-fs-read=${workspace}`];
  if(writePaths.length)argv.push('--allow-fs-write='+workspace);
  argv.push(path.join(staging,'lib/runner.mjs'));
  const result=await new Promise((resolve,reject)=>{
   const env=Object.fromEntries(['SystemRoot','WINDIR','PATH','LANG'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
   const child=spawn(process.execPath,argv,{cwd:workspace,env,stdio:['pipe','pipe','pipe'],windowsHide:true,detached:process.platform!=='win32'});
   let chunks=[],bytes=0,stderrBytes=0,spawned=false,failure,settled=false;
   const kill=()=>{try{if(process.platform==='win32')child.kill('SIGKILL');else process.kill(-child.pid,'SIGKILL');}catch{}};
   const stop=error=>{failure??=error;kill();};
   const abort=()=>stop(Object.assign(Error('NATIVE_OUTCOME_UNKNOWN: 插件调用中断，请核对原操作'),{notExecuted:!spawned}));
   const timer=setTimeout(abort,60000),monitor=setInterval(()=>{try{checkStorage();}catch(error){stop(Object.assign(error,{notExecuted:!spawned}));}},250);
   const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);clearInterval(monitor);signal?.removeEventListener('abort',abort);kill();error?reject(error):resolve(value);};
   signal?.addEventListener('abort',abort,{once:true});
   child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>1024*1024)stop(Object.assign(Error('NATIVE_OUTPUT_LIMIT'),{notExecuted:false}));else chunks.push(chunk);});
   child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stderrBytes>1024*1024)stop(Object.assign(Error('NATIVE_OUTPUT_LIMIT'),{notExecuted:false}));});
   child.stdin.on('error',()=>{});
   child.once('spawn',()=>{spawned=true;if(signal?.aborted)abort();else child.stdin.end(JSON.stringify({name:originalName,arguments:args,callId}));});
   child.once('error',error=>finish(Object.assign(error,{notExecuted:!spawned})));
   child.once('close',code=>{
    if(failure)return finish(failure);
    if(code!==0)return finish(Object.assign(Error('NATIVE_WORKER_FAILED: 插件进程退出，工作区结果需核对'),{notExecuted:false}));
    try{const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(typeof result.isError!=='boolean')throw Error();finish(null,result);}
    catch{finish(Object.assign(Error('NATIVE_RECEIPT_INVALID: 插件未返回完整原生回执'),{notExecuted:false}));}
   });
  });
  signal?.throwIfAborted();checkStorage();
  if(result.isError)return result;
  const pending=[],seen=new Set();let total=0,count=0;
  const inspect=(directory,prefix='')=>{for(const entry of fs.readdirSync(directory)){if(++count>4096)throw Error('NATIVE_STORAGE_LIMIT');const relative=prefix+entry,absolute=path.join(directory,entry),stat=fs.lstatSync(absolute);if(stat.isSymbolicLink())throw Error('NATIVE_PATH_DENIED');if(stat.isDirectory()){if(relative.split('/').length>32)throw Error('NATIVE_STORAGE_LIMIT');inspect(absolute,relative+'/');continue;}if(!stat.isFile()||stat.nlink!==1||!allowed.has(relative))throw Error('NATIVE_UNDECLARED_FILE');total+=stat.size;if(total>20*1024*1024)throw Error('NATIVE_STORAGE_LIMIT');const bytes=fs.readFileSync(absolute);seen.add(relative);if(outputSet.has(relative))pending.push({relative,bytes});else if(hash(bytes)!==before.get(relative))throw Error('NATIVE_INPUT_CHANGED');}};
  inspect(workspace);
  for(const relative of before.keys())if(!outputSet.has(relative)&&!seen.has(relative))throw Error('NATIVE_INPUT_CHANGED');
  // Validate all copied results before publishing any file. The existing
  // operation journal and handoff seal handle interruption during publication.
  for(const output of pending)file(output.relative);
  for(const {relative,bytes} of pending){const destination=file(relative);fs.mkdirSync(path.dirname(destination),{recursive:true});const temporary=path.join(path.dirname(destination),'.native-'+require('node:crypto').randomUUID());try{fs.writeFileSync(temporary,bytes,{flag:'wx'});fs.renameSync(temporary,destination);}finally{fs.rmSync(temporary,{force:true});}}
  return result;
 }finally{fs.rmSync(staging,{recursive:true,force:true});}
}
module.exports={runNativeTool};
