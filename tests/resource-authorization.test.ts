import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import type { HumanPrincipal, Principal } from '../apps/api/src/identity-types.ts';

assert.equal(process.env.SIMULATED_INTEGRATION, 'pglite', 'Use scripts/test-integration.mjs for an isolated database');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(process.env.DATABASE_URL!).hostname));
let db: pg.Pool;
const modulePath = '../apps/api/src/resource-authorization.ts';
const authorization = await import(modulePath).catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return { resolveProjectDepartments: async () => null, resolveRunDepartments: async () => null,
    requireResource: async () => { throw Object.assign(Error('missing resource authorization'), { status: 404 }); },
    requireDepartments: async () => { throw Object.assign(Error('missing resource authorization'), { status: 404 }); },
    visibleProjectIds: async () => [], visibleResourceQuery: () => ({ text: 'SELECT id FROM projects WHERE false', values: [] }) };
});
const actor = (id = 'member', overrides: Partial<HumanPrincipal> = {}): HumanPrincipal => ({ kind: 'human', userId: id, issuer: 'https://issuer.example',
  subject: id, sessionId: `session-${id}`, sessionEpoch: 0, orgRole: id === 'admin' ? 'admin' : id === 'auditor' ? 'auditor' : 'member',
  authenticatedAt: '2026-10-20T00:00:00Z', ...overrides });
const denied = (work: Promise<unknown>) => assert.rejects(work, (error: any) => error.status === 404 && error.code === 'RESOURCE_NOT_FOUND');
const requireResource = (kind: string, id: string, principal: Principal = actor(), level = 'viewer', options = {}) =>
  authorization.requireResource(db, principal, { kind, id }, level, options);
const grant = (department: string, role = 'viewer', approve = false, user = 'member') => db.query(`INSERT INTO department_memberships(department_id,user_id,role,can_approve)
  VALUES($1,$2,$3,$4) ON CONFLICT(department_id,user_id) DO UPDATE SET role=EXCLUDED.role,can_approve=EXCLUDED.can_approve,version=department_memberships.version+1`, [department,user,role,approve]);
async function project(id: string, departments: string[], overrides: Record<string, unknown> = {}) {
  const policy = overrides.policy ?? { allowedDepartmentIds: departments };
  const plan = overrides.plan ?? { agents: departments.map((department, index) => ({ id: `agent-${index}`, sourceDepartmentId: department, sourceAgentId: `employee-${index}` })) };
  await db.query(`INSERT INTO projects(id,department_id,department_version,department_name,requirement,policy,plan,source)
    VALUES($1,$2,1,'Fixture','Synthetic authorization fixture',$3,$4,'test')`, [id, departments[0] ?? 'A',policy,plan]);
}
async function run(id: string, projectId: string, departments: string[]) {
  await db.query("INSERT INTO project_runs(id,project_id,project_version,status,snapshot,department_ids,attempt) VALUES($1,$2,1,'completed',$3,$4,(SELECT count(*)+1 FROM project_runs WHERE project_id=$2))",
    [id,projectId,{ departmentId: 'A', departmentIds: ['A'] },departments]);
}
async function cost(id: string, runId: string | null, projectId: string | null, departmentId: string | null, reservation = false) {
  if (reservation) await db.query(`INSERT INTO model_reservations(id,model_id,run_id,project_id,department_id,purpose,amount,input_rate,output_rate)
    VALUES($1,'model',$2,$3,$4,'test',0,0,0)`, [id,runId,projectId,departmentId]);
  else await db.query(`INSERT INTO usage(id,model_id,run_id,project_id,department_id,input_tokens,output_tokens,cost,purpose)
    VALUES($1,'model',$2,$3,$4,0,0,0,'test')`, [id,runId,projectId,departmentId]);
}
before(async () => { const database = await import('../apps/api/src/db.ts'); db = database.pool; await database.migrate(); });
after(async () => { await db?.end(); });
beforeEach(async () => {
  await db.query('TRUNCATE departments,human_users,models,work_file_snapshots,knowledge_spaces CASCADE');
  await db.query("INSERT INTO departments(id,data) VALUES('A','{}'),('B','{}'),('C','{}'),('archived','{}')");
  await db.query("UPDATE departments SET deleted_at=now() WHERE id='archived'");
  await db.query("INSERT INTO models(id,data) VALUES('model','{}')");
  for (const id of ['member','admin','auditor','pending','disabled']) await db.query(`INSERT INTO human_users(id,issuer,subject,status,org_role)
    VALUES($1,'https://issuer.example',$1,$2,$3)`, [id,['pending','disabled'].includes(id) ? id : 'active',id === 'admin' ? 'admin' : id === 'auditor' ? 'auditor' : 'member']);
  await grant('A'); await project('p-a',['A']); await project('p-ab',['A','B']); await project('p-c',['C']);
  await run('r-a','p-a',['A']); await run('r-ab','p-ab',['B','A']);
});

