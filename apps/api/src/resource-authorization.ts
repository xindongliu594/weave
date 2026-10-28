import type { IdentityQueryExecutor } from './identity-schema.ts';
import { identityText, principalKey, type Principal } from './identity-types.ts';
import { AppError } from './provider.ts';

export type DepartmentLevel = 'viewer' | 'operator' | 'manager';
export type ResourceKind = 'department' | 'project' | 'run' | 'approval' | 'workFile' | 'knowledgeSpace' | 'knowledgeDocument' | 'cost';
export type ResourceRef = { kind: ResourceKind; id: string };
type AuthorityOptions = { approve?: boolean };
type QueryOptions = AuthorityOptions & { parameterOffset?: number };
const levels = { viewer: ['viewer','operator','manager'], operator: ['operator','manager'], manager: ['manager'] };
const kinds: ResourceKind[] = ['department','project','run','approval','workFile','knowledgeSpace','knowledgeDocument','cost'];
const concealed = () => new AppError(404, '资源不存在或不可访问。', 'RESOURCE_NOT_FOUND');
const validId = (value: unknown): value is string => identityText(value,128);
const sqlId = (column: string) => `${column} IS NOT NULL AND ${column}<>'' AND length(${column})<=128 AND ${column}=btrim(${column}) AND ${column}!~'[[:cntrl:]]'`;

// One SQL scope definition serves detail checks and predicates before LIMIT/count. NULL means admin-only.
const planScopes = (source:string) => `SELECT p.id,p.id AS project_id,
  CASE WHEN ${sqlId('p.department_id')}
    AND jsonb_typeof(p.policy)='object' AND jsonb_typeof(p.policy->'allowedDepartmentIds')='array'
    AND cardinality(policy.ids) BETWEEN 1 AND 100
    AND cardinality(policy.ids)=(SELECT count(DISTINCT id) FROM unnest(policy.ids) id)
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(safe.policy) value WHERE jsonb_typeof(value)<>'string')
    AND NOT EXISTS(SELECT 1 FROM unnest(policy.ids) id WHERE NOT (${sqlId('id')}))
    AND jsonb_typeof(p.plan)='object' AND jsonb_typeof(p.plan->'agents')='array' AND jsonb_array_length(safe.agents)>0
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(safe.agents) agent WHERE jsonb_typeof(agent)<>'object'
      OR (agent ? 'sourceDepartmentId' AND (jsonb_typeof(agent->'sourceDepartmentId')<>'string'
        OR NOT (${sqlId("agent->>'sourceDepartmentId'")})))
      OR ((agent ? 'sourceAgentId')<>(agent ? 'sourceDepartmentId'))
      OR (agent ? 'sourceAgentId' AND (jsonb_typeof(agent->'sourceAgentId')<>'string' OR NOT (${sqlId("agent->>'sourceAgentId'")}))))
    AND policy.ids=sources.ids
    AND NOT EXISTS(SELECT 1 FROM unnest(policy.ids) required(id) WHERE NOT EXISTS(SELECT 1 FROM departments d WHERE d.id=required.id AND d.deleted_at IS NULL))
  THEN policy.ids ELSE NULL::text[] END AS departments
  FROM ${source} p
  CROSS JOIN LATERAL(SELECT
    CASE WHEN jsonb_typeof(p.policy->'allowedDepartmentIds')='array' THEN p.policy->'allowedDepartmentIds' ELSE '[]'::jsonb END AS policy,
    CASE WHEN jsonb_typeof(p.plan->'agents')='array' THEN p.plan->'agents' ELSE '[]'::jsonb END AS agents) safe
  CROSS JOIN LATERAL(SELECT ARRAY(SELECT jsonb_array_elements_text(safe.policy) ORDER BY 1) AS ids) policy
  CROSS JOIN LATERAL(SELECT ARRAY(SELECT DISTINCT id FROM (
    SELECT p.department_id AS id UNION ALL SELECT COALESCE(agent->>'sourceDepartmentId',p.department_id) FROM jsonb_array_elements(safe.agents) agent
  ) source_ids ORDER BY id) AS ids) sources`;
