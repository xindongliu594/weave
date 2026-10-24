import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const ui:any=await import('../apps/web/src/StorageCenter.tsx').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
const preview={id:'fixture',status:'preview',createdAt:new Date().toISOString(),preview:{expiresAt:new Date(Date.now()+60000).toISOString(),bytes:9,candidates:[{runId:'run',path:'code.txt',bytes:9}],protectedRuns:[{runId:'failed-run',reason:'保留恢复现场'}]}};
test('inventory marks incomplete scans and gives a settings action instead of claiming all data was counted',()=>{
 assert.equal(typeof ui.StorageReport,'function');const html=renderToStaticMarkup(createElement(ui.StorageReport,{data:{bytes:8,maxBytes:1073741824,runMaxBytes:67108864,complete:false,groups:[{id:'runs',name:'运行档案',bytes:8,files:1,complete:false,links:1}],runs:[],disk:{freeBytes:123,minFreeBytes:268435456,blocked:true}}}));
 for(const text of ['扫描不完整','磁盘空间不足','运行档案','1 GiB','64 MiB'])assert.ok(html.includes(text),text);
});
test('preview makes clear exactly which copies are removed and preserves recovery evidence',()=>{
 assert.equal(typeof ui.CleanupPreview,'function');const html=renderToStaticMarkup(createElement(ui.CleanupPreview,{row:preview,busy:false,onConfirm:()=>{}}));
 for(const text of ['code.txt','已完成本机工作区副本','交付档案、检查点和费用记录保留','确认清理','保留恢复现场'])assert.ok(html.includes(text),text);
});
test('expired, empty and started previews never enable a deletion confirmation',()=>{
 assert.equal(typeof ui.cleanupCanConfirm,'function');assert.equal(ui.cleanupCanConfirm(preview,false),true);
 for(const row of [{...preview,status:'started'},{...preview,preview:{...preview.preview,candidates:[]}},{...preview,preview:{...preview.preview,expiresAt:'2000-01-01'}}])assert.equal(ui.cleanupCanConfirm(row,false),false);
 assert.equal(ui.cleanupCanConfirm(preview,true),false);
});
test('interrupted history has a reconcile action and does not offer automatic replay',()=>{
 assert.equal(typeof ui.CleanupHistory,'function');const html=renderToStaticMarkup(createElement(ui.CleanupHistory,{rows:[{...preview,status:'started'}],busy:false,onReconcile:()=>{}}));
 assert.ok(html.includes('核对中断结果'));assert.ok(html.includes('不会自动续删'));assert.ok(!html.includes('清理成功'));
});

test('sandbox panel exposes measured writable directories and labels application limits honestly',()=>{
 assert.equal(typeof ui.SandboxStorageReport,'function');const html=renderToStaticMarkup(createElement(ui.SandboxStorageReport,{data:{available:true,hardQuota:false,scopes:[{runId:'run',sandboxId:'sandbox',phase:'stopped',storage:{workspace:{bytes:17},temp:{bytes:5},checkedAt:new Date().toISOString()}}]},busy:false,onInspect:()=>{},onPreview:()=>{}}));
 for(const text of ['OpenShell','/sandbox','/tmp','应用层','硬磁盘配额','核对容量','停止','预览回收'])assert.ok(html.includes(text),text);
});
test('journal and sandbox confirmations never reuse the workspace deletion label',()=>{
 const journal=renderToStaticMarkup(createElement(ui.CleanupPreview,{row:{...preview,preview:{...preview.preview,kind:'journal'}},busy:false,onConfirm:()=>{}}));assert.ok(journal.includes('确认压缩归档'));assert.ok(!journal.includes('确认清理上述副本'));
 const sandbox=renderToStaticMarkup(createElement(ui.CleanupPreview,{row:{...preview,preview:{...preview.preview,kind:'sandbox'}},busy:false,onConfirm:()=>{}}));assert.ok(sandbox.includes('确认回收沙箱'));assert.ok(sandbox.includes('正式交付'));
});

