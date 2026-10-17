import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HandoffGate, inspectArtifact } from './handoff.mjs';
import { makeFixtureFiles } from './test-support/handoff-fixtures.mjs';

async function fixture(tasks,work) {
  const root=await mkdtemp(join(tmpdir(),'handoff-gate-')),events=[];
  const gate=new HandoffGate({snapshot:{tasks},sandbox:{root},archive:{append:(type,data)=>events.push({type,data})}});
  try { await work({root,gate,events}); } finally { await rm(root,{recursive:true,force:true}); }
}
test('host validates actual JSON content and rejects missing, invalid and failed acceptance',()=>fixture([
  {id:'produce',dependencies:[],outputs:[{path:'result.json',format:'json',requiredKeys:['accepted'],expectedValues:{accepted:true}}]},
],({root,gate})=>{
  assert.throws(()=>gate.prepare('produce','attempt',{}),/MISSING_FILE/);
  for(const [text,reason] of [['not json',/INVALID_JSON/],['[]',/INVALID_JSON_OBJECT/],['{}',/MISSING_JSON_KEY/],['{"accepted":false}',/ACCEPTANCE_FAILED/]]){
    writeFileSync(join(root,'result.json'),text);assert.throws(()=>gate.prepare('produce','attempt',{}),reason);
  }
  writeFileSync(join(root,'result.json'),'{"accepted":true}');const record=gate.prepare('produce','attempt',{});
  assert.match(record.outputs[0].sha256,/^[a-f0-9]{64}$/);
}));
test('consumer binds the accepted producer version and refuses changed or unaccepted inputs',()=>fixture([
  {id:'produce',dependencies:[],outputs:[{path:'result.txt',format:'text'}]},
  {id:'consume',dependencies:['produce'],inputs:[{path:'result.txt',producerTaskId:'produce'}],outputs:[]},
],({root,gate})=>{
  writeFileSync(join(root,'result.txt'),'first');
  assert.throws(()=>gate.begin('consume','before'),/UNACCEPTED_INPUT/);
  gate.commit(gate.prepare('produce','producer',{}));gate.begin('consume','consumer');
  writeFileSync(join(root,'result.txt'),'second');
  assert.throws(()=>gate.begin('consume','new-attempt'),/VERSION_MISMATCH/);
  assert.throws(()=>gate.beforeFile('consume','consumer','filesystem',{path:'result.txt'}),/VERSION_MISMATCH/);
}));
test('claimed command evidence cannot replace an actual successful check on the current workspace',()=>fixture([
  {id:'implement',kind:'implementation',dependencies:[],inScope:['result.txt'],verify:['check'],outputs:[{path:'result.txt'}]},
],({root,gate})=>{
  writeFileSync(join(root,'result.txt'),'first');
  const forged={commandsRun:[{command:'check',status:'passed',exitCode:0}],changedPaths:[]};
  assert.throws(()=>gate.prepare('implement','a',forged),/UNVERIFIED_COMMAND/);
  const before=gate.beforeFile('implement','a','terminal_test',{});
  gate.observe('implement','a','terminal_test',{command:'check'},{exitCode:1},before);
  assert.throws(()=>gate.prepare('implement','a',forged),/UNVERIFIED_COMMAND/);
  gate.observe('implement','a','terminal_test',{command:'check'},{exitCode:0},before);
  assert.equal(gate.prepare('implement','a',forged).commands.at(-1).exitCode,0);
  gate.invalidateCommands('implement','a');
  assert.throws(()=>gate.prepare('implement','a',forged),/UNVERIFIED_COMMAND/);
  gate.observe('implement','a','terminal_test',{command:'check'},{exitCode:0},before);
  writeFileSync(join(root,'result.txt'),'changed');
  assert.throws(()=>gate.prepare('implement','a',forged),/UNVERIFIED_COMMAND/);
}));
test('file contracts prevent undeclared reads/writes and changedPaths must match observed writes',()=>fixture([
  {id:'implement',kind:'implementation',dependencies:[],inputs:[],outputs:[{path:'result.txt'}],inScope:['result.txt'],verify:['check']},
  {id:'guard',dependencies:[],outOfScope:['private']},
],({root,gate})=>{
  assert.throws(()=>gate.beforeFile('guard','a','artifact_write',{path:'private/file.txt'}),/OUT_OF_SCOPE/);
  assert.throws(()=>gate.beforeFile('implement','a','filesystem',{path:'foreign.txt'}),/UNDECLARED_INPUT/);
  assert.throws(()=>gate.beforeFile('implement','a','artifact_write',{path:'foreign.txt'}),/UNDECLARED_OUTPUT/);
  const before=gate.beforeFile('implement','a','artifact_write',{path:'result.txt'});
  writeFileSync(join(root,'result.txt'),'written');gate.observe('implement','a','artifact_write',{path:'result.txt'},{},before);
  const current=gate.beforeFile('implement','a','terminal_test',{});
  gate.observe('implement','a','terminal_test',{command:'check'},{exitCode:0},current);
  assert.throws(()=>gate.prepare('implement','a',{changedPaths:[]}),/CHANGED_PATHS_MISMATCH/);
  assert.equal(gate.prepare('implement','a',{changedPaths:['result.txt']}).outputs.length,1);
  const beforeViolation=gate.beforeFile('implement','a','terminal_test',{});
  writeFileSync(join(root,'foreign.txt'),'out of contract');
  assert.throws(()=>gate.observe('implement','a','terminal_test',{command:'check'},{exitCode:0},beforeViolation),/UNDECLARED_OUTPUT/);
  const afterViolation=gate.beforeFile('implement','a','terminal_test',{});
  gate.observe('implement','a','terminal_test',{command:'check'},{exitCode:0},afterViolation);
  assert.throws(()=>gate.prepare('implement','a',{changedPaths:['result.txt']}),/UNDECLARED_OUTPUT/);
}));
test('restored outputs are not current-attempt changes and mismatches report the exact observed paths',()=>fixture([
  {id:'implement',kind:'implementation',dependencies:[],outputs:[{path:'result.txt'}],inScope:['result.txt'],verify:['check']},
],({root,gate})=>{
  writeFileSync(join(root,'result.txt'),'restored');
  const before=gate.beforeFile('implement','new-attempt','terminal_test',{});
  gate.observe('implement','new-attempt','terminal_test',{command:'check'},{exitCode:0},before);
  assert.throws(()=>gate.prepare('implement','new-attempt',{changedPaths:['result.txt']}),/当前 attempt.*changedPaths=\[\]/);
  assert.equal(gate.prepare('implement','new-attempt',{changedPaths:[]}).outputs.length,1);
  const beforeWrite=gate.beforeFile('implement','new-attempt','artifact_write',{path:'result.txt'});
  writeFileSync(join(root,'result.txt'),'updated');gate.observe('implement','new-attempt','artifact_write',{path:'result.txt'},{},beforeWrite);
  const afterWrite=gate.beforeFile('implement','new-attempt','terminal_test',{});
  gate.observe('implement','new-attempt','terminal_test',{command:'check'},{exitCode:0},afterWrite);
  assert.throws(()=>gate.prepare('implement','new-attempt',{changedPaths:[]}),/changedPaths=\["result.txt"\]/);
  assert.equal(gate.prepare('implement','new-attempt',{changedPaths:['result.txt']}).outputs.length,1);
}));
test('host file checks reject linked directories before reading their contents',()=>fixture([],({root})=>{
  const target=join(root,'target');mkdirSync(target);writeFileSync(join(target,'secret.txt'),'secret');
  // Windows junctions exercise the same lstat boundary without requiring
  // developer mode or administrator privileges to create a file symlink.
  symlinkSync(target,join(root,'link'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>inspectArtifact(root,{path:'link/secret.txt'}),/INVALID_FILE/);
}));

test('host file checks reject binary content declared as text',()=>fixture([],({root})=>{
  writeFileSync(join(root,'binary'),'text\0bytes');assert.throws(()=>inspectArtifact(root,{path:'binary',format:'text'}),/INVALID_TEXT/);
}));
test('optimistic writes reject a second editor using the same observed hash',()=>fixture([],({root})=>{
  const files=makeFixtureFiles(root),initial=files.read('inputs/orders.json');
  files.write(initial.path,'first edit',initial.sha256);
  assert.throws(()=>files.write(initial.path,'second edit',initial.sha256),/VERSION_CONFLICT/);
  assert.equal(files.read(initial.path).content,'first edit');
}));
