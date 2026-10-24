import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import { installProductTools } from './product-tools.mjs';
import { captureToolDefinition } from './tool-definition-effects.mjs';
import { nativeManifestId } from './native-capabilities.mjs';

const load = () => import('./runtime-tool-inventory.mjs');
const manifest = () => ({ format:'dsh-native-tools-v1',namespace:'fixture',package:'@company/fixture',version:'1.0.0',dshVersion:'0.1.5-rc.1',
  source:{kind:'company',reference:'fixture-private'},config:{},lockSha256:'a'.repeat(64),bundle:{sha256:'b'.repeat(64),codeSha256:'c'.repeat(64),metadataSha256:'d'.repeat(64),bytes:1},
  tools:[{name:'plugin__fixture__read',originalName:'read',description:'Fixture declaration only',parameters:{type:'object'},files:{read:['path'],write:[]}}] });

test('inventory uses the actual DSH registration with no model, agent, archive or execution and disposes normally', async () => {
  const { inspectRuntimeToolInventory } = await load();
  const inventory = await inspectRuntimeToolInventory({variant:'container'});
  assert.deepEqual(inventory.isolation,{modelAdapters:0,agents:0,persistence:false,executions:0,disposed:true});
  assert.equal(inventory.tools.filter(tool=>tool.name.startsWith('agent_teams_')).length,14);
  assert.ok(inventory.tools.some(tool=>tool.name==='skill' && tool.registrationBinding==='weiwu-employee-registry-v1'));
  assert.ok(inventory.tools.some(tool=>tool.name==='capability_search'));
  assert.ok(!inventory.tools.some(tool=>tool.name==='recovery_read'));
  assert.ok(Object.isFrozen(inventory) && Object.isFrozen(inventory.tools));
  const ctx=new Context(), fibers=[];
  try {
    for(const plugin of [SystemPrompt,Tools]){const fiber=ctx.plugin(plugin,{mode:'native'});fibers.push(fiber);await fiber.await();}
    const dispose=installProductTools(ctx,{snapshot:{agents:[]}});
    for(const schema of ctx.tools.schemas()){
      const actual=captureToolDefinition(ctx.tools.get(schema.name),'weiwu-coordinator-registry-v1');
      assert.equal(inventory.tools.find(tool=>tool.name===schema.name).definitionSha256,actual.definitionSha256);
    }
    dispose();
  }finally{for(const fiber of fibers.reverse())await fiber.dispose();}
});

test('variants preserve final definitions and independent inventories do not leak registrations',async()=>{
  const {inspectRuntimeToolInventory}=await load();
  const values=await Promise.all(['container','local','demo'].map(variant=>inspectRuntimeToolInventory({variant,includeRecovery:true})));
  const digest=(value,name)=>value.tools.find(tool=>tool.name===name).definitionSha256;
  assert.equal(new Set(values.map(value=>digest(value,'filesystem'))).size,3);
  assert.equal(new Set(values.map(value=>digest(value,'knowledge_search'))).size,1);
  assert.ok(values.every(value=>value.tools.some(tool=>tool.name==='recovery_read')));
  assert.equal(new Set(values.map(value=>value.release.sha256)).size,1);
  assert.ok(!(await inspectRuntimeToolInventory({variant:'container'})).tools.some(tool=>tool.name==='recovery_read'));
});

test('release fingerprint includes actual registered implementation bytes and exact installed package versions',async()=>{
  const {readRuntimeToolRelease}=await load(), release=await readRuntimeToolRelease();
  const file=release.files.find(item=>item.path==='services/agent-runtime/product-tools.mjs');
  assert.equal(file.sha256,createHash('sha256').update(readFileSync(new URL('./product-tools.mjs',import.meta.url))).digest('hex'));
  assert.equal(release.packages.find(item=>item.name==='@deepseek-ai/dsh-tools').version,'0.1.5-rc.1');
  assert.equal(release.packages.find(item=>item.name==='@nanmicoder/dsh-agent-teams').version,'0.1.20');
  for(const name of ['dsh-session-checkpoint-policy','dsh-session-persistence-jsonl'])
    assert.equal(release.packages.find(item=>item.name==='@deepseek-ai/'+name)?.version,'0.1.5-rc.1');
  for(const file of ['openshell-executor','native-plugin-worker','local-executor','sandbox-storage','checkpoint-test-profile'])
    assert.ok(release.files.some(item=>item.path===`apps/desktop/${file}.cjs`),file);
  assert.ok(release.files.some(item=>item.path==='apps/api/src/knowledge-store.ts'));
  assert.ok(release.files.some(item=>item.path==='services/agent-runtime/package-lock.json'));
  assert.match(release.sha256,/^[a-f0-9]{64}$/);
});

test('native inventory registers only the existing wrapper and validates identity without loading plugin code',async()=>{
  const {inspectRuntimeToolInventory}=await load(), value=manifest(), id=nativeManifestId(value);
  const inventory=await inspectRuntimeToolInventory({variant:'local',nativeBindings:[{id,manifest:value}]});
  const tool=inventory.tools.find(item=>item.name==='plugin__fixture__read');
  assert.equal(tool.description,value.tools[0].description+' 使用工作区相对路径；遵守批准的输入输出合同。');
  assert.equal(tool.nativeManifestId,id);assert.equal(inventory.isolation.executions,0);
  await assert.rejects(inspectRuntimeToolInventory({variant:'local',nativeBindings:[{id:'0'.repeat(64),manifest:value}]}),/NATIVE|INVENTORY/);
  await assert.rejects(inspectRuntimeToolInventory({variant:'local',nativeBindings:[{id,manifest:value},{id,manifest:value}]}),/NATIVE|INVENTORY/);
});

test('inventory rejects custom loading, business state, invalid variants and oversized or accessor input',async()=>{
  const {inspectRuntimeToolInventory}=await load();
  for(const extra of [{loadPlugin:()=>{}},{archive:{}},{sessionRoot:'C:/production'},{variant:'remote'},{nativeBindings:new Array(257).fill({})}])
    await assert.rejects(inspectRuntimeToolInventory({variant:'container',...extra}),/INVENTORY/);
  let invoked=false;
  await assert.rejects(inspectRuntimeToolInventory({variant:'container',get nativeBindings(){invoked=true;return [];}}),/INVENTORY/);
  assert.equal(invoked,false);
});