test('legacy interrupted records with unresolved results retain read-only reconciliation',()=>{
 for(const state of ['present','unverified']){const html=renderToStaticMarkup(createElement(ui.CleanupHistory,{rows:[{...preview,status:'interrupted',result:{state}}],busy:false,onReconcile:()=>{}}));assert.ok(html.includes('核对中断结果'));}
});

test('retention panel makes recommendations explicit and retains preview before confirmation',()=>{
 assert.equal(typeof ui.RetentionReport,'function');const html=renderToStaticMarkup(createElement(ui.RetentionReport,{data:{mode:'suggestion-only',policy:{hotJournalHours:24,completedCopiesDays:7,releaseKeepLatest:3,backupDays:30,backupKeepLatest:3},recommendations:[{runId:'run',kind:'journal',ageDays:2}]},busy:false,onPreview:()=>{}}));
 for(const text of ['保留与维护建议','不自动删除','7 天','24 小时','预览日志归档','共享依赖','30 天'])assert.ok(html.includes(text),text);assert.ok(!html.includes('确认删除全部'));
});


test('fixed protocol disables sandbox confirmations while workspace and journal remain available',()=>{
 const sandbox={...preview,preview:{...preview.preview,kind:'sandbox'}};
 assert.equal(ui.cleanupCanConfirm(sandbox,false),false);
 const html=renderToStaticMarkup(createElement(ui.CleanupPreview,{row:sandbox,busy:false,onConfirm:()=>{}}));
 assert.match(html,/<button disabled="">确认回收沙箱<\/button>/);assert.ok(html.includes('当前自动沙箱回收尚未开放'));assert.ok(html.includes('正式交付保留'));assert.ok(!html.includes('确认后调用官方删除原沙箱'));
 for(const kind of ['workspace','journal']){
  const row={...preview,preview:{...preview.preview,kind}};assert.equal(ui.cleanupCanConfirm(row,false),true);
  const enabled=renderToStaticMarkup(createElement(ui.CleanupPreview,{row,busy:false,onConfirm:()=>{}}));assert.ok(!enabled.includes('<button disabled="">'));
 }
});

test('all sandbox preview callers are disabled without disabling capacity inspection or other retention actions',()=>{
 const panel=renderToStaticMarkup(createElement(ui.SandboxStorageReport,{data:{available:true,scopes:[{runId:'run',phase:'stopped',storage:{workspace:{bytes:17},temp:{bytes:5},checkedAt:new Date().toISOString()}}]},busy:false,onInspect:()=>{},onPreview:()=>{}}));
 assert.match(panel,/<button disabled="">预览回收<\/button>/);assert.match(panel,/<button>核对容量与文件版本<\/button>/);assert.ok(panel.includes('当前自动沙箱回收尚未开放'));assert.ok(panel.includes('正式交付保留'));
 const retention=renderToStaticMarkup(createElement(ui.RetentionReport,{data:{policy:{hotJournalHours:24,completedCopiesDays:7,releaseKeepLatest:3,backupDays:30,backupKeepLatest:3},recommendations:['sandbox','workspace','journal'].map(kind=>({runId:kind,kind,ageDays:8}))},busy:false,onPreview:()=>{}}));
 assert.match(retention,/<button disabled="">预览沙箱回收<\/button>/);assert.match(retention,/<button>预览全部本机副本<\/button>/);assert.match(retention,/<button>预览日志归档<\/button>/);assert.ok(retention.includes('当前自动沙箱回收尚未开放'));
});

