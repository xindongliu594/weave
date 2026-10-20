const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {randomUUID,randomBytes,createHash}=require('node:crypto');
const {FIXED,readConfig,prepareDevice,prepareApprovedDevice,readDevice}=require('../scripts/local-openshell-bootstrap.cjs');
const {LocalDeviceClient}=require('../apps/desktop/local-client.cjs');
const sha=x=>createHash('sha256').update(x).digest('hex');
// Stubbed transport/cryptography only for local bootstrap regression; no model/CLI/API.
const seal=x=>Buffer.from(x).toString('base64'),unseal=x=>Buffer.from(x,'base64').toString();
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'openshell-bootstrap-'));
 for(const p of ['home','native-workspaces','native-journal'])fs.mkdirSync(path.join(root,p));
 fs.writeFileSync(path.join(root,'device.credential'),'ORIGINAL_NATIVE_BYTES');fs.writeFileSync(path.join(root,'native-journal','retained.json'),'ORIGINAL_HISTORY');
 const cli=path.join(root,'cli'),policy=path.join(root,'policy.yaml');fs.writeFileSync(cli,'SYNTHETIC_CLI_NOT_EXECUTABLE');fs.writeFileSync(policy,'SYNTHETIC_POLICY');
 const expected={...FIXED,cliSha256:sha(fs.readFileSync(cli)),policyHash:sha(fs.readFileSync(policy))};
 const config={version:expected.version,cliPath:cli,cliSha256:expected.cliSha256,home:path.join(root,'home'),gateway:expected.gateway,image:expected.image,policyPath:policy,policyHash:expected.policyHash,cpu:expected.cpu,memory:expected.memory};
 const file=path.join(root,'config.json');fs.writeFileSync(file,JSON.stringify(config));
 return {root,file,config,expected,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}
