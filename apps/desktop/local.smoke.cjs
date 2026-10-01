const {_electron:electron}=require('playwright');
const {createServer}=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {tmpdir}=require('node:os');
const {randomUUID}=require('node:crypto');
const assert=require('node:assert/strict');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(read,accept,label){for(let i=0;i<300;i++){const value=await read();if(accept(value))return value;await pause(100);}throw Error('Timed out: '+label);}

// Real Electron main/preload, OS encrypted storage, file writes and native
// processes. The local HTTP coordinator and directory picker are fixed fixtures.
(async()=>{
 const fixture=fs.mkdtempSync(path.join(tmpdir(),'department-desktop-local-'));
 const profile=path.join(fixture,'profile'),root=path.join(fixture,'workspaces');fs.mkdirSync(root);
 const runId=randomUUID(),jobs=[],receipts=new Map();let device,starts=0,client;
 const server=createServer(async(req,res)=>{
  if(req.headers.authorization!=='Basic '+Buffer.from('fixture:fixture-password').toString('base64')){res.writeHead(401,{'WWW-Authenticate':'Basic realm="fixture"'});return res.end();}
  if(!req.url.startsWith('/workspace/api/local-devices/')){res.writeHead(200,{'Content-Type':'text/html'});return res.end('<h1>Local fixture workspace</h1>');}
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw),endpoint=req.url.split('/local-devices/')[1];let reply={ok:true};
  if(endpoint==='register'){device=body;assert.equal(body.platform,process.platform);assert.equal(body.grant.label,path.basename(root));assert.equal(body.grant.allowCommands,true);}
  else{
   assert.equal(req.headers['x-local-device-key'],device.token);
   if(endpoint.endsWith('/poll')){
    if(body.active)reply={cancel:false};
    else{const orphan=jobs.find(job=>job.phase==='started'||job.phase==='claimed'),next=jobs.find(job=>!job.phase);if(orphan)reply={orphan:{id:orphan.id,claimToken:orphan.claimToken,started:orphan.phase==='started'}};else if(next){next.phase='claimed';reply={job:next};}else reply={job:null};}
   }else if(endpoint.endsWith('/start')){const job=jobs.find(job=>endpoint.includes(job.id));assert.equal(job.phase,'claimed');assert.equal(body.claimToken,job.claimToken);job.phase='started';starts++;}
   else if(endpoint.endsWith('/result')){const job=jobs.find(job=>endpoint.includes(job.id));assert.equal(body.claimToken,job.claimToken);receipts.set(job.id,body);job.phase='done';}
   else if(endpoint.endsWith('/disable'))device.disabled=true;
   else throw Error('Unexpected fixture endpoint '+endpoint);
  }
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(reply));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const launch=()=>electron.launch({env:{...process.env,AGENT_DESKTOP_TEST_HIDDEN:'1',AGENT_DESKTOP_TEST_PROFILE:profile},...(process.env.DESKTOP_EXECUTABLE?{executablePath:process.env.DESKTOP_EXECUTABLE}:{}),args:[...(process.env.DESKTOP_EXECUTABLE?[]:[__dirname]),'--user-data-dir='+profile],timeout:25000});
 const openSettings=async()=>{const next=client.waitForEvent('window');await client.evaluate(({Menu})=>Menu.getApplicationMenu().items.find(i=>i.label==='工作空间').submenu.items.find(i=>i.label==='本机执行设置').click());return next;};
 const enqueue=(name,args={},files)=>{const job={id:randomUUID(),runId,grantId:device.grant.id,deviceId:device.id,name,arguments:args,claimToken:randomUUID(),...(files?{files}:{}),...(name.startsWith('terminal')?{approvalId:randomUUID()}: {})};jobs.push(job);return job;};
 try{
  client=await launch();let settings=await client.firstWindow();await settings.locator('#server').fill('http://127.0.0.1:'+server.address().port+'/workspace/');await settings.locator('#username').fill('fixture');await settings.locator('#password').fill('fixture-password');await settings.locator('#remember').check();
  const remote=client.waitForEvent('window');await settings.locator('#connect').click();const page=await remote;await page.locator('h1').waitFor();assert.equal(await page.evaluate(()=>typeof window.localExecution),'undefined');
  await client.evaluate(({dialog},directory)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[directory]});},root);
  settings=await openSettings();await settings.locator('#choose-root').click();await settings.locator('#local-root').filter({hasText:root}).waitFor();await settings.locator('#allow-commands').check();await settings.locator('#device-name').fill('Native desktop fixture');await settings.locator('#enable-local').click();await until(()=>device,Boolean,'device registration');
  const saved=JSON.parse(fs.readFileSync(path.join(profile,'local-device.json'),'utf8'));assert.equal(saved.token,undefined);assert.equal(JSON.stringify(saved).includes(device.token),false);assert.ok(saved.secret);assert.equal(await client.evaluate(({safeStorage},secret)=>safeStorage.decryptString(Buffer.from(secret,'base64')).length,saved.secret),64);
  const prepare=enqueue('prepare',{},[]);await until(()=>receipts.get(prepare.id),value=>value?.ok,'real workspace initialization');
  const written=enqueue('artifact_write',{path:'report.json',content:'{"accepted":true}'});await until(()=>receipts.get(written.id),value=>value?.ok,'real file write');assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,runId,'report.json'),'utf8')),{accepted:true});
  const command=enqueue('terminal_test',{command:'node -e "require(\'node:assert/strict\').equal(require(\'./report.json\').accepted,true);console.log(\'native desktop verified\')"'});
  const verified=await until(()=>receipts.get(command.id),value=>value?.ok,'native approved command');assert.equal(verified.result.exitCode,0);assert.match(verified.result.output,/native desktop verified/);assert.equal(verified.result.localWorkspace,path.join(root,runId));
  const long=enqueue('terminal_test',{command:'node -e "require(\'fs\').appendFileSync(\'started.txt\',\'x\');setTimeout(()=>require(\'fs\').writeFileSync(\'late.txt\',\'unexpected\'),30000)"'});const marker=path.join(root,runId,'started.txt');await until(()=>fs.existsSync(marker),Boolean,'in-flight native command');
  await client.close();client=null;client=await launch();await (await client.firstWindow()).locator('h1').waitFor();
  const interrupted=await until(()=>receipts.get(long.id),Boolean,'durable interrupted receipt after restart');assert.equal(interrupted.ok,false);assert.equal(interrupted.error.notExecuted,false);assert.equal(fs.readFileSync(marker,'utf8'),'x');assert.equal(starts,4);assert.equal(fs.existsSync(path.join(root,runId,'late.txt')),false);
  settings=await openSettings();await settings.locator('#disable-local').click();await until(()=>device.disabled,Boolean,'device revocation');assert.equal(JSON.parse(fs.readFileSync(path.join(profile,'local-device.json'),'utf8')).enabled,false);
  const forbidden=enqueue('artifact_write',{path:'after-disable.txt',content:'unexpected'});await pause(1300);assert.equal(forbidden.phase,undefined);assert.equal(fs.existsSync(path.join(root,runId,'after-disable.txt')),false);
  console.log('Native desktop smoke passed: grant selection, encrypted pairing, real files/commands, quit cancellation, restart without replay and revocation.');
 }finally{await client?.close();await new Promise(r=>server.close(r));assert.ok(path.resolve(fixture).startsWith(path.resolve(tmpdir())+path.sep+'department-desktop-local-'));fs.rmSync(fixture,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
