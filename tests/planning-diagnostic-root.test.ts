import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {recordPlanningOutputDiagnostic} from '../apps/api/src/project-planning.ts';
import {createArchiveWriterManager} from '../services/agent-runtime/archive-writer-scope.mjs';

const diagnostic={reason:'invalid-json',position:1,originalOutputSHA:'a'.repeat(64),outputBytes:4};
function fixture(t:any){
 const parent=fs.realpathSync(os.tmpdir()),base=fs.mkdtempSync(path.join(parent,'planning-root-'));
 const root=path.join(base,'runs'),outside=root+'.planning-output-diagnostics';
 fs.mkdirSync(root);const writers=createArchiveWriterManager({traceRoot:root});
 t.after(()=>{assert.equal(fs.realpathSync(base),base);assert.equal(path.dirname(base),parent);fs.rmSync(base,{recursive:true});});
 return {base,root,outside,writers};
}

test('planning diagnostic stays outside an archive root swap and preserves old diagnostics',async t=>{
 const f=fixture(t),legacy=path.join(f.root,'planning-output-diagnostics');fs.mkdirSync(legacy);
 fs.writeFileSync(path.join(legacy,'old.json'),'historical diagnostic');
 await f.writers.withRootExclusive(async()=>{
  const retained=path.join(f.base,'retained-runs');fs.renameSync(f.root,retained);
  const id=recordPlanningOutputDiagnostic(f.root,diagnostic);
  assert.equal(fs.existsSync(f.root),false,'diagnostics must not recreate the swapped archive root');
  assert.equal(fs.readFileSync(path.join(retained,'planning-output-diagnostics','old.json'),'utf8'),'historical diagnostic');
  const stored=JSON.parse(fs.readFileSync(path.join(f.outside,id+'.json'),'utf8'));
  assert.equal(stored.id,id);assert.equal(stored.originalOutputSHA,diagnostic.originalOutputSHA);
  assert.deepEqual(Object.keys(stored).sort(),['at','id',...Object.keys(diagnostic)].sort());
  fs.renameSync(retained,f.root);
 });
});

test('planning diagnostic directory cannot be a junction into the archive root',async t=>{
 const f=fixture(t);fs.symlinkSync(f.root,f.outside,process.platform==='win32'?'junction':'dir');
 await f.writers.withRootExclusive(async()=>{
  assert.throws(()=>recordPlanningOutputDiagnostic(f.root,diagnostic),/diagnostic directory/i);
  assert.deepEqual(fs.readdirSync(f.root),[]);
 });
});