test('project and run scope follows durable participating departments instead of a trace snapshot', async () => {
  assert.deepEqual(await authorization.resolveProjectDepartments(db,'p-ab'), ['A','B']);
  assert.deepEqual(await authorization.resolveRunDepartments(db,'r-ab'), ['A','B']);
  assert.equal(await authorization.resolveRunDepartments(db,'trace-only'), null);
  assert.equal(await authorization.resolveProjectDepartments(db,'missing'), null);
});

test('a principal with only the primary department cannot read a cross-department object', async () => {
  await requireResource('project','p-a'); await denied(requireResource('project','p-ab')); await denied(requireResource('run','r-ab'));
  await grant('B'); await requireResource('project','p-ab'); await requireResource('run','r-ab');
  await denied(requireResource('project','p-ab',actor(),'operator'));
  await grant('A','operator'); await grant('B','operator'); await requireResource('project','p-ab',actor(),'operator');
  await denied(requireResource('project','p-ab',actor(),'manager'));
  await grant('A','manager'); await grant('B','manager'); await requireResource('project','p-ab',actor(),'manager');
});

test('tool approval requires operator or manager and approval permission in every department', async () => {
  await grant('A','operator',true); await grant('B','operator',false);
  await denied(authorization.requireDepartments(db,actor(),['B','A'],'viewer',{ approve: true }));
  await grant('B','viewer',true); await denied(authorization.requireDepartments(db,actor(),['A','B'],'viewer',{ approve: true }));
  await grant('B','manager',true); await authorization.requireDepartments(db,actor(),['B','A'],'viewer',{ approve: true });
  await db.query("INSERT INTO tool_approvals(id,run_id,agent_id,tool,arguments) VALUES('approve','r-ab','agent','tool','{}')");
  await requireResource('approval','approve',actor(),'viewer',{ approve: true });
  await db.query("UPDATE department_memberships SET can_approve=false WHERE department_id='B'");
  await denied(requireResource('approval','approve',actor(),'operator',{ approve: true }));
});

test('current user status role issuer subject and epoch override trusted but stale identity snapshots', async () => {
  await requireResource('project','p-ab',actor('admin'));
  for (const principal of [actor('pending'),actor('disabled'),actor('auditor'),actor('missing'),actor('member',{ orgRole:'admin' }),
    actor('admin',{ issuer:'https://other.example' }),actor('admin',{ subject:'another' }),actor('admin',{ sessionEpoch:1 }),
    { kind:'device',deviceId:'d' },{ kind:'system',service:'worker' }] as Principal[]) await denied(requireResource('project','p-a',principal));
  await db.query("UPDATE human_users SET status='disabled' WHERE id='admin'"); await denied(requireResource('project','p-ab',actor('admin')));
  await requireResource('project','p-ab',{ kind:'local-owner' });
});

