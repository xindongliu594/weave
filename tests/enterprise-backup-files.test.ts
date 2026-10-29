import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync,linkSync,unlinkSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createBackupFileReader} from '../apps/api/src/enterprise-backup-files.ts';

test('backup read-set detects outside edits, additions and linked ancestors',t=>{
 const root=mkdtempSync(join(tmpdir(),'backup-files-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const path=join(root,'bytes.txt');writeFileSync(path,'exact\r\n');const reader=createBackupFileReader();
 assert.equal(reader.tree(root)['bytes.txt'],Buffer.from('exact\r\n').toString('base64'));reader.verify();writeFileSync(path,'changed');assert.throws(()=>reader.verify(),{code:'BACKUP_SOURCE_CHANGED'});
 const additions=createBackupFileReader();additions.tree(root);writeFileSync(join(root,'new.txt'),'new');assert.throws(()=>additions.verify(),{code:'BACKUP_SOURCE_CHANGED'});
 const alias=join(root,'alias.txt');linkSync(path,alias);assert.throws(()=>createBackupFileReader().tree(root),{code:'BACKUP_FILE_UNSAFE'});unlinkSync(alias);
 const outside=join(root,'outside'),link=join(root,'junction');mkdirSync(outside);writeFileSync(join(outside,'nested.txt'),'nested');symlinkSync(outside,link,process.platform==='win32'?'junction':'dir');
 assert.throws(()=>createBackupFileReader().read(join(link,'nested.txt')),{code:'BACKUP_FILE_UNSAFE'});unlinkSync(link);
});

test('optional credential absence belongs to the read-set and cannot mask a broken link',t=>{
 const root=mkdtempSync(join(tmpdir(),'backup-optional-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const path=join(root,'credential.key'),reader:any=createBackupFileReader();assert.equal(typeof reader.optional,'function');
 assert.equal(reader.optional(path),null);reader.verify();writeFileSync(path,Buffer.alloc(32));assert.throws(()=>reader.verify(),{code:'BACKUP_SOURCE_CHANGED'});
 unlinkSync(path);symlinkSync(join(root,'missing-directory'),path,process.platform==='win32'?'junction':'dir');
 assert.throws(()=>createBackupFileReader().optional(path),{code:'BACKUP_FILE_UNSAFE'});
});
