import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { nativeManifestId } from '../services/agent-runtime/native-capabilities.mjs';
import { migrateNativeCapabilities, setNativeCapability, snapshotNativeCapabilities, assertNativeCapabilities,exportNativeBundles,restoreNativeBundles,readNativeBundle,listNativeCapabilities,nativeCapabilityRoot } from '../apps/api/src/native-capabilities.ts';
test('local launcher stores installed plugins in the workspace, independently of its credential directory',()=>{
 const previous=process.env.LOCAL_WORKSPACE_ROOT;
 try{process.env.LOCAL_WORKSPACE_ROOT=join(tmpdir(),'native-root-fixture');assert.equal(nativeCapabilityRoot(),join(process.env.LOCAL_WORKSPACE_ROOT,'native-plugins'));}
 finally{if(previous===undefined)delete process.env.LOCAL_WORKSPACE_ROOT;else process.env.LOCAL_WORKSPACE_ROOT=previous;}
});
test('registry admits installed bytes, preserves old version across upgrade, denies revoke/tamper and missing grants', async () => {
 const db = new PGlite(), root = mkdtempSync(join(tmpdir(), 'native-store-'));
 const hash = (value: Buffer|string) => createHash('sha256').update(value).digest('hex');
 const code = Buffer.from('reviewed code'), compressed = gzipSync(code), metadata = Buffer.from('{}');
 const install = (version: string) => {
  const manifest = {format:'dsh-native-tools-v1',namespace:'office',package:'@company/office',version,source:{kind:'company',reference:'private'},dshVersion:'0.1.5-rc.1',config:{},lockSha256:hash('lock'),bundle:{sha256:hash(compressed),codeSha256:hash(code),metadataSha256:hash(metadata),bytes:compressed.length},tools:[{name:'plugin__office__read',originalName:'read',description:'Read',parameters:{type:'object'},files:{read:['file'],write:[]}}]};
  const id=nativeManifestId(manifest), dir=join(root,id);mkdirSync(dir);writeFileSync(join(dir,'bundle.gz'),compressed);writeFileSync(join(dir,'package.json'),metadata);writeFileSync(join(dir,'manifest.json'),JSON.stringify(manifest));return {id,manifest};
 };
 try {
  await migrateNativeCapabilities(db as any);
  const one=install('1.0.0'),two=install('2.0.0');
  const agents=[{id:'reader',tools:['plugin__office__read']}];
  await assert.rejects(snapshotNativeCapabilities(agents,db as any,root),/NATIVE_TOOL_UNAVAILABLE/);
  await setNativeCapability(one.id,true,db as any,root);
  const nativeCapabilities=await snapshotNativeCapabilities(agents,db as any,root);
  assert.equal(nativeCapabilities[0].id,one.id);
  await setNativeCapability(two.id,true,db as any,root);
  await assertNativeCapabilities({agents,nativeCapabilities},db as any,root);
  assert.equal((await snapshotNativeCapabilities(agents,db as any,root))[0].id,two.id);
  await setNativeCapability(two.id,false,db as any,root);
  await assert.rejects(assertNativeCapabilities({agents,nativeCapabilities},db as any,root),/NATIVE_PLUGIN_DISABLED/);
  await setNativeCapability(two.id,true,db as any,root);
  const backup=exportNativeBundles({native_capabilities:[{manifest_id:two.id}],project_runs:[{snapshot:{nativeCapabilities}}]},root),isolated=join(root,'isolated');
  restoreNativeBundles(backup,isolated);
  assert.equal(readNativeBundle(one.id,isolated).manifest.version,'1.0.0');
  assert.equal(readNativeBundle(two.id,isolated).manifest.version,'2.0.0');
  assert.equal(readNativeBundle(one.id,root).manifest.version,'1.0.0');
  writeFileSync(join(root,one.id,'bundle.gz'),'tampered');
  await assert.rejects(assertNativeCapabilities({agents,nativeCapabilities},db as any,root),/NATIVE_BUNDLE/);
  await assertNativeCapabilities({agents:[{tools:['filesystem']}]},db as any,root);
  rmSync(join(root,two.id),{recursive:true});
  const broken=(await listNativeCapabilities(db as any,root)).find(entry=>entry.id===two.id);
  assert.equal(broken?.available,false);assert.equal(broken?.enabled,true);
  await setNativeCapability(two.id,false,db as any,root);
  assert.equal((await listNativeCapabilities(db as any,root)).find(entry=>entry.id===two.id)?.enabled,false);
  await db.query("INSERT INTO native_capabilities(namespace,manifest_id,enabled) VALUES('missing',$1,true)",['f'.repeat(64)]);
  restoreNativeBundles(backup,join(root,'healthy'));
  await setNativeCapability(two.id,true,db as any,join(root,'healthy'));
  assert.equal((await snapshotNativeCapabilities(agents,db as any,join(root,'healthy')))[0].id,two.id,'unrelated broken plugin must not block a healthy grant');
 }finally{await db.close();rmSync(root,{recursive:true,force:true});}
});
