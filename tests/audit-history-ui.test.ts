import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

const path='../apps/web/src/audit-history-client.ts';
const client:any=await import(path).catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
const componentPath='../apps/web/src/AuditHistory.tsx';
const components:any=await import(componentPath).catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
const page={items:[{sourceEventId:'event-1',occurredAt:'2026-10-24T00:00:00.000Z',integrity:'verified',action:'run.cancel',actor:{kind:'local-owner'},outcome:'success',correlation:{runId:'run-1'},resource:{type:'run',id:'run-1'},changes:{state:'cancelled'}}],nextCursor:null,range:{after:'2026-10-23T00:00:00.000Z',before:'2026-10-24T00:00:00.000Z'}};
const create=(send:any)=>{assert.equal(typeof client.createAuditHistoryReader,'function');return client.createAuditHistoryReader(send);};

test('audit reads are explicit and duplicate requests are coalesced',async()=>{
 let calls=0,finish:any;const reader=create(()=>{calls++;return new Promise(resolve=>{finish=resolve;});});
 assert.equal(calls,0);await reader.load({});assert.equal(calls,0);
 reader.setActive(true);const first=reader.load({}),second=reader.load({});assert.equal(calls,1);assert.equal(reader.getSnapshot().loading,true);
 finish(page);await Promise.all([first,second]);assert.equal(reader.getSnapshot().page,page);reader.dispose();
});
test('close aborts the request, clears records and discards a late response',async()=>{
 let finish:any,signal:AbortSignal|undefined;const reader=create((_path:string,s:AbortSignal)=>{signal=s;return new Promise(resolve=>{finish=resolve;});});
 reader.setActive(true);const work=reader.load({});reader.setActive(false);assert.equal(signal?.aborted,true);assert.equal(reader.getSnapshot().page,null);
 finish(page);await work;assert.equal(reader.getSnapshot().page,null);reader.dispose();
});
test('failed refresh including revocation clears prior data and never retries',async()=>{
 let calls=0;const reader=create(async()=>{if(++calls===1)return page;throw Error('权限已经收回');});reader.setActive(true);
 await reader.load({});assert.equal(reader.getSnapshot().page,page);await reader.load({});assert.equal(reader.getSnapshot().page,null);assert.match(reader.getSnapshot().error,/权限/);assert.equal(calls,2);reader.dispose();
});
test('disposing a visible component clears data and cancels outstanding work',async()=>{
 let finish:any;const reader=create(()=>new Promise(resolve=>{finish=resolve;}));reader.setActive(true);const work=reader.load({});reader.dispose();finish(page);await work;assert.equal(reader.getSnapshot().page,null);
});
test('query parameters are encoded and no filtering instruction becomes a route',async()=>{
 let url='';const reader=create(async(path:string)=>{url=path;return page;});reader.setActive(true);await reader.load({runId:'run ?&/',outcome:'failure'},'cursor+');
 const query=new URL(url,'https://local.invalid');assert.equal(query.pathname,'/audit/events');assert.equal(query.searchParams.get('runId'),'run ?&/');assert.equal(query.searchParams.get('cursor'),'cursor+');reader.dispose();
});
test('audit table labels historical outcome and renders only explicit summary fields',()=>{
 assert.equal(typeof components.AuditHistoryRows,'function');
 const html=renderToStaticMarkup(createElement(components.AuditHistoryRows,{page:{...page,items:[...page.items,{sourceEventId:null,occurredAt:'2026-10-24T00:00:00Z',integrity:'legacy-unverified',secret:'PRIVATE BODY'}]}}));
 assert.match(html,/本机所有者/);assert.match(html,/已记录成功/);assert.match(html,/历史记录缺少可验证摘要/);assert.doesNotMatch(html,/PRIVATE BODY|secret/);
});