const projectScopes=planScopes('projects');
const historicalScopes=planScopes(`(SELECT h.project_id AS id,p.department_id,h.plan,h.policy FROM plan_versions h JOIN projects p ON p.id=h.project_id)`);
// The persisted run department set must agree with its fixed plan version. Only
// legacy runs still on the identical current version can use that current row.
const runPlanScopes=planScopes(`(SELECT r.id,p.department_id,
  CASE WHEN h.project_id IS NOT NULL THEN h.plan WHEN p.version=r.project_version THEN p.plan END AS plan,
  CASE WHEN h.project_id IS NOT NULL THEN h.policy WHEN p.version=r.project_version THEN p.policy END AS policy
  FROM project_runs r JOIN projects p ON p.id=r.project_id LEFT JOIN plan_versions h ON h.project_id=r.project_id AND h.version=r.project_version)`);
const runScopes = `SELECT r.id,r.project_id,CASE WHEN p.departments IS NOT NULL AND cardinality(r.department_ids)>0
  AND cardinality(r.department_ids)=(SELECT count(DISTINCT id) FROM unnest(r.department_ids) id)
  AND ARRAY(SELECT id FROM unnest(r.department_ids) id ORDER BY id)=p.departments
  THEN p.departments ELSE NULL::text[] END AS departments
  FROM project_runs r LEFT JOIN resource_run_plans p ON p.id=r.id`;
const ctes = `WITH resource_projects AS (${projectScopes}), resource_run_plans AS (${runPlanScopes}), resource_runs AS (${runScopes})`;
const materialCtes=`${ctes}, resource_history AS (${historicalScopes}), resource_material AS (
  SELECT id AS project_id,departments FROM resource_projects UNION ALL SELECT id,departments FROM resource_history
  UNION ALL SELECT project_id,departments FROM resource_runs)`;
const jsonArray=(value:string)=>`CASE WHEN jsonb_typeof(${value})='array' THEN ${value} ELSE '[]'::jsonb END`;
const boundsShape=(value:string)=>`jsonb_typeof(${value})='object' AND ${value}->'adminOnly'='false'::jsonb AND ${value}->'private'='false'::jsonb
  AND jsonb_typeof(${value}->'requiredDepartmentIds')='array' AND jsonb_typeof(${value}->'refs')='array'
  AND NOT EXISTS(SELECT 1 FROM jsonb_object_keys(CASE WHEN jsonb_typeof(${value})='object' THEN ${value} ELSE '{}'::jsonb END) key WHERE key NOT IN ('requiredDepartmentIds','adminOnly','private','refs'))
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(${jsonArray(`${value}->'requiredDepartmentIds'`)}) department WHERE jsonb_typeof(department)<>'string')
  AND jsonb_array_length(${jsonArray(`${value}->'refs'`)})<=200`;
const embeddedSource=(item:string,run:string)=>`(${boundsShape(`${item}->'sourceBounds'`)})
  AND (${item}->'sourceBounds'->'requiredDepartmentIds') <@ (${run}.source_bounds->'requiredDepartmentIds')
  AND (${item}->'sourceBounds'->'refs') <@ (${run}.source_bounds->'refs')`;
