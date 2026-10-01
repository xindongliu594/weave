const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {LocalExecutor}=require('./local-executor.cjs');
const {normalizeServer}=require('./connection.cjs');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
class LocalDeviceClient {
 constructor({connection,device,journalRoot,fetch:request=globalThis.fetch,onState=()=>{},pollMs=1000}){
  if(!/^[a-f0-9-]{36}$/.test(device?.id)||!/^[a-f0-9]{64}$/.test(device?.token))throw Error('本机设备凭证不正确');
  this.connection={...connection,server:normalizeServer(connection.server)};this.device=device;this.journalRoot=journalRoot;this.request=request;this.onState=onState;this.pollMs=pollMs;
  this.executor=new LocalExecutor(device.grant);this.controller=new AbortController();this.pending=new Map();this.active=null;this.stopped=false;
  fs.mkdirSync(journalRoot,{recursive:true,mode:0o700});if(fs.lstatSync(journalRoot).isSymbolicLink())throw Error('本机回执目录不能是链接');
 }
 record(id,value){
  if(!/^[a-f0-9-]{36}$/.test(id))throw Error('本机操作编号不正确');
  const file=path.join(this.journalRoot,id+'.json'),temporary=file+'.'+randomUUID();
  if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw Error('本机回执文件不能是链接');
  fs.writeFileSync(temporary,JSON.stringify(value),{flag:'wx',mode:0o600});fs.renameSync(temporary,file);
 }
 read(id){const file=path.join(this.journalRoot,id+'.json');if(!fs.existsSync(file))return null;if(fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).size>32*1024*1024)throw Error('本机回执格式不正确');return JSON.parse(fs.readFileSync(file,'utf8'));}
 async api(endpoint,body){
  const response=await this.request(new URL('api/local-devices/'+endpoint,this.connection.server),{method:'POST',redirect:'error',signal:AbortSignal.any([this.controller.signal,AbortSignal.timeout(5000)]),headers:{'Content-Type':'application/json','X-Local-Device-Key':this.device.token,...(this.connection.username?{Authorization:'Basic '+Buffer.from(this.connection.username+':'+this.connection.password).toString('base64')}:{})},body:JSON.stringify(body)});
  const data=await response.json();if(!response.ok)throw Object.assign(Error(data.message||'本机设备连接失败'),{code:data.code,status:response.status});return data;
 }
 async start(){
  await this.api('register',{id:this.device.id,token:this.device.token,name:this.device.name,platform:process.platform,grant:{id:this.device.grant.id,label:path.basename(this.device.grant.root),allowCommands:!!this.device.grant.allowCommands}});
  for(const name of fs.readdirSync(this.journalRoot)){if(/^[a-f0-9-]{36}\.json$/.test(name)){const id=name.slice(0,-5),previous=this.read(id);if(previous?.phase==='completed'&&previous.receipt)this.pending.set(id,previous.receipt);if(this.pending.size>=4)break;}}
  this.onState({status:'connected'});this.loop=this.poll();return this;
 }
 async deliver(id,receipt){
  await this.api(this.device.id+'/operations/'+id+'/result',receipt);
  this.record(id,{phase:'acknowledged',claimToken:receipt.claimToken});this.pending.delete(id);
 }
 run(job){
  const previous=this.read(job.id);
  if(previous?.phase==='acknowledged')return;
  if(previous){this.pending.set(job.id,previous.receipt??{claimToken:job.claimToken,ok:false,error:{code:'LOCAL_OUTCOME_UNKNOWN',message:'本机已有此操作记录，拒绝重复执行',notExecuted:previous.phase==='claimed'}});return;}
  const controller=new AbortController(),signal=AbortSignal.any([this.controller.signal,controller.signal]);
  const active={id:job.id,claimToken:job.claimToken,controller};this.active=active;
  active.promise=(async()=>{
   let executing=false,receipt;
   try{
    this.record(job.id,{phase:'claimed',claimToken:job.claimToken,runId:job.runId});
    this.record(job.id,{phase:'starting',claimToken:job.claimToken,runId:job.runId});
    await this.api(this.device.id+'/operations/'+job.id+'/start',{claimToken:job.claimToken});signal.throwIfAborted();
    this.record(job.id,{phase:'executing',claimToken:job.claimToken,runId:job.runId});executing=true;
    const result=await this.executor.execute(job,signal);receipt={claimToken:job.claimToken,ok:true,result};
   }catch(error){receipt={claimToken:job.claimToken,ok:false,error:{code:error.code??'LOCAL_OPERATION_FAILED',message:String(error.message).slice(0,500),notExecuted:!executing||!!error.notExecuted}};}
   this.record(job.id,{phase:'completed',claimToken:job.claimToken,runId:job.runId,receipt});this.pending.set(job.id,receipt);
   try{if(!this.stopped)await this.deliver(job.id,receipt);}catch{}
  })().catch(error=>{this.stopped=true;this.controller.abort(error);this.onState({status:'offline',message:'本机回执无法持久保存：'+error.message});}).finally(()=>{if(this.active===active)this.active=null;});
 }
 async poll(){
  while(!this.stopped){
   try{
    for(const [id,receipt] of this.pending)await this.deliver(id,receipt);
    const reply=await this.api(this.device.id+'/poll',{active:this.active?{id:this.active.id,claimToken:this.active.claimToken}:null});
    if(reply.cancel)this.active?.controller.abort(Error('服务端取消或设备授权失效'));
    if(reply.orphan&&!this.active){
     const previous=this.read(reply.orphan.id),receipt=previous?.receipt??{claimToken:reply.orphan.claimToken,ok:false,error:{code:'LOCAL_OUTCOME_UNKNOWN',message:'桌面进程中断，操作不自动重放，请核对本机工作区',notExecuted:!reply.orphan.started&&(!previous||previous.phase==='claimed')}};
     this.record(reply.orphan.id,{phase:'completed',receipt});this.pending.set(reply.orphan.id,receipt);
    }
    if(reply.job&&!this.active)this.run(reply.job);
    this.onState({status:this.active?'running':'connected',operationId:this.active?.id});
   }catch(error){
    this.active?.controller.abort(Error('设备与后端失去连接'));this.onState({status:'offline',message:error.message});
    if(error.status===403||error.status===401){this.stopped=true;break;}
   }
   if(!this.stopped)await pause(this.pollMs);
  }
 }
 async close(){this.stopped=true;this.controller.abort(Error('本机执行已关闭'));this.active?.controller.abort(Error('本机执行已关闭'));await Promise.allSettled([this.loop,this.active?.promise]);this.onState({status:'disabled'});}
 async disable(){this.stopped=true;this.active?.controller.abort(Error('本机授权已撤回'));try{await this.api(this.device.id+'/disable',{});}catch{}await this.close();}
}
module.exports={LocalDeviceClient};