test('malformed or inconsistent project ownership stays admin-only without granting empty scopes', async () => {
  const broken = [
    ['no-policy',{}], ['empty-policy',{allowedDepartmentIds:[]}], ['duplicate-policy',{allowedDepartmentIds:['A','A']}],
    ['wrong-primary',{allowedDepartmentIds:['B']}], ['extra-department',{allowedDepartmentIds:['A','B']}],
    ['bad-type',{allowedDepartmentIds:['A',1]}], ['null-policy',[]],
  ] as const;
  for (const [id,policy] of broken) { await project(id,['A'],{policy}); assert.equal(await authorization.resolveProjectDepartments(db,id),null); await denied(requireResource('project',id)); await requireResource('project',id,actor('admin')); }
  for (const [id,plan] of [['empty-agents',{agents:[]}],['bad-agents',{agents:{}}],['partial-source',{agents:[{id:'x',sourceAgentId:'x'}]}],['foreign-source',{agents:[{sourceDepartmentId:'B',sourceAgentId:'x'}]}]] as const) {
    await project(id,['A'],{plan}); await denied(requireResource('project',id));
  }
  await project('missing-department',['A','gone']); await project('archived-project',['A','archived']);
  await denied(requireResource('project','missing-department')); await denied(requireResource('project','archived-project'));
  await project('legacy-primary',['A'],{plan:{agents:[{id:'original-agent'}]}}); await requireResource('project','legacy-primary');
  await denied(authorization.requireDepartments(db,actor(),[],'viewer'));
  await denied(authorization.requireDepartments(db,actor(),['A','A'],'viewer'));
});

test('runs with empty duplicate or conflicting department sets do not inherit primary access', async () => {
  for (const [id,departments] of [['empty',[]],['duplicate',['A','A']],['conflict',['A']],['unknown',['A','C']]] as const) {
    await run(id,'p-ab',[...departments]); assert.equal(await authorization.resolveRunDepartments(db,id),null);
    await denied(requireResource('run',id)); await requireResource('run',id,actor('admin'));
  }
  await denied(requireResource('run','trace-only',actor('admin'))); await denied(requireResource('project','missing',{kind:'local-owner'}));
  await denied(authorization.requireResource(db,actor(),{kind:'project',id:'p-ab',departmentId:'A'},'viewer'));
});

test('every resolved project department must exist and remain unarchived even when membership is retained', async () => {
  await project('missing-scope',['A','missing']);
  assert.equal(await authorization.resolveProjectDepartments(db,'missing-scope'),null);
  await project('archived-scope',['A','archived']); await grant('archived');
  await denied(requireResource('project','archived-scope'));
  assert.equal(await authorization.resolveProjectDepartments(db,'archived-scope'),null);
  await requireResource('project','archived-scope',actor('admin'));
});

test('partial or malformed employee provenance cannot create a member-readable project scope', async () => {
  for (const [id,agent] of [['only-department',{sourceDepartmentId:'A'}],['null-employee',{sourceDepartmentId:'A',sourceAgentId:null}],['blank-employee',{sourceDepartmentId:'A',sourceAgentId:''}]] as const) {
    await project(id,['A'],{plan:{agents:[agent]}}); await denied(requireResource('project',id));
  }
});

test('approvals and work files inherit the complete run scope while unbound old files stay private', async () => {
  await db.query("INSERT INTO tool_approvals(id,run_id,agent_id,tool,arguments) VALUES('approval','r-ab','agent','tool','{}')");
  await db.query("INSERT INTO work_file_snapshots(id,name,files,bytes,source_run_id) VALUES('file','fixture','[]',0,'r-ab'),('legacy','fixture','[]',0,NULL),('broken-file','fixture','[]',0,'trace-only')");
  await denied(requireResource('approval','approval')); await denied(requireResource('workFile','file'));
  await grant('B'); await requireResource('approval','approval'); await requireResource('workFile','file');
  for (const id of ['legacy','broken-file']) { await denied(requireResource('workFile',id)); await requireResource('workFile',id,actor('admin')); }
  await denied(requireResource('workFile','missing',actor('admin')));
});

