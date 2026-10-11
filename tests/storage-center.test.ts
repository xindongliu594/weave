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