// Only immutable file-backed run inputs are opened here. Knowledge revisions and
// arbitrary user runInputs remain outside this consumer slice.
const importedRunBody=(r:string)=>`COALESCE(jsonb_typeof(${r}.snapshot->'knowledge'->'documents'),'array')='array'
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(${jsonArray(`${r}.snapshot->'knowledge'->'documents'`)}) doc WHERE NOT EXISTS(
    SELECT 1 FROM knowledge_revisions revision JOIN knowledge_documents document ON document.id=revision.document_id
    WHERE revision.document_id=doc->>'documentId' AND revision.version::text=doc->>'version' AND jsonb_typeof(doc->'version')='number'
      AND revision.sha256=doc->>'sha256' AND document.space_id=doc->>'spaceId'
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(${jsonArray(`${r}.source_bounds->'refs'`)}) ref
        WHERE ref->>'kind'='knowledge-revision' AND ref->>'id'=revision.document_id AND ref->>'version'=revision.version::text AND ref->>'sha256'=revision.sha256)))
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(${jsonArray(`${r}.snapshot->'knowledge'->'runInputs'`)}) input
    WHERE NOT ((${embeddedSource('input',r)}) AND EXISTS(SELECT 1 FROM work_file_snapshots file,
      LATERAL jsonb_array_elements(${jsonArray('file.files')}) part WHERE file.id=input->'sourceFile'->>'snapshotId'
      AND part->>'path'=input->'sourceFile'->>'path' AND part->>'sha256'=input->'sourceFile'->>'sha256'
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(${jsonArray(`${r}.source_bounds->'refs'`)}) ref WHERE ref->>'kind'='file' AND ref->>'id'=file.id)
      AND jsonb_typeof(input->'chunks')='array' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(${jsonArray("input->'chunks'")}) chunk
        WHERE chunk->>'sha256' IS DISTINCT FROM encode(sha256(convert_to(part->>'text','UTF8')),'hex')))) IS TRUE)
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(${jsonArray(`${r}.snapshot->'importedFiles'`)}) input
    WHERE NOT ((${embeddedSource('input',r)}) AND EXISTS(SELECT 1 FROM work_file_snapshots file,
      LATERAL jsonb_array_elements(${jsonArray('file.files')}) part WHERE file.id=input->>'snapshotId'
      AND part->>'path'=input->>'path' AND part->>'sha256'=input->>'sha256'
      AND part->>'sha256'=encode(sha256(convert_to(input->>'content','UTF8')),'hex')
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(${jsonArray(`${r}.source_bounds->'refs'`)}) ref WHERE ref->>'kind'='file' AND ref->>'id'=file.id))) IS TRUE)
  AND COALESCE(jsonb_typeof(${r}.snapshot->'knowledge'->'runInputs'),'array')='array'
  AND COALESCE(jsonb_typeof(${r}.snapshot->'importedFiles'),'array')='array'
  AND (${r}.snapshot->'recovery'->>'sourceRunId' IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(${jsonArray(`${r}.source_bounds->'refs'`)}) ref
    WHERE ref->>'kind'='run' AND ref->>'id'=${r}.snapshot->'recovery'->>'sourceRunId'))`;
