import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import pg from 'pg';
import {createArchiveWriterManager} from '../services/agent-runtime/archive-writer-scope.mjs';
import {effectDigest} from '../services/agent-runtime/tool-effects.mjs';
import {embeddingVersion} from '../services/embedding/local.mjs';

assert.equal(process.env.SIMULATED_INTEGRATION,'pglite','Use isolated integration runner');
const load=()=>import('../apps/api/src/tool-effect-production.ts');
const runId='e338326f-d3b6-455b-920e-83d21bcae3c0';
let db:pg.Pool,root:string;
const content='release check: verify the actual result',sha256=createHash('sha256').update(content).digest('hex');
const manifest={format:'document-versions-v2',retrieval:{mode:'keyword'},documents:[{documentId:'method',version:1,title:'release check',spaceId:'space',sha256,source:{skillName:'release-check'},chunkCount:1}],agentDocuments:{reader:['method'],other:[]}};
before(async()=>{
  root=mkdtempSync(join(tmpdir(),'effect-production-'));db=new pg.Pool({connectionString:process.env.DATABASE_URL});
  await db.query(`CREATE TABLE knowledge_revisions(document_id text,version int,sha256 text,content text);
    CREATE TABLE knowledge_chunks(id text,document_id text,version int,line_start int,line_end int,content text,tokens jsonb);`);
  await db.query('INSERT INTO knowledge_revisions VALUES($1,1,$2,$3)',['method',sha256,content]);
  await db.query('INSERT INTO knowledge_chunks VALUES($1,$2,1,1,1,$3,$4)',['chunk','method',content,JSON.stringify(['release','check','actual'])]);
});
after(async()=>{await db?.end();if(root){assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.match(root,/effect-production-/);rmSync(root,{recursive:true,force:true});}});
function options(){return {db,writers:createArchiveWriterManager({traceRoot:join(root,'runs')}),variant:'container' as const,knowledgeMode:'keyword' as const};}

test('production factory binds the real knowledge callback and only audited source semantics',async()=>{
  const {createProductionToolEffects}=await load(),binding=await createProductionToolEffects(options());
  const candidates=await binding.sources.listBuiltinCandidates(),byName=new Map(candidates.map(c=>[c.toolName,c]));
  for(const name of ['knowledge_read','knowledge_search','skill','capability_search']){
    assert.equal(byName.get(name)?.effect,'read',name);assert.equal(byName.get(name)?.cost.kind,'free');
  }
  for(const name of ['agent_teams_create','agent_teams_approve','agent_teams_status','agent_teams_claim_task','agent_teams_update_task','agent_teams_send_message','capability_use']){
    assert.equal(byName.get(name)?.effect,'workspace',name);assert.equal(byName.get(name)?.retry,'never');
  }
  for(const name of ['terminal','artifact_write','mcp_call_readonly','browser_read'])assert.equal(byName.get(name)?.effect,'unknown');
  const authority=binding.authorityForRun(runId,'owner');
  assert.ok(authority.runtimeOperations);assert.equal(typeof authority.withAdmission,'function');
  await authority.assertRuntimeBindings({queryKnowledge:binding.queryKnowledge,snapshot:{knowledge:manifest,effectContractVersion:1,effectContracts:[byName.get('knowledge_read')]}});
  await assert.rejects(authority.assertRuntimeBindings({queryKnowledge:async()=>[],snapshot:{knowledge:manifest}}),/RUNTIME_BINDING/);
  await assert.rejects(authority.assertRuntimeBindings({queryKnowledge:binding.queryKnowledge,snapshot:{knowledge:manifest,executionTarget:{kind:'local'}}}),/RUNTIME_BINDING/);
  await assert.rejects(createProductionToolEffects({...options(),queryKnowledge:async()=>[]} as never),/PRODUCTION_OPTIONS/);
  assert.equal(Reflect.set(byName.get('knowledge_read')!,'effect','external'),false);
});

test('bound keyword reads actual fixed revisions and cannot fall back to a changed mode or legacy manifest',async()=>{
  const {createProductionToolEffects}=await load(),client=await db.connect();
  try{
    const readonlyDb={query:client.query.bind(client),connect:db.connect.bind(db)} as pg.Pool;
    const binding=await createProductionToolEffects({...options(),db:readonlyDb});
    await client.query('BEGIN READ ONLY');
    const found=await binding.queryKnowledge(manifest,'reader','search','release');
    assert.equal(found.length,1);assert.equal(found[0].content,content);
    assert.equal((await binding.queryKnowledge(manifest,'reader','read','chunk')).content,content);
    assert.equal((await binding.queryKnowledge(manifest,'reader','skill','method')).sha256,sha256);
    assert.deepEqual(await binding.queryKnowledge(manifest,'other','search','release'),[]);
    await assert.rejects(binding.queryKnowledge({...manifest,retrieval:{mode:'hybrid',embeddingVersion}},'reader','search','release'),/RUNTIME_BINDING/);
    await assert.rejects(binding.queryKnowledge({reader:[]},'reader','read','chunk'),/RUNTIME_BINDING/);
    await client.query('ROLLBACK');
  }finally{client.release();}
});

test('hybrid profile fixes embedding version and is never advertised as a read-only keyword operation',async()=>{
  const {createProductionToolEffects}=await load(),binding=await createProductionToolEffects({...options(),knowledgeMode:'hybrid'});
  const candidates=await binding.sources.listBuiltinCandidates(),search=candidates.find(c=>c.toolName==='knowledge_search')!;
  assert.equal(search.effect,'workspace');assert.equal(search.retry,'never');
  assert.ok(search.evidenceRefs.includes('embedding:'+embeddingVersion));
  const authority=binding.authorityForRun(runId,'owner'),snapshot={knowledge:{...manifest,retrieval:{mode:'hybrid',embeddingVersion}},effectContractVersion:1,effectContracts:[search]};
  await authority.assertRuntimeBindings({queryKnowledge:binding.queryKnowledge,snapshot});
  await assert.rejects(authority.assertRuntimeBindings({queryKnowledge:binding.queryKnowledge,snapshot:{...snapshot,knowledge:{...snapshot.knowledge,retrieval:{mode:'hybrid',embeddingVersion:'changed'}}}}),/RUNTIME_BINDING/);
  const keyword=await createProductionToolEffects(options()),old=(await keyword.sources.listBuiltinCandidates()).find(c=>c.toolName==='knowledge_search')!;
  assert.notEqual(effectDigest(search),effectDigest(old));
  assert.notEqual(search.namespace,old.namespace);
});