test('knowledge only grants current department scope and does not treat AI employee grants as human membership', async () => {
  for (const [id,scope,department] of [['ks-a','department','A'],['ks-b','department','B'],['company','company',null],['employee','employee','A'],['bad-scope','unexpected','A'],['bad-department','department',null],['deleted','department','A']]) {
    await db.query("INSERT INTO knowledge_spaces(id,name,scope,department_id,agent_ids) VALUES($1,'fixture',$2,$3,'[\"member\"]')",[id,scope,department]);
    await db.query("INSERT INTO knowledge_documents(id,space_id,title) VALUES($1,$2,'fixture')",[`doc-${id}`,id]);
  }
  await db.query("UPDATE knowledge_spaces SET deleted_at=now() WHERE id='deleted'");
  await requireResource('knowledgeSpace','ks-a'); await requireResource('knowledgeDocument','doc-ks-a');
  for (const id of ['ks-b','company','employee','bad-scope','bad-department','deleted']) { await denied(requireResource('knowledgeSpace',id)); await denied(requireResource('knowledgeDocument',`doc-${id}`)); await requireResource('knowledgeSpace',id,actor('admin')); }
  await db.query("UPDATE knowledge_documents SET deleted_at=now() WHERE id='doc-ks-a'"); await denied(requireResource('knowledgeDocument','doc-ks-a'));
  await denied(requireResource('knowledgeDocument','missing',actor('admin')));
});

test('cost provenance checks every nonempty anchor and rejects missing or ambiguous links', async () => {
  await cost('usage-run','r-ab','p-ab','A'); await cost('reservation-run','r-ab','p-ab','B',true);
  for (const id of ['usage-run','reservation-run']) await denied(requireResource('cost',id));
  await grant('B'); for (const id of ['usage-run','reservation-run']) await requireResource('cost',id);
  await cost('project-only',null,'p-a','A'); await cost('department-only',null,null,'A');
  await requireResource('cost','project-only'); await requireResource('cost','department-only');
  await cost('wrong-project','r-ab','p-a','A'); await cost('wrong-department','r-ab','p-ab','C');
  await cost('unknown-run','missing','p-a','A'); await cost('unbound',null,null,null);
  await cost('duplicate-id',null,null,'A'); await cost('duplicate-id',null,null,'B',true);
  for (const id of ['wrong-project','wrong-department','unknown-run','unbound','duplicate-id']) { await denied(requireResource('cost',id)); await requireResource('cost',id,actor('admin')); }
  await denied(requireResource('cost','missing',actor('admin')));
});

test('settleCall preserves receipt visibility for matching reservation and usage anchors without duplicating list rows', async () => {
  const { settleCall } = await import('../apps/api/src/cost-control.ts');
  for (const [id,runId,projectId,departmentId] of [
    ['receipt-run','r-a','p-a','A'],['receipt-run-null','r-a',null,null],['receipt-project',null,'p-a','A'],['receipt-department',null,null,'A'],
  ]) {
    await cost(id!,runId,projectId,departmentId,true); await requireResource('cost',id!);
    await settleCall(id!,10,20);
    assert.equal((await db.query('SELECT status FROM model_reservations WHERE id=$1',[id])).rows[0].status,'settled');
    await requireResource('cost',id!);
    const visible = authorization.visibleResourceQuery(actor(),'cost','viewer');
    assert.equal((await db.query<{id:string}>(visible.text,visible.values)).rows.filter(row=>row.id===id).length,1);
  }
  await cost('receipt-cross','r-ab','p-ab','A',true); await settleCall('receipt-cross',10,20);
  await denied(requireResource('cost','receipt-cross')); await grant('B'); await requireResource('cost','receipt-cross');
});

