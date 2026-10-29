import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ENTERPRISE_BACKUP_FORMAT,ENTERPRISE_ENVELOPE_LIMIT_BYTES} from '../packages/contracts/backup.ts';
const state:any=await import('../apps/web/src/enterprise-backup-state.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
test('backup upload rejects oversized files before reading, bad JSON and unsupported formats',async()=>{
 assert.equal(typeof state.readBackupFile,'function');let reads=0;
 await assert.rejects(state.readBackupFile({size:ENTERPRISE_ENVELOPE_LIMIT_BYTES+1,text:async()=>{reads++;return '{}';}}),/70/);assert.equal(reads,0);
 for(const text of ['broken','[]','{}','{"format":"unknown"}'])await assert.rejects(state.readBackupFile({size:text.length,text:async()=>text}));
 const backup={format:ENTERPRISE_BACKUP_FORMAT};assert.deepEqual(await state.readBackupFile({size:ENTERPRISE_ENVELOPE_LIMIT_BYTES,text:async()=>JSON.stringify(backup)}),backup);
});
test('v2 requires a successful preview and precise confirmation; busy and missing password always deny',()=>{
 assert.equal(typeof state.canRestoreBackup,'function');const input={backup:{format:ENTERPRISE_BACKUP_FORMAT},preview:{format:ENTERPRISE_BACKUP_FORMAT},password:'synthetic-password',confirmation:'RESTORE ENTERPRISE',busy:false};
 assert.equal(state.canRestoreBackup(input),true);for(const patch of [{preview:null},{confirmation:'RESTORE'},{confirmation:'RESTORE ENTERPRISE '},{busy:true},{password:''},{backup:null}])assert.equal(state.canRestoreBackup({...input,...patch}),false);
 assert.equal(state.canRestoreBackup({...input,backup:{format:'agent-department-backup-v1'},preview:null,confirmation:'RESTORE'}),true);
});
test('restore failure and status text distinguish invalid password, nonfresh, quarantine and uncertainty',()=>{
 assert.equal(typeof state.backupFailureMessage,'function');assert.match(state.backupFailureMessage({code:'BACKUP_DECRYPT_FAILED'}),/密码/);assert.match(state.backupFailureMessage({code:'BACKUP_DESTINATION_NOT_FRESH'}),/全新/);assert.match(state.backupFailureMessage({code:'BACKUP_RESTORE_RECONCILIATION_REQUIRED'}),/核对/);assert.match(state.backupStateMessage({state:'quarantined'}),/重新登录/);assert.match(state.backupStateMessage({state:'active'}),/已激活/);
});
test('settings backup panel renders clear default v2, separate old format and a disabled restore action',async()=>{
 const {EnterpriseBackupCenter}=await import('../apps/web/src/EnterpriseBackupCenter.tsx');const html=renderToStaticMarkup(createElement(EnterpriseBackupCenter,{download:()=>{}}));
 assert.match(html,/完整企业备份/);assert.match(html,/全新隔离实例/);assert.match(html,/旧版业务格式/);assert.match(html,/RESTORE ENTERPRISE/);assert.match(html,/disabled/);assert.ok(!html.includes('恢复成功'));
});