const sourceCtes=`${ctes}, source_nodes AS (
  SELECT 'run'::text AS kind,r.id,r.project_version::text AS version,encode(sha256(convert_to(r.snapshot::text,'UTF8')),'hex') AS sha256,
    scope.departments,r.source_bounds AS bounds,NULL::text AS source_run_id,
    (r.authority_kind IN ('human','local-owner') AND (${importedRunBody('r')})) AS body_valid
  FROM project_runs r JOIN resource_runs scope ON scope.id=r.id
  UNION ALL SELECT 'file',f.id,NULL,encode(sha256(convert_to(f.files::text,'UTF8')),'hex'),scope.departments,f.source_bounds,f.source_run_id,jsonb_typeof(f.files)='array'
  FROM work_file_snapshots f LEFT JOIN resource_runs scope ON scope.id=f.source_run_id
  UNION ALL SELECT 'knowledge-revision',r.document_id,r.version::text,r.sha256,
    ARRAY(SELECT DISTINCT department FROM (SELECT s.department_id AS department UNION ALL SELECT jsonb_array_elements_text(${jsonArray("r.source_bounds->'requiredDepartmentIds'")})) departments WHERE department IS NOT NULL ORDER BY department),
    r.source_bounds,NULL::text,
    s.scope='department' AND s.deleted_at IS NULL AND d.deleted_at IS NULL AND s.department_id IS NOT NULL
      AND r.sha256=encode(sha256(convert_to(r.content,'UTF8')),'hex')
      AND (r.source->>'runId' IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(${jsonArray("r.source_bounds->'refs'")}) ref WHERE ref->>'kind'='run' AND ref->>'id'=r.source->>'runId'))
  FROM knowledge_revisions r JOIN knowledge_documents d ON d.id=r.document_id JOIN knowledge_spaces s ON s.id=d.space_id
  UNION ALL
  SELECT 'candidate',c.id,c.version::text,encode(sha256(convert_to(c.content,'UTF8')),'hex'),
    ARRAY(SELECT DISTINCT department FROM (SELECT s.department_id AS department UNION ALL SELECT jsonb_array_elements_text(${jsonArray("c.source_bounds->'requiredDepartmentIds'")})) ids WHERE department IS NOT NULL ORDER BY department),c.source_bounds,NULL,
    s.scope='department' AND s.deleted_at IS NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(${jsonArray("c.source_bounds->'refs'")}) ref WHERE ref->>'kind'='run' AND ref->>'id'=c.run_id)
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(${jsonArray("c.source_bounds->'refs'")}) ref WHERE ref->>'kind'='knowledge-revision' AND ref->>'id'=c.document_id AND ref->>'version'=c.source_version::text AND ref->>'sha256'=c.source_hash)
      AND (c.reuse_evidence IS NULL OR (jsonb_typeof(COALESCE(c.reuse_evidence->'workReferences',c.reuse_evidence->'works'))='array'
        AND jsonb_array_length(${jsonArray("COALESCE(c.reuse_evidence->'workReferences',c.reuse_evidence->'works')")}) BETWEEN 1 AND 100
        AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(${jsonArray("COALESCE(c.reuse_evidence->'workReferences',c.reuse_evidence->'works')")}) work
          WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(${jsonArray("c.source_bounds->'refs'")}) ref WHERE ref->>'kind'='run' AND ref->>'id'=work->>'runId'))))
  FROM automation_knowledge_candidates c JOIN knowledge_spaces s ON s.id=c.space_id
), source_base AS (SELECT node.*, (node.departments IS NOT NULL AND (${boundsShape('node.bounds')})
  AND ARRAY(SELECT jsonb_array_elements_text(${jsonArray("node.bounds->'requiredDepartmentIds'")}) ORDER BY 1)=node.departments
  AND NOT EXISTS(SELECT 1 FROM unnest(node.departments) department WHERE NOT EXISTS(SELECT 1 FROM departments d WHERE d.id=department AND d.deleted_at IS NULL))
  AND node.body_valid AND (node.kind<>'file' OR EXISTS(SELECT 1 FROM jsonb_array_elements(${jsonArray("node.bounds->'refs'")}) ref
    WHERE ref->>'kind'='run' AND ref->>'id'=node.source_run_id))) IS TRUE AS valid FROM source_nodes node),
source_closed AS (SELECT node.* FROM source_base node WHERE node.valid AND NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(${jsonArray("node.bounds->'refs'")}) ref WHERE NOT EXISTS(
    SELECT 1 FROM source_base ancestor WHERE ancestor.valid AND ancestor.kind=ref->>'kind' AND ancestor.id=ref->>'id'
      AND ancestor.sha256=ref->>'sha256' AND jsonb_typeof(ref->'id')='string'
      AND NOT EXISTS(SELECT 1 FROM jsonb_object_keys(CASE WHEN jsonb_typeof(ref)='object' THEN ref ELSE '{}'::jsonb END) key WHERE key NOT IN ('kind','id','sha256','version'))
      AND (ancestor.kind='file' AND NOT(ref ? 'version') OR ancestor.kind IN ('run','knowledge-revision') AND jsonb_typeof(ref->'version')='number' AND ancestor.version=ref->>'version')
      AND NOT(ancestor.kind=node.kind AND ancestor.id=node.id AND ancestor.version IS NOT DISTINCT FROM node.version)
      AND ancestor.departments <@ node.departments AND (ancestor.bounds->'refs') <@ (node.bounds->'refs')))),
safe_sources AS (SELECT node.* FROM source_closed node WHERE NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(${jsonArray("node.bounds->'refs'")}) ref WHERE NOT EXISTS(
    SELECT 1 FROM source_closed ancestor WHERE ancestor.kind=ref->>'kind' AND ancestor.id=ref->>'id'
      AND ancestor.sha256=ref->>'sha256' AND ancestor.version IS NOT DISTINCT FROM ref->>'version')))`;

/** Every ancestor must carry its own transitive closure and exclude itself.
 * A cycle cannot meet both rules. Root-only closure is insufficient. No graph reads per result. */
