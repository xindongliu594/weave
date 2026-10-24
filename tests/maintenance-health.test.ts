import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import express from 'express';
import {buildHealthReport, MAX_REPORT_BYTES} from '../scripts/maintenance/health.mjs';
import {storageRouter} from '../apps/api/src/storage-governance.ts';
const modulePath='../apps/api/src/maintenance-health.ts';
const module:any=await import(modulePath).catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
const now=Date.parse('2026-10-24T01:00:00.000Z');
const report=(time=now,freeBytes=1024**3)=>buildHealthReport({now:time,storage:{present:true,bytes:17,files:1,entries:1,links:0,complete:true},disk:{freeBytes}});
const read=(directory?:string,time=now)=>{assert.equal(typeof module.readMaintenanceHealth,'function');return module.readMaintenanceHealth(directory,time);};
function directory(t:any){const root=fs.mkdtempSync(join(tmpdir(),'weiwu-maintenance-api-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function slot(root:string,index:number,value:unknown){fs.writeFileSync(join(root,`report-${index}.json`),JSON.stringify(value));}

test('unconfigured and missing maintenance reports remain unknown without creating directories',t=>{
 const root=directory(t),missing=join(root,'absent');
 for(const path of [undefined,missing,'relative','https://example.invalid/reports','//server/share/reports','\\\\server\\share\\reports']){
  const value=read(path);assert.equal(value.currentStatus,'unknown');assert.equal(value.availability,'unavailable');assert.equal(value.report,undefined);
 }
 assert.deepEqual(fs.readdirSync(root),[]);
});

test('one fresh report projects only bounded historical statistics without claiming current health',t=>{
 const root=directory(t),value:any=report(now-3600000);value.secret='PRIVATE SOURCE';value.checks.storage.path='PRIVATE SOURCE';value.checks.backup.code='PRIVATE_SOURCE';slot(root,0,value);
 const result=read(root);assert.equal(result.currentStatus,'unknown');assert.equal(result.availability,'available');assert.equal(result.report.checkedAt,value.checkedAt);
 assert.equal(result.report.checks.storage.bytes,17);assert.equal(result.report.status,'unknown');assert.deepEqual(result.slots.map((s:any)=>s.state),['available','missing']);
 const text=JSON.stringify(result);assert.ok(text.length<4096);assert.ok(!text.includes('PRIVATE'));assert.ok(!text.includes(root));assert.ok(!text.includes('sha256'));assert.equal(result.maxAgeHours,48);
});

test('the newest valid slot retains recorded failure and rejects inconsistent success claims',t=>{
 const root=directory(t);slot(root,0,report(now-1000));slot(root,1,report(now,1));
 let result=read(root);assert.equal(result.report.status,'failed');assert.equal(result.report.checks.disk.status,'failed');assert.equal(result.currentStatus,'unknown');
 slot(root,1,{...report(now),status:'passed'});result=read(root);assert.equal(result.availability,'degraded');assert.equal(result.report.checkedAt,new Date(now-1000).toISOString());assert.equal(result.slots[1].state,'invalid');
});

test('malformed oversized missing-shape and linked reports cannot become available or leak content',t=>{
 const root=directory(t),path=join(root,'report-0.json');
 for(const value of ['PRIVATE malformed',JSON.stringify({private:'X'.repeat(MAX_REPORT_BYTES+1)}),JSON.stringify({format:'weiwu-maintenance-health-v1',scope:'offline-read-only',checkedAt:new Date(now).toISOString(),status:'passed'})]){
  fs.writeFileSync(path,value);const result=read(root);assert.equal(result.availability,'unavailable');assert.equal(result.slots[0].state,'invalid');assert.equal(result.report,undefined);assert.ok(!JSON.stringify(result).includes('PRIVATE'));assert.equal(fs.readFileSync(path,'utf8'),value);
 }
 fs.unlinkSync(path);slot(root,0,report());fs.linkSync(path,join(root,'hardlink.json'));assert.equal(read(root).slots[0].state,'invalid');
});

test('future stale and invalid timestamps remain unknown with an exact 48-hour freshness boundary',t=>{
 const root=directory(t);
 for(const [offset,state] of [[1,'future'],[-48*3600000-1,'stale']] as const){slot(root,0,report(now+offset));const result=read(root);assert.equal(result.currentStatus,'unknown');assert.equal(result.report,undefined);assert.equal(result.slots[0].state,state);}
 slot(root,0,report(now-48*3600000));assert.equal(read(root).availability,'available');
 slot(root,0,{...report(),checkedAt:'PRIVATE BAD TIME'});assert.equal(read(root).slots[0].state,'invalid');
});

test('a corrupt companion slot degrades an otherwise valid report and extra files are ignored',t=>{
 const root=directory(t);slot(root,0,report());fs.writeFileSync(join(root,'report-1.json'),'PRIVATE corrupt');slot(root,99,report(now+1));
 const result=read(root);assert.equal(result.availability,'degraded');assert.equal(result.code,'REPORT_DEGRADED');assert.equal(result.report.status,'unknown');assert.equal(result.slots.length,2);assert.equal(result.slots[1].state,'invalid');
});

test('linked report directories are rejected even if their fixed slots are valid',t=>{
 const root=directory(t),target=join(root,'target'),alias=join(root,'alias');fs.mkdirSync(target);slot(target,0,report());
 try{fs.symlinkSync(target,alias,process.platform==='win32'?'junction':'dir');}catch(error:any){if(error.code==='EPERM')return t.skip('symlink privilege unavailable');throw error;}
 const result=read(alias);assert.equal(result.availability,'unavailable');assert.equal(result.report,undefined);assert.equal(result.currentStatus,'unknown');
});

test('the maintenance GET only reads fixed report slots, never scans or writes, and rejects query paths',async t=>{
 const root=directory(t);slot(root,0,report(Date.now()));fs.writeFileSync(join(root,'unrelated.txt'),'PRIVATE CONTENT');
 const before=fs.readdirSync(root).map(name=>({name,content:fs.readFileSync(join(root,name),'utf8'),mtime:fs.statSync(join(root,name)).mtimeMs}));
 let databaseCalls=0;const db={query(){databaseCalls++;throw Error('database forbidden');},connect(){databaseCalls++;throw Error('database forbidden');}};
 const app=express();app.use('/api',storageRouter(join(root,'not-a-trace-root'),{maintenanceReportDir:root} as any,db as any));
 app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status??500).json({code:error.code??'ERROR'}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
 const base='http://127.0.0.1:'+(server.address() as any).port;
 const scan=mock.method(fs,'readdirSync',()=>{throw Error('directory scan forbidden');});syncBuiltinESMExports();
 try{
  const response=await fetch(base+'/api/storage/maintenance');assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  const body=await response.json();assert.equal(body.availability,'available');assert.ok(!JSON.stringify(body).includes(root));assert.equal(databaseCalls,0);
  assert.equal((await fetch(base+'/api/storage/maintenance?path=PRIVATE')).status,422);
 }finally{scan.mock.restore();syncBuiltinESMExports();}
 assert.deepEqual(fs.readdirSync(root).map(name=>({name,content:fs.readFileSync(join(root,name),'utf8'),mtime:fs.statSync(join(root,name)).mtimeMs})),before);
});
