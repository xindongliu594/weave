import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createNativeInstallManager,installRequest} from '../apps/api/src/native-plugin-install.ts';
import {nativeCapabilityRouter} from '../apps/api/src/native-capabilities.ts';
import {routePolicies,assertRouteInventory} from '../apps/api/src/api-route-policies.ts';
import express from 'express';

const recipe={namespace:'calculator',package:'@omdsh-dev/dsh-tool-calculator',version:'0.0.1',config:{},files:{calculate:{read:[],write:[]}}};
test('installer accepts only exact public package coordinates and declared file policy',()=>{
 assert.equal(installRequest.parse({kind:'npm',recipe}).kind,'npm');
 for(const pkg of ['git+https://example.com/x','https://example.com/x','../local','foo@latest','foo;echo'])assert.throws(()=>installRequest.parse({kind:'npm',recipe:{...recipe,package:pkg}}));
 for(const v of ['latest','^1.2.0','1.x','file:../x'])assert.throws(()=>installRequest.parse({kind:'npm',recipe:{...recipe,version:v}}));
 assert.throws(()=>installRequest.parse({kind:'npm',recipe:{...recipe,script:'echo foo'}}));
 assert.throws(()=>installRequest.parse({kind:'npm',recipe:{...recipe,files:{calculate:{read:['../secret'],write:[]}}}}));
 assert.throws(()=>installRequest.parse({kind:'npm',recipe:{...recipe,config:{apiKey:'must-not-store'}}}));
});
test('unfinished durable job is marked interrupted on manager restart',()=>{
 const root=mkdtempSync(join(tmpdir(),'native-install-'));
 try{const jobs=join(root,'install-jobs');mkdirSync(jobs);const id='11111111-1111-4111-8111-111111111111';writeFileSync(join(jobs,id+'.json'),JSON.stringify({id,kind:'npm',stage:'building',createdAt:'2026-01-01',updatedAt:'2026-01-01'}));const manager=createNativeInstallManager(root);assert.equal(manager.get(id)?.stage,'interrupted');assert.match(manager.get(id)?.error??'',/中断/);}finally{rmSync(root,{recursive:true,force:true});}
});
test('restart removes only an exactly recorded owned scratch directory',()=>{
 const root=mkdtempSync(join(tmpdir(),'native-install-'));
 try{const jobs=join(root,'install-jobs'),scratch=join(root,'.install-ABC123');mkdirSync(jobs);mkdirSync(scratch);writeFileSync(join(scratch,'cache'),'temporary');const id='22222222-2222-4222-8222-222222222222';writeFileSync(join(jobs,id+'.json'),JSON.stringify({id,kind:'npm',stage:'installing',scratchName:'.install-ABC123',createdAt:'2026-01-01',updatedAt:'2026-01-01'}));const manager=createNativeInstallManager(root);assert.equal(manager.get(id)?.stage,'interrupted');assert.equal(existsSync(scratch),false);assert.equal('scratchName' in (manager.get(id)??{}),false);}finally{rmSync(root,{recursive:true,force:true});}
});
test('restart refuses forged scratch path outside the installation root',()=>{
 const root=mkdtempSync(join(tmpdir(),'native-install-'));
 try{const jobs=join(root,'install-jobs');mkdirSync(jobs);const outside=join(tmpdir(),'native-install-outside-guard');writeFileSync(outside,'keep');const id='33333333-3333-4333-8333-333333333333';writeFileSync(join(jobs,id+'.json'),JSON.stringify({id,kind:'npm',stage:'installing',scratchName:'../native-install-outside-guard',createdAt:'2026-01-01',updatedAt:'2026-01-01'}));const manager=createNativeInstallManager(root);assert.equal(manager.get(id)?.stage,'interrupted');assert.match(manager.get(id)?.error??'',/无法确认/);assert.equal(existsSync(outside),true);rmSync(outside);}finally{rmSync(root,{recursive:true,force:true});}
});
test('restart retains scratch when a recorded npm PID may still be alive',()=>{
 const root=mkdtempSync(join(tmpdir(),'native-install-'));
 try{const jobs=join(root,'install-jobs'),scratch=join(root,'.install-ABC124');mkdirSync(jobs);mkdirSync(scratch);const id='44444444-4444-4444-8444-444444444444';writeFileSync(join(jobs,id+'.json'),JSON.stringify({id,kind:'npm',stage:'installing',scratchName:'.install-ABC124',childPid:process.pid,createdAt:'2026-01-01',updatedAt:'2026-01-01'}));const manager=createNativeInstallManager(root);assert.equal(manager.get(id)?.stage,'interrupted');assert.match(manager.get(id)?.error??'',/子进程退出无法确认/);assert.equal(existsSync(scratch),true);assert.equal('childPid' in (manager.get(id)??{}),false);}finally{rmSync(root,{recursive:true,force:true});}
});
test('restart retains scratch during the spawn to PID persistence window',()=>{
 const root=mkdtempSync(join(tmpdir(),'native-install-'));
 try{const jobs=join(root,'install-jobs'),scratch=join(root,'.install-ABC125');mkdirSync(jobs);mkdirSync(scratch);const id='55555555-5555-4555-8555-555555555555';writeFileSync(join(jobs,id+'.json'),JSON.stringify({id,kind:'npm',stage:'installing',scratchName:'.install-ABC125',scratchUnsafe:true,createdAt:'2026-01-01',updatedAt:'2026-01-01'}));const manager=createNativeInstallManager(root);assert.equal(manager.get(id)?.stage,'interrupted');assert.equal(existsSync(scratch),true);assert.equal('scratchUnsafe' in (manager.get(id)??{}),false);}finally{rmSync(root,{recursive:true,force:true});}
});
test('version directory cap rejects a new install before starting a job',()=>{
 const root=mkdtempSync(join(tmpdir(),'native-install-'));
 try{for(let i=0;i<100;i++)mkdirSync(join(root,i.toString(16).padStart(64,'0')));const manager=createNativeInstallManager(root);assert.throws(()=>manager.start({kind:'npm',recipe}),/目录已满/);assert.throws(()=>manager.start({kind:'portable',id:'f'.repeat(64),manifest:{},compressed:'AA==',metadata:'e30='}),/目录已满/);}finally{rmSync(root,{recursive:true,force:true});}
});
test('invalid portable bundle fails with sanitized status and no installed version',async()=>{
 const root=mkdtempSync(join(tmpdir(),'native-install-'));
 try{const manager=createNativeInstallManager(root);const state=manager.start({kind:'portable',id:'a'.repeat(64),manifest:{},compressed:'AA==',metadata:'e30='});await new Promise(resolve=>setImmediate(resolve));assert.equal(manager.get(state.id)?.stage,'failed');assert.ok(manager.get(state.id)?.error); }finally{rmSync(root,{recursive:true,force:true});}
});
test('install routes are explicitly admin only and demo rejects execution',async()=>{
 assert.doesNotThrow(assertRouteInventory);
 for(const entry of routePolicies.filter(entry=>entry.path.startsWith('/api/capabilities/plugins/install')))assert.equal(entry.access,'admin');
 const root=mkdtempSync(join(tmpdir(),'native-install-'));
 const app=express();app.use(express.json());app.use('/api',nativeCapabilityRouter({demo:true,root}));
 const server=app.listen(0);try{const address=server.address();assert.ok(address&&typeof address!=='string');const response=await fetch(`http://127.0.0.1:${address.port}/api/capabilities/plugins/install`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:'npm',recipe})});assert.equal(response.status,403);}finally{server.close();rmSync(root,{recursive:true,force:true});}
});
