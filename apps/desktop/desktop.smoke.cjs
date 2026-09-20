const { _electron: electron } = require('playwright');
const { createServer } = require('node:http');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
(async()=>{
 const profile=await mkdtemp(path.join(tmpdir(),'department-desktop-'));
 const server=createServer((req,res)=>{if(req.headers.authorization!=='Basic '+Buffer.from('fixture:fixture-password').toString('base64')){res.writeHead(401,{'WWW-Authenticate':'Basic realm="fixture"'});return res.end();}res.writeHead(200,{'Content-Type':'text/html'});res.end('<h1>Desktop connected</h1><a href="/outside">Outside</a>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let client;
 try{
  client=await electron.launch({...(process.env.DESKTOP_EXECUTABLE?{executablePath:process.env.DESKTOP_EXECUTABLE}:{}),args:[...(process.env.DESKTOP_EXECUTABLE?[]:[__dirname]),'--user-data-dir='+profile],timeout:25000});
  const settings=await client.firstWindow();await settings.locator('#server').fill('http://127.0.0.1:'+server.address().port+'/workspace/');await settings.locator('#username').fill('fixture');await settings.locator('#password').fill('fixture-password');await settings.locator('#remember').uncheck();
  const next=client.waitForEvent('window');await settings.locator('button').click();let page=await next;await page.locator('h1').waitFor();assert.equal(await page.locator('h1').textContent(),'Desktop connected');
  assert.equal(await page.evaluate(()=>typeof window.require),'undefined');assert.equal(await page.evaluate(()=>typeof window.departmentConnection),'undefined');
  const prefs=await client.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());assert.equal(prefs.sandbox,true);assert.equal(prefs.contextIsolation,true);assert.equal(prefs.nodeIntegration,false);
  await page.locator('a').click({noWaitAfter:true});assert.match(page.url(),/\/workspace\/$/);
  const replacement=client.waitForEvent('window');await client.evaluate(({Menu})=>Menu.getApplicationMenu().items.find(i=>i.label==='工作空间').submenu.items.find(i=>i.label==='重新连接').click());page=await replacement;await page.locator('h1').waitFor();assert.equal(await page.locator('h1').textContent(),'Desktop connected');
  console.log('Desktop smoke passed: login, remote render, isolation, navigation guard, reconnect.');
 }finally{await client?.close();await new Promise(r=>server.close(r));await rm(profile,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
