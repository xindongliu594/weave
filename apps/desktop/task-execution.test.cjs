const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {randomUUID,createHash}=require('node:crypto');
const {REMOTE_SCRIPT,MAX_TASK_EXEC_STDIN_BYTES,taskEnvelope}=require('./openshell-executor.cjs');
const sha=value=>createHash('sha256').update(value).digest('hex');

async function remote(root,request,{hardlink=false}={}){
 return new Promise((resolve,reject)=>{
  const stdin=new EventEmitter();const map=value=>typeof value==='string'&&value.startsWith('/sandbox')?path.join(root,'sandbox',value.slice(8)):typeof value==='string'&&value.startsWith('/tmp')?path.join(root,'tmp',value.slice(4)):value;
  const fakeFs=new Proxy(fs,{get(target,key){
   if(key==='readFileSync')return(value,...args)=>value==='/sys/fs/cgroup/cpu.max'?'100000 100000\n':value==='/sys/fs/cgroup/memory.max'?'536870912\n':fs.readFileSync(map(value),...args);
   if(key==='lstatSync')return(value,...args)=>{const stat=fs.lstatSync(map(value),...args);if(hardlink&&value==='/sandbox/out.txt')stat.nlink=2;return stat;};
   if(['lstatSync','statSync','readdirSync','opendirSync','statfsSync','mkdirSync','openSync','unlinkSync'].includes(key))return(value,...args)=>target[key](map(value),...args);
   if(key==='renameSync')return(from,to)=>fs.renameSync(map(from),map(to));
   return typeof target[key]==='function'?target[key].bind(target):target[key];
  }});
  const processMock={stdin,getuid:()=>1000,getgid:()=>1000,version:'v24.19.0',env:{},exit:code=>reject(Error('remote exit '+code))};
  const context={require:key=>key==='node:fs'?fakeFs:key==='node:path'?path.posix:key==='node:child_process'?{spawn:()=>{throw Error('inspection executed a command');}}:require(key),process:processMock,Buffer,console:{log:value=>resolve(JSON.parse(value))},setTimeout,clearTimeout,setInterval,clearInterval};
  try{vm.runInNewContext(REMOTE_SCRIPT,context,{timeout:3000});stdin.emit('data',Buffer.from(request));stdin.emit('end');}catch(error){reject(error);}
 });
}

test('readonly task export inspects the original operation and rejects undeclared files',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'task-export-'));fs.mkdirSync(path.join(root,'sandbox'));fs.mkdirSync(path.join(root,'tmp'));
 try{
  fs.writeFileSync(path.join(root,'sandbox','input.txt'),'approved');fs.writeFileSync(path.join(root,'sandbox','out.txt'),'result');
  const request={nonce:'test',name:'task_export_inspect',profile:'task-attempt-openshell-v1',operationId:randomUUID(),readPaths:['input.txt'],writePaths:['out.txt'],inputManifest:[{path:'input.txt',size:8,sha256:sha('approved')}],expectedStoredRevision:undefined};
  const result=await remote(root,JSON.stringify(request));assert.equal(result.ok,true);assert.equal(result.result.files.length,2);
  fs.writeFileSync(path.join(root,'sandbox','secret.txt'),'secret');
  const rejected=await remote(root,JSON.stringify(request));assert.equal(rejected.ok,false);assert.equal(rejected.error.code,'LOCAL_SCOPE_DENIED');
  fs.unlinkSync(path.join(root,'sandbox','secret.txt'));
  const linked=await remote(root,JSON.stringify(request),{hardlink:true});assert.equal(linked.ok,false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('remote task parser rejects 3 MiB plus one byte before any task mutation',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'task-envelope-'));fs.mkdirSync(path.join(root,'sandbox'));fs.mkdirSync(path.join(root,'tmp'));
 try{
  assert.equal(MAX_TASK_EXEC_STDIN_BYTES,3*1024*1024);
  const body=JSON.stringify({nonce:'test',name:'prepare',profile:'task-attempt-openshell-v1',files:[],arguments:{padding:'x'.repeat(3*1024*1024)}});
  const result=await remote(root,body);assert.equal(result.ok,false);assert.equal(result.error.code,'LOCAL_FILE_LIMIT');assert.deepEqual(fs.readdirSync(path.join(root,'sandbox')),[]);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('serialized task envelope counts UTF-8 bytes at the exact transport limit',()=>{
 const prefix={nonce:'0'.repeat(32),name:'prepare',profile:'task-attempt-openshell-v1',files:[],arguments:{padding:''}};
 const empty=Buffer.byteLength(JSON.stringify(prefix),'utf8'),allowed='x'.repeat(MAX_TASK_EXEC_STDIN_BYTES-empty);
 assert.equal(Buffer.byteLength(taskEnvelope({...prefix,arguments:{padding:allowed}}),'utf8'),MAX_TASK_EXEC_STDIN_BYTES);
 assert.throws(()=>taskEnvelope({...prefix,arguments:{padding:allowed+'x'}}),{code:'LOCAL_FILE_LIMIT',notExecuted:true});
 assert.throws(()=>taskEnvelope({...prefix,arguments:{padding:allowed.slice(0,-2)+'汉'}}),{code:'LOCAL_FILE_LIMIT',notExecuted:true});
});