test('explicit config pins every source/resource and delegates the sole adapter fingerprint',()=>{
 const f=fixture();try{
  const fingerprint=sha('adapter-provided-canonical-fingerprint');let seen;
  const checked=readConfig(f.file,{expected:f.expected,fingerprint:config=>{seen=config;return fingerprint;}});
  assert.deepEqual(seen,f.config);assert.equal(checked.fingerprint,fingerprint);
  assert.throws(()=>readConfig(f.file,{fingerprint:()=>fingerprint}),/配置不匹配/,'production pins cannot accept synthetic binary/hash');
  for(const key of ['version','cliSha256','gateway','image','policyHash','cpu','memory']){
   fs.writeFileSync(f.file,JSON.stringify({...f.config,[key]:'changed'}));assert.throws(()=>readConfig(f.file,{expected:f.expected,fingerprint:()=>fingerprint}),/不匹配/);
  }
 }finally{f.cleanup();}
});
test('CLI/policy bytes and unexpected bootstrap fields cannot bypass source pins',()=>{
 const f=fixture();try{
  const options={expected:f.expected,fingerprint:()=>sha('fingerprint')};
  fs.appendFileSync(f.config.cliPath,'tampered');assert.throws(()=>readConfig(f.file,options),error=>error.code==='OPENSHELL_CLI_CHANGED');
  fs.writeFileSync(f.config.cliPath,'SYNTHETIC_CLI_NOT_EXECUTABLE');fs.appendFileSync(f.config.policyPath,'tampered');assert.throws(()=>readConfig(f.file,options),error=>error.code==='OPENSHELL_POLICY_CHANGED');
  fs.writeFileSync(f.config.policyPath,'SYNTHETIC_POLICY');fs.writeFileSync(f.file,JSON.stringify({...f.config,apiKey:'SYNTHETIC_FORBIDDEN_FIELD'}));assert.throws(()=>readConfig(f.file,options),/未允许/);
 }finally{f.cleanup();}
});
test('new device remains separate, stable on restart, and rejects changed fingerprint even on re-enable',()=>{
 const f=fixture();try{
  const input={root:f.root,config:f.config,fingerprint:sha('same-config'),seal,unseal};
  const first=prepareDevice(input),bytes=fs.readFileSync(first.deviceFile);
  assert.notEqual(first.deviceFile,path.join(f.root,'device.credential'));assert.notEqual(first.journalRoot,path.join(f.root,'native-journal'));
  fs.writeFileSync(path.join(first.journalRoot,'unknown.json'),'UNKNOWN_OPERATION_RETAINED');
  const next=prepareDevice(input);assert.deepEqual(next.device,first.device);assert.ok(fs.readFileSync(first.deviceFile).equals(bytes));
  assert.throws(()=>prepareDevice({...input,fingerprint:sha('changed-config'),reenable:true}),error=>error.code==='OPENSHELL_GRANT_CHANGED');
  assert.ok(fs.readFileSync(first.deviceFile).equals(bytes));assert.equal(fs.readFileSync(path.join(first.journalRoot,'unknown.json'),'utf8'),'UNKNOWN_OPERATION_RETAINED');
  assert.equal(fs.readFileSync(path.join(f.root,'device.credential'),'utf8'),'ORIGINAL_NATIVE_BYTES');assert.equal(fs.readFileSync(path.join(f.root,'native-journal','retained.json'),'utf8'),'ORIGINAL_HISTORY');
 }finally{f.cleanup();}
});
test('explicit same-config re-enable keeps retired credential bytes and operation journal',()=>{
 const f=fixture();try{
  const input={root:f.root,config:f.config,fingerprint:sha('same-config'),seal,unseal};const old=prepareDevice(input),bytes=fs.readFileSync(old.deviceFile);
  fs.writeFileSync(path.join(old.journalRoot,'old-unknown.json'),'RETAINED');
  const fresh=prepareDevice({...input,reenable:true});assert.notEqual(fresh.device.id,old.device.id);assert.notEqual(fresh.device.grant.id,old.device.grant.id);
  const retired=fs.readdirSync(path.dirname(old.deviceFile)).filter(x=>x.startsWith('device.credential.retired-'));
  assert.equal(retired.length,1);assert.ok(fs.readFileSync(path.join(path.dirname(old.deviceFile),retired[0])).equals(bytes));assert.equal(fs.readFileSync(path.join(old.journalRoot,'old-unknown.json'),'utf8'),'RETAINED');
  assert.equal(readDevice(f.root,unseal).id,fresh.device.id);
 }finally{f.cleanup();}
});
test('enterprise bootstrap checks saved approval before any credential rotation',async()=>{
 const f=fixture();try{
  const input={root:f.root,config:f.config,fingerprint:sha('same-config'),seal,unseal};
  const approved=prepareDevice(input),before=fs.readFileSync(approved.deviceFile);
  let checked=false;
  const reused=await prepareApprovedDevice({...input,reenable:true,assertApproved:async device=>{checked=true;assert.equal(device.id,approved.device.id);}});
  assert.equal(checked,true);assert.equal(reused.device.id,approved.device.id);assert.ok(fs.readFileSync(approved.deviceFile).equals(before));
  await assert.rejects(prepareApprovedDevice({...input,reenable:true,assertApproved:async()=>{throw Error('not approved');}}),/not approved/);
  assert.ok(fs.readFileSync(approved.deviceFile).equals(before));
  fs.rmSync(approved.deviceFile);
  await assert.rejects(prepareApprovedDevice({...input,assertApproved:async()=>{throw Error('must not be called');}}),/saved|已保存|管理员/);
  assert.equal(fs.existsSync(approved.deviceFile),false);
 }finally{f.cleanup();}
});
test('configuration symlinks and failed credential replacement preserve the prior grant',()=>{
 const f=fixture();const rename=fs.renameSync;try{
  const alias=path.join(f.root,'home-alias');fs.symlinkSync(f.config.home,alias,process.platform==='win32'?'junction':'dir');
  fs.writeFileSync(f.file,JSON.stringify({...f.config,home:alias}));assert.throws(()=>readConfig(f.file,{expected:f.expected,fingerprint:()=>sha('fingerprint')}),/符号链接/);
  const input={root:f.root,config:f.config,fingerprint:sha('same-config'),seal,unseal},old=prepareDevice(input),bytes=fs.readFileSync(old.deviceFile);
  fs.renameSync=()=>{throw Object.assign(Error('SYNTHETIC_RECEIPT_RENAME_FAILURE'),{code:'EPERM'});};
  assert.throws(()=>prepareDevice({...input,reenable:true}),/SYNTHETIC_RECEIPT_RENAME_FAILURE/);
  assert.ok(fs.readFileSync(old.deviceFile).equals(bytes));assert.equal(readDevice(f.root,unseal).grant.id,old.device.grant.id);
 }finally{fs.renameSync=rename;f.cleanup();}
});
test('explicit adapter receives exact job and backend registration; host executor is never used',async()=>{
 const f=fixture();try{
  const grant={id:randomUUID(),root:path.join(f.root,'native-workspaces'),allowCommands:true},device={id:randomUUID(),token:randomBytes(32).toString('hex'),grant,backend:{kind:'openshell',fingerprint:sha('bound')},name:'Test isolated device'};
  const calls=[];let executions=0,closes=0;const executor={async execute(job){executions++;assert.equal(job.name,'artifact_write');return {path:job.arguments.path,proof:'adapter-execution'};},async close(){closes++;}};
  const client=new LocalDeviceClient({connection:{server:'http://127.0.0.1:12345/'},device,journalRoot:path.join(f.root,'adapter-journal'),executor});
  client.api=async(endpoint,body)=>{calls.push({endpoint,body});return endpoint.endsWith('/poll')?{}:{ok:true};};
  client.poll=async()=>{};await client.start();assert.deepEqual(calls[0].body.backend,device.backend);
  const job={id:randomUUID(),claimToken:randomUUID(),runId:randomUUID(),name:'artifact_write',arguments:{path:'employee.txt',content:'not a host write'}};
  client.run(job);await client.active.promise;assert.equal(executions,1);assert.equal(fs.readdirSync(grant.root).length,0);
  client.run(job);assert.equal(executions,1,'same recorded operation must not replay');
  await Promise.all([client.close(),client.close()]);assert.equal(closes,1);
  assert.throws(()=>new LocalDeviceClient({connection:{server:'http://127.0.0.1:12345/'},device,journalRoot:path.join(f.root,'bad-adapter'),executor:null}),/拒绝回退/);
 }finally{f.cleanup();}
});