export function safeSourceQuery(kind:'run'|'file'|'knowledge-revision'|'candidate'){
  return `${sourceCtes} SELECT id,version,departments,bounds FROM safe_sources WHERE kind='${kind}'`;
}
export function visibleCandidateQuery(principal:Principal,level:DepartmentLevel='viewer',options:QueryOptions={}){
  const values:unknown[]=[],permitted=predicate(principal,level,options,values,'resource.departments');
  const administrative=principal.kind==='local-owner'||principal.kind==='human'&&principal.orgRole==='admin';
  return {text:`${sourceCtes} SELECT resource.id,resource.departments FROM ${administrative?'source_nodes':'safe_sources'} resource WHERE resource.kind='candidate' AND ${permitted}`,values};
}
export async function requireCandidate(db:IdentityQueryExecutor,principal:Principal,id:string,level:DepartmentLevel='viewer'){
  if(!validId(id))throw concealed();const visible=visibleCandidateQuery(principal,level);visible.values.push(id);
  const row=(await db.query(`SELECT * FROM (${visible.text}) resource WHERE id=$${visible.values.length}`,visible.values)).rows[0];
  if(!row)throw concealed();return row;
}
export function visibleKnowledgeRevisionQuery(principal:Principal,level:DepartmentLevel='viewer',options:QueryOptions={}){
  const values:unknown[]=[],permitted=predicate(principal,level,options,values,'resource.departments');
  const administrative=principal.kind==='local-owner'||principal.kind==='human'&&principal.orgRole==='admin';
  return {text:`${sourceCtes} SELECT resource.id,resource.version,resource.departments,resource.bounds FROM ${administrative?'source_nodes':'safe_sources'} resource
    WHERE resource.kind='knowledge-revision' AND ${permitted}`,values};
}
export async function requireKnowledgeRevision(db:IdentityQueryExecutor,principal:Principal,id:string,version:number,level:DepartmentLevel='viewer'){
  if(!validId(id)||!Number.isSafeInteger(version)||version<1)throw concealed();
  const visible=visibleKnowledgeRevisionQuery(principal,level);visible.values.push(id,String(version));
  const row=(await db.query(`SELECT * FROM (${visible.text}) resource WHERE id=$${visible.values.length-1} AND version=$${visible.values.length}`,visible.values)).rows[0];
  if(!row)throw concealed();return row;
}
export async function requireKnowledgeDocument(db:IdentityQueryExecutor,principal:Principal,id:string,level:DepartmentLevel='viewer'){
  if(!validId(id))throw concealed();const row=(await db.query('SELECT id,space_id,version FROM knowledge_documents WHERE id=$1 AND deleted_at IS NULL',[id])).rows[0];
  if(!row)throw concealed();const revision=await requireKnowledgeRevision(db,principal,id,row.version,level);return {...row,departments:revision.departments};
}
export function visibleSourceQuery(principal:Principal,kind:'run'|'file',level:DepartmentLevel,options:QueryOptions={}){
  const values:unknown[]=[],permitted=predicate(principal,level,options,values,'resource.departments');
  // Administrators retain legacy access, but the real row must still exist.
  const administrative=principal.kind==='local-owner'||principal.kind==='human'&&principal.orgRole==='admin';
  const rows=administrative?kind==='run'?'SELECT id,departments FROM resource_runs':scopeRows('workFile'):`SELECT id,departments FROM safe_sources WHERE kind='${kind}'`;
  return {text:`${administrative?ctes:sourceCtes} SELECT resource.id FROM (${rows}) resource WHERE ${permitted}`,values};
}
const knowledgeScope = (space = 's') => `CASE WHEN ${space}.scope='department' AND ${space}.deleted_at IS NULL
  AND EXISTS(SELECT 1 FROM departments d WHERE d.id=${space}.department_id AND d.deleted_at IS NULL)
  THEN ARRAY[${space}.department_id] ELSE NULL::text[] END`;