test('duplicate cost IDs remain concealed when settlement state identity or any nullable anchor differs', async () => {
  await db.query("INSERT INTO models(id,data) VALUES('other-model','{}')");
  for (const [id,change] of [
    ['state-pending',"status='pending'"],['state-uncertain',"status='uncertain'"],['state-released',"status='released'"],
    ['model-conflict',"model_id='other-model'"],['purpose-conflict',"purpose='another-operation'"],
    ['run-conflict',"run_id=NULL"],['project-conflict',"project_id=NULL"],['department-conflict',"department_id=NULL"],
  ]) {
    await cost(id!,'r-a','p-a','A'); await cost(id!,'r-a','p-a','A',true);
    await db.query("UPDATE model_reservations SET status='settled' WHERE id=$1",[id]);
    // Only literal fixture assignments vary; both rows otherwise have independently valid A ownership.
    await db.query(`UPDATE model_reservations SET ${change} WHERE id=$1`,[id]);
    await denied(requireResource('cost',id!)); await requireResource('cost',id!,actor('admin'));
    const visible = authorization.visibleResourceQuery(actor(),'cost','viewer');
    assert.equal((await db.query<{id:string}>(visible.text,visible.values)).rows.some(row=>row.id===id),false);
  }
});

test('shared SQL visibility filters before pagination and count without per-row authorization queries', async () => {
  await project('00-hidden',['C']); await project('zz-visible',['A']);
  const query = authorization.visibleResourceQuery(actor(),'project','viewer',{parameterOffset:1});
  const page = await db.query(`SELECT id FROM projects WHERE id IN (${query.text}) AND id>$1 ORDER BY id LIMIT 1`,['p-a',...query.values]);
  assert.deepEqual(page.rows.map(row=>row.id),['zz-visible']);
  const all = authorization.visibleResourceQuery(actor(),'project','viewer');
  assert.equal((await db.query(`SELECT count(*)::int n FROM projects WHERE id IN (${all.text})`,all.values)).rows[0].n,2);
  let queries=0; const counted = { query: (...args:any[]) => { queries++; return (db.query as any)(...args); } };
  assert.deepEqual(await authorization.visibleProjectIds(counted,actor(),'viewer'),['p-a','zz-visible']); assert.equal(queries,1);
  for (const [kind,id] of [['department','A'],['project','p-a'],['run','r-a']]) {
    const filter = authorization.visibleResourceQuery(actor(),kind,'viewer');
    assert.ok((await db.query<{id:string}>(filter.text,filter.values)).rows.some(row=>row.id===id));
  }
  const empty = authorization.visibleResourceQuery(actor('auditor'),'project','viewer'); assert.deepEqual((await db.query(empty.text,empty.values)).rows,[]);
});

test('revocation affects the next detail and list read without relying on session expiration', async () => {
  await grant('B'); await requireResource('run','r-ab'); assert.deepEqual(await authorization.visibleProjectIds(db,actor(),'viewer'),['p-a','p-ab']);
  await db.query("DELETE FROM department_memberships WHERE user_id='member' AND department_id='B'");
  await denied(requireResource('run','r-ab')); assert.deepEqual(await authorization.visibleProjectIds(db,actor(),'viewer'),['p-a']);
  await db.query("UPDATE human_users SET session_epoch=1 WHERE id='member'");
  await denied(requireResource('project','p-a')); assert.deepEqual(await authorization.visibleProjectIds(db,actor(),'viewer'),[]);
  await requireResource('project','p-a',actor('member',{sessionEpoch:1}));
  await db.query("UPDATE departments SET deleted_at=now() WHERE id='A'"); await denied(requireResource('department','A',actor('member',{sessionEpoch:1})));
});

test('invalid resource kinds levels identifiers and forged principals fail closed', async () => {
  await denied(requireResource('unknown','p-a')); await denied(requireResource('project','p-a',actor(),'owner'));
  await denied(requireResource('project',' p-a')); await denied(requireResource('project','p-a', {...actor(),actorId:'admin'} as any));
  await denied(requireResource('department','missing',actor('admin')));
  assert.throws(()=>authorization.visibleResourceQuery(actor(),'project','viewer',{parameterOffset:-1}));
});