test('historical completed sandbox receipts are pending physical re-verification without rewriting history',()=>{
 for(const result of [{state:'retired',bytes:99,message:'原沙箱已不存在'},{bytes:99}]){
  const row={...preview,status:'completed',preview:{...preview.preview,kind:'sandbox'},result},before=JSON.stringify(row);
  const html=renderToStaticMarkup(createElement(ui.CleanupHistory,{rows:[row],busy:false,onReconcile:()=>{}}));
  assert.ok(html.includes('待物理复核'));assert.ok(!html.includes('清理完成'));assert.ok(!html.includes('原沙箱已不存在'));assert.ok(!html.includes('已记录回收'));assert.equal(JSON.stringify(row),before);
 }
 const html=renderToStaticMarkup(createElement(ui.CleanupHistory,{rows:[{...preview,status:'completed',preview:{...preview.preview,kind:'journal'},result:{state:'archived',savedBytes:4}}],busy:false,onReconcile:()=>{}}));
 assert.ok(html.includes('清理完成'));assert.ok(html.includes('原事件已核对归档'));assert.ok(html.includes('压缩节省'));
});

test('periodic maintenance clearly separates historical results from current unverified health',()=>{
 assert.equal(typeof ui.MaintenanceHealthReport,'function');
 const html=renderToStaticMarkup(createElement(ui.MaintenanceHealthReport,{data:{version:1,currentStatus:'unknown',availability:'degraded',code:'REPORT_DEGRADED',maxAgeHours:48,slots:[{slot:0,state:'available'},{slot:1,state:'invalid'}],report:{checkedAt:'2026-10-24T01:00:00.000Z',status:'failed',checks:{storage:{status:'passed',bytes:17,files:1},disk:{status:'failed',freeBytes:1},retention:{status:'unknown'},backup:{status:'unknown',recordedStatus:'passed',checkedAt:'2026-10-23T01:00:00.000Z'}}}}}));
 for(const text of ['周期维护记录','历史报告','记录失败','当前状态尚未现场复核','部分维护记录不可用','17 B','演练记录曾通过','当前恢复能力仍待核对'])assert.ok(html.includes(text),text);
 assert.ok(!html.includes('当前健康'));assert.ok(!html.includes('维护全部通过'));
});

test('missing stale and failed-to-load maintenance records remain explicit unknown without actions',()=>{
 assert.equal(typeof ui.MaintenanceHealthReport,'function');
 for(const code of ['NOT_CONFIGURED','REPORTS_MISSING','REPORT_UNAVAILABLE','REPORT_FETCH_FAILED']){
  const html=renderToStaticMarkup(createElement(ui.MaintenanceHealthReport,{data:{version:1,currentStatus:'unknown',availability:'unavailable',code,maxAgeHours:48,slots:[{slot:0,state:'stale'}]}}));
  assert.ok(html.includes('当前状态尚未现场复核'));assert.ok(html.includes('48 小时'));assert.ok(!html.includes('<button'));assert.ok(!html.includes('通过'));
 }
});

test('maintenance transport uses the authorized GET wrapper and contains a failed optional report',async()=>{
 assert.equal(typeof ui.loadMaintenanceHealth,'function');
 const {identitySession}=await import('../apps/web/src/identity-session.ts');const original=globalThis.fetch;const calls:Array<{url:string;init?:RequestInit}>=[];
 try{
  globalThis.fetch=async(input,init)=>{const url=String(input);calls.push({url,init});return url.includes('/auth/session')?Response.json({mode:'legacy-local',authenticated:true,user:null,csrf:null,loginAvailable:false}):Response.json({message:'PRIVATE SERVER PATH'},{status:503});};
  await identitySession.refresh();const value=await ui.loadMaintenanceHealth();assert.equal(value.currentStatus,'unknown');assert.equal(value.code,'REPORT_FETCH_FAILED');assert.ok(!JSON.stringify(value).includes('PRIVATE'));
  const business=calls.filter(call=>call.url.includes('/api/'));assert.equal(business.length,1);assert.ok(business[0].url.endsWith('/api/storage/maintenance'));assert.equal(business[0].init?.method,'GET');assert.equal(business[0].init?.cache,'no-store');
 }finally{globalThis.fetch=original;}
});