function scopeRows(kind: ResourceKind): string {
  switch (kind) {
    case 'department': return 'SELECT id,CASE WHEN deleted_at IS NULL THEN ARRAY[id] ELSE NULL::text[] END AS departments FROM departments';
    case 'project': return 'SELECT id,departments FROM resource_projects';
    case 'run': return 'SELECT id,departments FROM resource_runs';
    case 'approval': return 'SELECT a.id,r.departments FROM tool_approvals a LEFT JOIN resource_runs r ON r.id=a.run_id';
    case 'workFile': return 'SELECT f.id,r.departments FROM work_file_snapshots f LEFT JOIN resource_runs r ON r.id=f.source_run_id';
    case 'knowledgeSpace': return `SELECT s.id,${knowledgeScope()} AS departments FROM knowledge_spaces s`;
    case 'knowledgeDocument': return `SELECT k.id,CASE WHEN k.deleted_at IS NULL THEN ${knowledgeScope()} ELSE NULL::text[] END AS departments
      FROM knowledge_documents k LEFT JOIN knowledge_spaces s ON s.id=k.space_id`;
    // settleCall retains one settled reservation and its usage receipt with identical identity and nullable anchors.
    case 'cost': return `SELECT DISTINCT c.id,CASE WHEN count(*) OVER(PARTITION BY c.id)<>1 AND NOT EXISTS(
      SELECT 1 FROM usage receipt JOIN model_reservations reservation ON reservation.id=receipt.id
      WHERE receipt.id=c.id AND reservation.status='settled' AND receipt.model_id=reservation.model_id AND receipt.purpose=reservation.purpose
        AND receipt.run_id IS NOT DISTINCT FROM reservation.run_id AND receipt.project_id IS NOT DISTINCT FROM reservation.project_id
        AND receipt.department_id IS NOT DISTINCT FROM reservation.department_id) THEN NULL::text[]
      WHEN c.run_id IS NOT NULL THEN CASE WHEN (c.project_id IS NULL OR c.project_id=r.project_id)
        AND (c.department_id IS NULL OR c.department_id=ANY(r.departments)) THEN r.departments END
      WHEN c.project_id IS NOT NULL THEN CASE WHEN c.department_id IS NULL OR c.department_id=ANY(p.departments) THEN p.departments END
      WHEN d.id IS NOT NULL AND d.deleted_at IS NULL THEN ARRAY[d.id] ELSE NULL::text[] END AS departments
      FROM (SELECT id,run_id,project_id,department_id FROM usage UNION ALL SELECT id,run_id,project_id,department_id FROM model_reservations) c
      LEFT JOIN resource_runs r ON r.id=c.run_id LEFT JOIN resource_projects p ON p.id=c.project_id
      LEFT JOIN departments d ON d.id=c.department_id`;
  }
}

function validate(principal: Principal, level: DepartmentLevel, options: QueryOptions) {
  try { principalKey(principal); } catch { throw concealed(); }
  if (!Object.hasOwn(levels,level) || !options || typeof options!=='object'
    || (options.approve!==undefined && typeof options.approve!=='boolean')
    || !Number.isSafeInteger(options.parameterOffset ?? 0) || (options.parameterOffset ?? 0)<0 || (options.parameterOffset ?? 0)>10000) throw concealed();
}
function predicate(principal: Principal, level: DepartmentLevel, options: QueryOptions, values: unknown[], departmentColumn: string): string {
  validate(principal,level,options);
  const bind = (value: unknown) => { values.push(value); return `$${values.length+(options.parameterOffset ?? 0)}`; };
  if (principal.kind==='local-owner') return 'TRUE';
  if (principal.kind!=='human') return 'FALSE';
  const user = bind(principal.userId), issuer = bind(principal.issuer), subject = bind(principal.subject), epoch = bind(principal.sessionEpoch), role = bind(principal.orgRole);
  const roles = bind(options.approve && level==='viewer' ? levels.operator : levels[level]), approve = bind(options.approve ?? false);
  return `EXISTS(SELECT 1 FROM human_users human WHERE human.id=${user} AND human.issuer=${issuer} AND human.subject=${subject}
    AND human.status='active' AND human.session_epoch=${epoch} AND human.org_role=${role}
    AND (human.org_role='admin' OR (human.org_role='member' AND ${departmentColumn} IS NOT NULL AND cardinality(${departmentColumn})>0
      AND NOT EXISTS(SELECT 1 FROM unnest(${departmentColumn}) required(department_id) WHERE NOT EXISTS(
        SELECT 1 FROM department_memberships membership WHERE membership.user_id=human.id AND membership.department_id=required.department_id
          AND membership.role=ANY(${roles}::text[]) AND (NOT ${approve}::boolean OR membership.can_approve))))))`;
}

