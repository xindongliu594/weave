// Engineering-only CLI/UID/cgroup fixture. File/CAS/export and durable journal
// are the production OpenShell executor and REMOTE_SCRIPT; tests run real Node.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events'),{spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {OpenShellDeviceExecutor,OPENSHELL_CONSTANTS,POLICY_TEXT}=require('../../apps/desktop/openshell-executor.cjs');
function executeFixtureScript(script,input,root){
 return new Promise((resolve,reject)=>{
  const stdin=new EventEmitter(),map=value=>typeof value==='string'&&(value==='/sandbox'||value.startsWith('/sandbox/'))?path.join(root,value.slice(8)):typeof value==='string'&&(value==='/tmp'||value.startsWith('/tmp/'))?path.join(root,'..','temporary',value.slice(4)):value;
  const fixtures=new Proxy(fs,{get(target,name){
   if(name==='readFileSync')return(value,...args)=>value==='/sys/fs/cgroup/cpu.max'?'100000 100000\n':value==='/sys/fs/cgroup/memory.max'?'536870912\n':fs.readFileSync(map(value),...args);
   if(['existsSync','lstatSync','statSync','readdirSync','opendirSync','statfsSync','mkdirSync','openSync','unlinkSync'].includes(name))return(value,...args)=>target[name](map(value),...args);
   if(name==='renameSync')return(from,to)=>fs.renameSync(map(from),map(to));
   return typeof target[name]==='function'?target[name].bind(target):target[name];
  }});
  const fixtureSpawn=(_command,args)=>{
   if(args[0]!=='-lc'||!/^node --test check-[abc]\.mjs$/.test(args[1]))throw Error('Unapproved fixture test command');
   const env={...process.env};delete env.NODE_TEST_CONTEXT;
   return spawn(process.execPath,['--permission','--allow-fs-read='+root,'--test-isolation=none','--test',args[1].slice(12)],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  };
  const fakeProcess={stdin,getuid:()=>1000,getgid:()=>1000,version:'v24.19.0',env:{},exit:code=>reject(Error('fixture helper exit '+code)),kill:(_pid,signal)=>{if(signal===0)throw Object.assign(Error('gone'),{code:'ESRCH'});}};
  const context={require:name=>name==='node:fs'?fixtures:name==='node:path'?path.posix:name==='node:child_process'?{spawn:fixtureSpawn}:require(name),process:fakeProcess,Buffer,console:{log:value=>resolve(JSON.parse(value))},setTimeout,clearTimeout,setInterval,clearInterval};
  try{vm.runInNewContext(script,context,{timeout:2000});stdin.emit('data',Buffer.from(input));stdin.emit('end');}catch(error){reject(error);}
 });
}
function createProductDeviceFixture(base,grantId){
 const grant={id:grantId,root:path.join(base,'grant'),allowCommands:true},home=path.join(base,'home');
 for(const dir of [base,grant.root,home,path.join(base,'temporary')])fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const policyPath=path.join(base,'policy.yaml');fs.writeFileSync(policyPath,POLICY_TEXT);
 const config={...OPENSHELL_CONSTANTS,cliPath:path.join(base,'fixture-cli'),home,policyPath};
 const calls=[],sandboxes=new Map(),control={loseAcceptedStop:false},observations=[];
 let executor;
 const transport=async(_cli,args,options)=>{
  const command=args.slice(2),call={index:calls.length,args:[...args],request:options.input?JSON.parse(options.input):undefined,time:new Date().toISOString()};calls.push(call);options.signal?.throwIfAborted();
  if(command[0]==='status'){if(control.onStatus)await control.onStatus(call);return {exitCode:0,stdout:JSON.stringify({status:'connected',version:'0.1.2',gateway:config.gateway,server:'https://127.0.0.1:18770',authentication:{status:'authenticated'}})};}
  if(command[0]==='policy')return {exitCode:0,stdout:JSON.stringify({hash:OPENSHELL_CONSTANTS.effectivePolicyHash,policy:{process:{run_as_user:'1000',run_as_group:'1000'},landlock:{compatibility:'hard_requirement'},network_policies:{},network_middlewares:{}}})};
  const found=[...sandboxes].find(([name])=>name===command[2]),row=found?.[1];
  if(command[1]==='get')return row?{exitCode:0,stdout:JSON.stringify({name:found[0],id:row.id,phase:row.phase,conditions:[{type:'Ready',status:'True'}],configuration_admission:{state:'accepted',policy_hash:OPENSHELL_CONSTANTS.effectivePolicyHash}})}:{exitCode:1,stdout:'',stderr:'sandbox not found'};
  if(command[1]==='delete'){if(!row)return {exitCode:0,stdout:''};sandboxes.delete(found[0]);return {exitCode:0,stdout:''};}
  if(command[1]==='create'){
   const name=command[command.indexOf('--name')+1];if(sandboxes.has(name))throw Error('duplicate create');
   const root=path.join(base,'remote-'+sandboxes.size);fs.mkdirSync(root);sandboxes.set(name,{id:randomUUID(),root,phase:'Ready'});
   observations.push({kind:'create',name,running:[...sandboxes.values()].filter(s=>s.phase==='Ready').length});
   return {exitCode:0,stdout:'{}'};
  }
  if(command[1]==='stop'){
   if(!row)throw Error('stop target absent');row.phase='Stopped';
   const scope=executor.storageScopes().find(scope=>scope.name===found[0]),journal=scope?.key?executor.read(scope.key):undefined;
   if(journal?.acceptedStop){
    observations.push({kind:'accepted-stop',call:call.index,journal:structuredClone(journal)});
    if(control.onAcceptedStop)await control.onAcceptedStop(journal,call);
    if(control.loseAcceptedStop){control.loseAcceptedStop=false;return {exitCode:1,stdout:'',stderr:'response lost after accepted stop'};}
   }
   return {exitCode:0,stdout:''};
  }
  if(command[1]==='start'){if(!row||row.phase!=='Stopped')throw Error('start requires original stopped sandbox');row.phase='Ready';return {exitCode:0,stdout:''};}
  if(command[1]==='exec'){
   const name=command[command.indexOf('--name')+1],target=sandboxes.get(name);if(!target||target.phase!=='Ready')throw Error('exec requires ready original sandbox');
   const receipt=await executeFixtureScript(command.at(-1),options.input,target.root);return {exitCode:0,stdout:JSON.stringify(receipt)};
  }
  throw Error('Unexpected fixture CLI '+JSON.stringify(command));
 };
 const options={grant,config,journalRoot:path.join(base,'journal'),transport};executor=new OpenShellDeviceExecutor(options);
 return {base,grant,config,options,calls,sandboxes,control,observations,get executor(){return executor;},reopen(){executor=new OpenShellDeviceExecutor(options);return executor;}};
}
module.exports={createProductDeviceFixture};
