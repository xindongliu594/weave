import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,linkSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const health=await import('../scripts/maintenance/health.mjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
const cli=resolve('scripts/maintenance/report.mjs');
const now=Date.parse('2026-10-23T08:00:00Z');
const clean={present:true,bytes:3,files:1,entries:2,links:0,complete:true,errors:[]};
const input=()=>({storage:clean,disk:{freeBytes:1024**3,minFreeBytes:256*1024**2},now});
function report(value){assert.equal(typeof health.buildHealthReport,'function','health report API must exist');return health.buildHealthReport(value);}
function workspace(t){const root=mkdtempSync(join(tmpdir(),'weiwu-maintenance-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const source=join(root,'source');mkdirSync(source);writeFileSync(join(source,'user.txt'),'keep this content');return {root,source};}
function run(args){return spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:10000,windowsHide:true});}

test('missing retention and restore evidence never produces a passing health report',()=>{
 const result=report(input());assert.equal(result.status,'unknown');assert.equal(result.checks.storage.status,'passed');assert.equal(result.checks.backup.status,'unknown');assert.equal(result.automaticDeletion,false);
});
test('partial storage, missing roots and non-finite capacity cannot report healthy',()=>{
 for(const storage of [{...clean,present:false},{...clean,complete:false},{...clean,links:1},{...clean,bytes:NaN}])assert.notEqual(report({...input(),storage}).checks.storage.status,'passed');
 assert.equal(report({...input(),disk:{freeBytes:NaN}}).checks.disk.status,'unknown');
 assert.equal(report({...input(),disk:{freeBytes:1,minFreeBytes:256*1024**2}}).status,'failed');
});
test('recorded restore success remains unverified current recoverability and omits source content',()=>{
 const data={format:'full-offline-isolated-restore-v1',fixture:false,checkedAt:new Date(now-1000).toISOString(),copyProof:{source:'SECRET PATH',sourceStableDuringCopy:true,sourceDatabaseNeverOpened:true,businessAndDatabaseFilesExactSha256:true,contentManifestSha256:'a'.repeat(64)},restoreReadOnlyOpenedTwice:true,persistentBusinessFingerprintsEqual:true,employeeTest:{status:'passed'}};
 const result=report({...input(),backup:{data,sha256:'b'.repeat(64)}});assert.equal(result.checks.backup.recordedStatus,'passed');assert.equal(result.checks.backup.status,'unknown');assert.equal(result.status,'unknown');assert.equal(JSON.stringify(result).includes('SECRET'),false);
 for(const change of [{fixture:true},{checkedAt:'bad'},{checkedAt:new Date(now+10000).toISOString()},{checkedAt:new Date(now-8*86400000).toISOString()}])assert.notEqual(report({...input(),backup:{data:{...data,...change}}}).checks.backup.recordedStatus,'passed');
 assert.equal(report({...input(),backup:{data:{...data,persistentBusinessFingerprintsEqual:false}}}).status,'failed');
 assert.equal(report({...input(),backup:{data:{...data,employeeTest:{status:'failed'}}}}).checks.backup.code,'RECORDED_RESTORE_FAILED');
});
for(const sample of [{name:'missing'},{name:'unknown',status:'unknown'},{name:'not-run',status:'not-run-fixture'},{name:'fixture-skip',status:'not-run-fixture',fixture:true}])test('employee recovery evidence stays unknown without a recorded pass: '+sample.name,()=>{
 const data={format:'full-offline-isolated-restore-v1',fixture:sample.fixture??false,checkedAt:new Date(now-1000).toISOString(),copyProof:{source:'SECRET SOURCE PATH',sourceStableDuringCopy:true,sourceDatabaseNeverOpened:true,businessAndDatabaseFilesExactSha256:true,contentManifestSha256:'a'.repeat(64)},restoreReadOnlyOpenedTwice:true,persistentBusinessFingerprintsEqual:true,raw:'SECRET ORIGINAL CONTENT',...(sample.status?{employeeTest:{status:sample.status,testOutput:'SECRET TEST OUTPUT'}}:{})};
 const result=report({...input(),backup:{data}});
 assert.equal(result.status,'unknown');assert.equal(result.checks.backup.status,'unknown');
 assert.equal(Object.hasOwn(result.checks.backup,'recordedStatus'),false,'missing or unexecuted employee evidence cannot be a recorded successful drill');
 assert.equal(result.checks.backup.code,sample.fixture?'RESTORE_EVIDENCE_FIXTURE':'RESTORE_EVIDENCE_INCOMPLETE');
 assert.equal(JSON.stringify(result).includes('SECRET'),false,'source paths and original evidence content stay out of the report');
});

test('retention input remains advisory and arbitrary fields cannot escape the summary',()=>{
 const data={mode:'suggestion-only',automaticDeletion:false,policy:{hotJournalHours:24,completedCopiesDays:7,releaseKeepLatest:3,backupDays:30,backupKeepLatest:3},recommendations:[{runId:'00000000-0000-4000-8000-000000000001',kind:'workspace',ageDays:9}],secret:'DO NOT OUTPUT'};
 const result=report({...input(),retention:{data}});assert.equal(result.checks.retention.recommendations,1);assert.equal(result.checks.retention.status,'unknown');assert.equal(JSON.stringify(result).includes('DO NOT OUTPUT'),false);
 assert.equal(report({...input(),retention:{data:{...data,automaticDeletion:true}}}).status,'failed');
});
test('CLI scans real files and preserves them, returning unknown for absent proofs',t=>{
 const {source}=workspace(t),file=join(source,'user.txt'),before=readFileSync(file);const result=run([`--root=${source}`]);
 assert.equal(result.status,2,result.stderr);const value=JSON.parse(result.stdout);assert.equal(value.format,'weiwu-maintenance-health-v1');assert.equal(value.status,'unknown');assert.equal(value.scope,'offline-read-only');assert.equal(value.checks.storage.status,'passed');assert.equal(value.checks.storage.files,1);assert.equal(value.checks.storage.bytes,17);assert.deepEqual(readFileSync(file),before);assert.ok(Buffer.byteLength(result.stdout)<65536);
});
test('missing roots are reported unknown instead of an empty healthy directory',t=>{
 const {root}=workspace(t),result=run([`--root=${join(root,'missing')}`]);assert.equal(result.status,2,result.stderr);assert.equal(JSON.parse(result.stdout).checks.storage.status,'unknown');
});
test('timeout returns bounded unknown evidence and terminates the scan worker',t=>{
 const {source}=workspace(t),start=Date.now(),result=run([`--root=${source}`,'--timeout-ms=1']);assert.equal(result.status,2,result.stderr);assert.equal(JSON.parse(result.stdout).checks.storage.code,'INSPECTION_TIMEOUT');assert.ok(Date.now()-start<5000);
});
test('oversized and malformed evidence is rejected without disclosing its contents',t=>{
 const {root,source}=workspace(t),path=join(root,'evidence.json');
 for(const text of ['secret private malformed evidence',JSON.stringify({private:'x'.repeat(1024*1024+1)})]){writeFileSync(path,text);const result=run([`--root=${source}`,`--backup-report=${path}`]);assert.equal(result.status,1,result.stderr);assert.equal(JSON.parse(result.stdout).checks.backup.status,'failed');assert.equal(result.stdout.includes('secret private'),false);}
});
test('hardlinked evidence is rejected before parsing and remains unchanged',t=>{
 const {root,source}=workspace(t),path=join(root,'proof.json'),other=join(root,'alias.json');writeFileSync(path,'{"private":"unchanged"}');linkSync(path,other);const result=run([`--root=${source}`,`--backup-report=${path}`]);assert.equal(result.status,1,result.stderr);assert.equal(JSON.parse(result.stdout).checks.backup.code,'EVIDENCE_NOT_REGULAR');assert.equal(readFileSync(other,'utf8'),'{"private":"unchanged"}');
});
test('repeated CLI reports retain at most two owned slots without removing unrelated files',t=>{
 const {root,source}=workspace(t),out=join(root,'reports');mkdirSync(out);writeFileSync(join(out,'unrelated.txt'),'keep');
 for(let i=0;i<4;i++){const result=run([`--root=${source}`,`--report-dir=${out}`]);assert.equal(result.status,2,result.stderr);}
 const files=readdirSync(out);assert.equal(files.filter(n=>/^report-[01]\.json$/.test(n)).length,2);assert.equal(readFileSync(join(out,'unrelated.txt'),'utf8'),'keep');for(const name of files.filter(n=>n.endsWith('.json')))assert.equal(JSON.parse(readFileSync(join(out,name),'utf8')).format,'weiwu-maintenance-health-v1');
});
test('report output cannot overlap input roots or overwrite an unowned report slot',t=>{
 const {root,source}=workspace(t);let result=run([`--root=${source}`,`--report-dir=${source}`]);assert.equal(result.status,1);assert.deepEqual(readdirSync(source),['user.txt']);
 const out=join(root,'reports');mkdirSync(out);writeFileSync(join(out,'report-0.json'),'user content');result=run([`--root=${source}`,`--report-dir=${out}`]);assert.equal(result.status,1);assert.equal(readFileSync(join(out,'report-0.json'),'utf8'),'user content');
});
test('directory links cannot become a report destination',t=>{
 const {root,source}=workspace(t),out=join(root,'linked');try{symlinkSync(source,out,process.platform==='win32'?'junction':'dir');}catch(error){if(error.code==='EPERM')return t.skip('symlink privilege unavailable');throw error;}const result=run([`--root=${source}`,`--report-dir=${out}`]);assert.equal(result.status,1);assert.deepEqual(readdirSync(source),['user.txt']);
});
test('unknown duplicate and URL arguments are rejected before any report directory is made',t=>{
 const {root,source}=workspace(t),out=join(root,'reports');for(const args of [['--delete'],[`--root=${source}`],['--backup-report=https://example.com/proof.json']]){const result=run([`--root=${source}`,`--report-dir=${out}`,...args]);assert.equal(result.status,1);assert.equal(readdirSync(root).includes('reports'),false);}
});
test('a linked input root cannot hide overlap with the real output directory',t=>{
 const {root,source}=workspace(t),alias=join(root,'alias');try{symlinkSync(source,alias,process.platform==='win32'?'junction':'dir');}catch(error){if(error.code==='EPERM')return t.skip('symlink privilege unavailable');throw error;}
 const result=run([`--root=${alias}`,`--report-dir=${join(source,'reports')}`]);assert.equal(result.status,1);assert.deepEqual(readdirSync(source),['user.txt']);
});
test('UNC and device paths are rejected without attempting remote filesystem access',()=>{
 for(const path of ['//server/share/root','\\\\server\\share\\root','\\\\?\\C:\\data']){const result=run([`--root=${path}`]);assert.equal(result.status,1);assert.match(result.stderr,/ABSOLUTE_LOCAL_PATH_REQUIRED/);}
});