/** Embed in WHERE id IN (...) before sorting/pagination/count; values follow the caller's parameterOffset. */
export function visibleResourceQuery(principal: Principal, kind: ResourceKind, level: DepartmentLevel, options: QueryOptions = {}): { text: string; values: unknown[] } {
  if (!kinds.includes(kind)) throw concealed();
  const values: unknown[] = [], permitted = predicate(principal,level,options,values,'resource.departments');
  return { text: `${ctes} SELECT resource.id FROM (${scopeRows(kind)}) resource WHERE ${permitted}`, values };
}

/** Project endpoints include historical material; authorize every fixed scope before pagination/count. */
export function visibleProjectMaterialQuery(principal:Principal,level:DepartmentLevel,options:QueryOptions={}){
  const values:unknown[]=[],permitted=predicate(principal,level,options,values,'resource.departments');
  return {text:`${materialCtes} SELECT p.id FROM projects p WHERE NOT EXISTS(
    SELECT 1 FROM resource_material resource WHERE resource.project_id=p.id AND (${permitted}) IS NOT TRUE)`,values};
}
export async function resolveProjectMaterialDepartments(db:IdentityQueryExecutor,projectId:string):Promise<string[]|null>{
  if(!validId(projectId))return null;
  const departments=(await db.query(`${materialCtes} SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM resource_material WHERE project_id=$1 AND departments IS NULL)
    THEN ARRAY(SELECT DISTINCT unnest(departments) FROM resource_material WHERE project_id=$1 ORDER BY 1)
    ELSE NULL::text[] END AS departments WHERE EXISTS(SELECT 1 FROM resource_projects WHERE id=$1)`,[projectId])).rows[0]?.departments;
  return departments?.length&&departments.length<=100?departments:null;
}

export async function resolveProjectDepartments(db: IdentityQueryExecutor, projectId: string): Promise<string[] | null> {
  if (!validId(projectId)) return null;
  return (await db.query(`${ctes} SELECT departments FROM resource_projects WHERE id=$1`,[projectId])).rows[0]?.departments ?? null;
}
export async function resolveRunDepartments(db: IdentityQueryExecutor, runId: string): Promise<string[] | null> {
  if (!validId(runId)) return null;
  return (await db.query(`${ctes} SELECT departments FROM resource_runs WHERE id=$1`,[runId])).rows[0]?.departments ?? null;
}

/** Read checks only. Writers must first take the resource/user/membership locks in their business transaction. */
export async function requireDepartments(db: IdentityQueryExecutor, principal: Principal, ids: string[], level: DepartmentLevel, options: AuthorityOptions = {}): Promise<void> {
  if (!Array.isArray(ids) || !ids.length || ids.length>100 || ids.some(id=>!validId(id)) || new Set(ids).size!==ids.length) throw concealed();
  const values: unknown[] = [[...ids].sort()], permitted = predicate(principal,level,options,values,'scope.departments');
  const { rows } = await db.query(`SELECT 1 FROM (SELECT $1::text[] AS departments) scope WHERE
    NOT EXISTS(SELECT 1 FROM unnest(scope.departments) required(id) WHERE NOT EXISTS(SELECT 1 FROM departments d WHERE d.id=required.id AND d.deleted_at IS NULL))
    AND ${permitted}`,values);
  if (!rows.length) throw concealed();
}
export async function requireResource(db: IdentityQueryExecutor, principal: Principal, ref: ResourceRef, level: DepartmentLevel, options: AuthorityOptions = {}): Promise<void> {
  if (!ref || typeof ref!=='object' || Reflect.ownKeys(ref).some(key=>key!=='kind' && key!=='id') || !validId(ref.id)) throw concealed();
  const query = visibleResourceQuery(principal,ref.kind,level,options);
  query.values.push(ref.id);
  const { rows } = await db.query(`${query.text} AND resource.id=$${query.values.length}`,query.values);
  if (!rows.length) throw concealed();
}
export async function visibleProjectIds(db: IdentityQueryExecutor, principal: Principal, level: DepartmentLevel): Promise<string[]> {
  const query = visibleResourceQuery(principal,'project',level);
  return (await db.query(`${query.text} ORDER BY resource.id`,query.values)).rows.map(row=>row.id);
}
