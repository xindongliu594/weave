import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {checkpointTestInvocation} from '../apps/desktop/checkpoint-test-profile.cjs';
test('reusable test profile rejects external entrypoints, options and shell syntax',()=>{
 for(const command of ['node --test ../a.mjs','node --test /tmp/a.mjs','node --test --import=a.mjs','node --test a.mjs; echo ok','node --test a.js'])assert.throws(()=>checkpointTestInvocation(command,'/sandbox'),/CHECKPOINT_TEST_COMMAND_INVALID/);
 assert.equal(checkpointTestInvocation('node --test unit/a.mjs','/sandbox').profile,'node-permission-workspace-v1');
});
test('actual Node permission mode reads workspace but rejects external files, writes and child processes',t=>{
 const root=mkdtempSync(join(tmpdir(),'checkpoint-profile-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const workspace=join(root,'workspace');mkdirSync(workspace);writeFileSync(join(root,'external.json'),'secret fixture');writeFileSync(join(workspace,'input.txt'),'input');
 const code=`import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import cp from 'node:child_process';test('confined',()=>{assert.equal(fs.readFileSync('input.txt','utf8'),'input');assert.throws(()=>fs.readFileSync('../external.json'),{code:'ERR_ACCESS_DENIED'});assert.throws(()=>fs.writeFileSync('extra.txt','x'),{code:'ERR_ACCESS_DENIED'});assert.throws(()=>cp.spawn('node',['-v']),{code:'ERR_ACCESS_DENIED'});});`;
 writeFileSync(join(workspace,'unit.mjs'),code);const profile=checkpointTestInvocation('node --test unit.mjs',workspace);
 const result=spawnSync(process.execPath,profile.args,{cwd:workspace,env:profile.env,encoding:'utf8'});assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
});
