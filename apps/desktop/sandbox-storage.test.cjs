const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
let resources={};try{resources=require('./sandbox-storage.cjs');}catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error;}
function fixture(t){const root=path.join(__dirname,'.sandbox-storage-'+randomUUID());fs.mkdirSync(root);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const work=path.join(root,'work'),temp=path.join(root,'temp');fs.mkdirSync(work);fs.mkdirSync(temp);return {work,temp};}
test('real directory storage counts bytes and free filesystem without reading file contents',t=>{assert.equal(typeof resources.checkSandboxStorage,'function');const f=fixture(t);fs.writeFileSync(path.join(f.work,'code'),'abc');fs.writeFileSync(path.join(f.temp,'cache'),'12345');const result=resources.checkSandboxStorage(f.work,f.temp);assert.equal(result.workspace.bytes,3);assert.equal(result.temp.bytes,5);assert.ok(result.disk.freeBytes>0);assert.equal(result.hardQuota,false);});
test('temporary file growth stops admission independently of workspace exports',t=>{assert.equal(typeof resources.checkSandboxStorage,'function');const f=fixture(t),file=path.join(f.temp,'large');const fd=fs.openSync(file,'w');fs.ftruncateSync(fd,64*1024*1024+1);fs.closeSync(fd);assert.throws(()=>resources.checkSandboxStorage(f.work,f.temp),{code:'SANDBOX_STORAGE_LIMIT',notExecuted:true});assert.ok(fs.existsSync(file));});
test('bounded enumeration and directory links fail closed without traversing targets',t=>{assert.equal(typeof resources.checkSandboxStorage,'function');const f=fixture(t);fs.symlinkSync(f.work,path.join(f.temp,'link'),'junction');assert.throws(()=>resources.checkSandboxStorage(f.work,f.temp),{code:'SANDBOX_STORAGE_LIMIT'});fs.rmSync(path.join(f.temp,'link'));for(let n=0;n<514;n++)fs.writeFileSync(path.join(f.work,'file'+n),'');assert.throws(()=>resources.checkSandboxStorage(f.work,f.temp),{code:'SANDBOX_STORAGE_LIMIT'});});

test('concurrent temporary deletion triggers a bounded rescan rather than an admission failure',t=>{
 const f=fixture(t),file=path.join(f.temp,'gone');fs.writeFileSync(file,'temporary');const original=fs.lstatSync;let removed=false;
 t.mock.method(fs,'lstatSync',at=>{if(at===file&&!removed){removed=true;fs.unlinkSync(file);}return original(at);});
 assert.equal(resources.checkSandboxStorage(f.work,f.temp).temp.bytes,0);assert.equal(removed,true);
});

test('persistent directory churn is bounded and permission errors are never swallowed',t=>{
 const f=fixture(t),file=path.join(f.temp,'racing');fs.writeFileSync(file,'temporary');const original=fs.lstatSync;let attempts=0;
 t.mock.method(fs,'lstatSync',at=>{if(at===file){attempts++;throw Object.assign(Error('racing'),{code:'ENOENT'});}return original(at);});
 assert.throws(()=>resources.checkSandboxStorage(f.work,f.temp),{code:'SANDBOX_STORAGE_LIMIT'});assert.equal(attempts,3);
 t.mock.restoreAll();t.mock.method(fs,'lstatSync',at=>{if(at===file)throw Object.assign(Error('denied'),{code:'EACCES'});return original(at);});
 assert.throws(()=>resources.checkSandboxStorage(f.work,f.temp),{code:'EACCES'});
});
