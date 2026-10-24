import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import {z} from 'zod';
import {AppError} from './provider.ts';
import {shareCostMaintenance} from './cost-control.ts';
import {assertCurrentRunPermissions} from './execution-policy.ts';
import {recordRunAuthorityDenial} from './run-current-authority.ts';
import {appendAudit} from './audit-events.ts';
import type {ToolEffectContractService} from './tool-effect-contracts.ts';
import {identityText} from './identity-types.ts';
import type {EffectContract,EffectIntent,EffectState} from '../../../packages/contracts/tool-effects.ts';
import type {ArchiveWriterManager} from '../../../services/agent-runtime/archive-writer-scope.mjs';
import {EMPLOYEE_INFRASTRUCTURE_TOOLS} from '../../../services/agent-runtime/employee-tool-access.mjs';
import {effectDigest,validateEffectContract} from '../../../services/agent-runtime/tool-effects.mjs';

type Db=Pick<pg.PoolClient,'query'>;
const text=z.string().refine(value=>identityText(value,128)),hash=z.string().regex(/^[a-f0-9]{64}$/);
const prepareSchema=z.strictObject({contract:z.unknown(),agentId:text,sessionId:text,callId:text,taskId:text.optional(),argumentsSha256:hash,parentOperationId:z.uuid().optional()});
const reference=z.strictObject({operationId:z.uuid(),intentSha256:hash});
const dispatchSchema=reference.extend({expectedVersion:z.number().int().positive()});
const evidenceSchema=z.strictObject({evidenceId:z.uuid(),outcome:z.enum(['confirmed','unknown']),receiptSha256:hash,reasonCode:z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/)});
export type RuntimePrepareInput={contract:EffectContract;agentId:string;sessionId:string;callId:string;taskId?:string;argumentsSha256:string;parentOperationId?:string};
export type RuntimeOperation={operationId:string;version:number;state:EffectState;intentSha256:string};
export type RuntimeEvidenceInput=z.infer<typeof reference>&{evidence:z.infer<typeof evidenceSchema>};
export type RuntimeOperations={prepare(input:RuntimePrepareInput,signal?:AbortSignal):Promise<RuntimeOperation>;dispatch(input:z.infer<typeof dispatchSchema>,signal?:AbortSignal):Promise<RuntimeOperation>;abortPrepared(input:z.infer<typeof dispatchSchema>):Promise<RuntimeOperation>;recordEvidence(input:RuntimeEvidenceInput):Promise<RuntimeOperation>;markUnknown(input:z.infer<typeof reference>&{reasonCode:string}):Promise<RuntimeOperation>};
type Row={id:string;run_id:string;lease_owner:string;effect_intent:EffectIntent;effect_state:EffectState;effect_version:number;started:boolean;evidence_records:Record<string,unknown>[];payload:{contract:EffectContract};parent_operation_id:string|null};
const fail=(code:string)=>new AppError(409,code,code);
const view=(row:Row):RuntimeOperation=>({operationId:row.id,version:row.effect_version,state:row.effect_state,intentSha256:effectDigest(row.effect_intent)});

/** Caller holds the existing project/run admission or maintenance transaction. */
export async function requireResolvedProjectEffectsIn(db:Db,projectId:string):Promise<void>{
 if((await db.query(`SELECT o.id FROM local_operations o JOIN project_runs r ON r.id=o.run_id
   WHERE r.project_id=$1 AND o.executor_kind='runtime' AND (o.effect_state IS NULL OR o.effect_state NOT IN ('confirmed','failed-known')) LIMIT 1`,[projectId])).rowCount)
  throw new AppError(409,'项目仍有结果未核对的工具操作，请先核对原调用；确认重试不能解除此限制。','TOOL_OPERATION_UNRESOLVED');
}
export async function requireResolvedEffectsIn(db:Db,runIds:string[]):Promise<void>{
 z.array(z.uuid()).max(128).parse(runIds);
 if((await db.query("SELECT id FROM local_operations WHERE run_id=ANY($1::text[]) AND executor_kind='runtime' AND (effect_state IS NULL OR effect_state NOT IN ('confirmed','failed-known')) LIMIT 1",[runIds])).rowCount)
  throw new AppError(409,'运行仍有结果未核对的工具操作，请保留现场并核对原调用。','TOOL_OPERATION_UNRESOLVED');
}
/** Runtime receipts and device results have different authoritative columns. */
export function unresolvedOperationSql(alias=''){
 if(alias&&!/^[a-z][a-z0-9_]*$/.test(alias))throw Error('Invalid SQL alias');
 const p=alias?alias+'.':'';
 return `(${p}executor_kind='runtime' AND (${p}effect_state IS NULL OR ${p}effect_state NOT IN ('confirmed','failed-known')) OR ${p}executor_kind='local' AND (${p}status NOT IN ('completed','failed','cancelled') OR (${p}started AND ${p}result IS NULL)))`;
}

/** Extend the original transport table. Runtime rows never enter device polling states. */
export async function migrateToolOperations(db:Db){
 await db.query(`ALTER TABLE local_operations ADD COLUMN IF NOT EXISTS executor_kind text NOT NULL DEFAULT 'local';
 ALTER TABLE local_operations ADD COLUMN IF NOT EXISTS effect_intent jsonb;
 ALTER TABLE local_operations ADD COLUMN IF NOT EXISTS effect_state text;
 ALTER TABLE local_operations ADD COLUMN IF NOT EXISTS effect_version integer NOT NULL DEFAULT 0;
 ALTER TABLE local_operations ADD COLUMN IF NOT EXISTS parent_operation_id text REFERENCES local_operations(id);
 ALTER TABLE local_operations ADD COLUMN IF NOT EXISTS evidence_records jsonb NOT NULL DEFAULT '[]';
 ALTER TABLE local_operations ALTER COLUMN device_id DROP NOT NULL;
 ALTER TABLE local_operations ALTER COLUMN grant_id DROP NOT NULL;
 DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='local_operations'::regclass AND conname='tool_operations_transport' AND position('failed-known' IN pg_get_constraintdef(oid))=0) THEN
  ALTER TABLE local_operations DROP CONSTRAINT tool_operations_transport;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='local_operations'::regclass AND conname='tool_operations_transport') THEN
 ALTER TABLE local_operations ADD CONSTRAINT tool_operations_transport CHECK (
 (executor_kind='local' AND device_id IS NOT NULL AND grant_id IS NOT NULL) OR
 (executor_kind='runtime' AND device_id IS NULL AND grant_id IS NULL AND approval_id IS NULL AND claim_token IS NULL
 AND status IN ('prepared','dispatched','completed','failed','unknown') AND effect_intent IS NOT NULL
 AND effect_state IS NOT NULL AND effect_state IN ('prepared','dispatched','confirmed','failed-known','unknown') AND effect_version>=1
 AND status=CASE effect_state WHEN 'confirmed' THEN 'completed' WHEN 'failed-known' THEN 'failed' ELSE effect_state END
 AND (effect_state<>'failed-known' OR (started=false AND jsonb_array_length(evidence_records)=1))
 AND jsonb_typeof(evidence_records)='array' AND jsonb_array_length(evidence_records)<=32 AND octet_length(evidence_records::text)<=32768));
 END IF; END $$;
 CREATE UNIQUE INDEX IF NOT EXISTS tool_operations_runtime_call ON local_operations(run_id,(effect_intent->'principal'->>'sessionId'),(effect_intent->>'callId')) WHERE executor_kind='runtime';
 CREATE OR REPLACE FUNCTION protect_runtime_operation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN IF OLD.executor_kind='runtime' THEN RAISE EXCEPTION 'runtime operation immutable'; END IF; RETURN OLD; END IF;
 IF NEW.executor_kind IS DISTINCT FROM OLD.executor_kind THEN RAISE EXCEPTION 'runtime operation immutable'; END IF;
 IF OLD.executor_kind='runtime' THEN
  IF ROW(NEW.id,NEW.run_id,NEW.lease_owner,NEW.payload,NEW.effect_intent,NEW.parent_operation_id) IS DISTINCT FROM ROW(OLD.id,OLD.run_id,OLD.lease_owner,OLD.payload,OLD.effect_intent,OLD.parent_operation_id)
   OR NEW.effect_version<>OLD.effect_version+1 OR jsonb_array_length(NEW.evidence_records)<jsonb_array_length(OLD.evidence_records)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(OLD.evidence_records) WITH ORDINALITY AS prior_evidence(value,n) WHERE NEW.evidence_records->(prior_evidence.n::int-1) IS DISTINCT FROM prior_evidence.value)
   OR NEW.effect_state IS NULL OR OLD.effect_state IN ('confirmed','failed-known')
   OR (OLD.effect_state='prepared' AND NOT (
      NEW.effect_state='dispatched' AND NEW.started=true AND NEW.evidence_records=OLD.evidence_records
      OR NEW.effect_state='failed-known' AND OLD.started=false AND NEW.started=false
       AND jsonb_array_length(NEW.evidence_records)=jsonb_array_length(OLD.evidence_records)+1))
   OR (OLD.effect_state IN ('dispatched','unknown') AND (NEW.effect_state NOT IN ('unknown','confirmed') OR jsonb_array_length(NEW.evidence_records)<>jsonb_array_length(OLD.evidence_records)+1)) THEN RAISE EXCEPTION 'runtime operation immutable'; END IF;
 END IF; RETURN NEW; END $$;
 DROP TRIGGER IF EXISTS runtime_operation_immutable ON local_operations;
 CREATE TRIGGER runtime_operation_immutable BEFORE UPDATE OR DELETE ON local_operations FOR EACH ROW EXECUTE FUNCTION protect_runtime_operation();`);
}

export class ToolOperationService {
 constructor(private options:{db:Pick<pg.Pool,'connect'>;writers:ArchiveWriterManager;contracts:ToolEffectContractService}){}
 forRun(runId:string,owner:string):RuntimeOperations{
  z.uuid().parse(runId);text.parse(owner);
  return Object.freeze({prepare:(input:RuntimePrepareInput,signal?:AbortSignal)=>this.transaction(runId,db=>this.prepareIn(db,{runId,owner,...input}),signal),
   dispatch:(input:z.infer<typeof dispatchSchema>,signal?:AbortSignal)=>this.transaction(runId,db=>this.dispatchIn(db,{runId,owner,...input}),signal),
   abortPrepared:(input:z.infer<typeof dispatchSchema>)=>this.transaction(runId,db=>this.abortPreparedIn(db,{runId,owner,...input})),
   recordEvidence:(input:RuntimeEvidenceInput)=>this.transaction(runId,db=>this.recordEvidenceIn(db,{runId,owner,...input})),
   markUnknown:(input:z.infer<typeof reference>&{reasonCode:string})=>this.transaction(runId,db=>this.markUnknownIn(db,{runId,owner,...input}))});
 }
 private async transaction<T>(runId:string,work:(db:Db)=>Promise<T>,signal?:AbortSignal):Promise<T>{
  const result=await this.options.writers.withWriter([runId],async()=>{
   let client:pg.PoolClient|undefined,discard=false,committing=false,primary:unknown;
   try{signal?.throwIfAborted();client=await this.options.db.connect();signal?.throwIfAborted();
    try{await client.query('BEGIN');}catch(error){discard=true;throw error;}
    await client.query("SET LOCAL statement_timeout='5000ms'");await shareCostMaintenance(client);const value=await work(client);signal?.throwIfAborted();
    committing=true;await client.query('COMMIT');return {ok:true as const,value};
   }catch(error){primary=error;if(client)try{await client.query('ROLLBACK');}catch{discard=true;}
    if(discard||committing){discard=true;throw error;}return {ok:false as const,error};
   }finally{try{client?.release(discard);}catch(error){if(primary===undefined)throw error;}}
  },{signal});if(!result.ok){await recordRunAuthorityDenial(this.options.db,result.error);throw result.error;}return result.value;
 }
 private async runIn(db:Db,runId:string,owner:string,authorize:boolean){
  const identity=(await db.query('SELECT project_id FROM project_runs WHERE id=$1',[runId])).rows[0];if(!identity)throw fail('TOOL_OPERATION_RUN_DENIED');
  const project=(await db.query('SELECT id,version FROM projects WHERE id=$1 FOR UPDATE',[identity.project_id])).rows[0];
  const run=(await db.query('SELECT *,lease_until>clock_timestamp() AS lease_valid FROM project_runs WHERE id=$1 FOR UPDATE',[runId])).rows[0];
  if(!run||!project||run.project_id!==identity.project_id)throw fail('TOOL_OPERATION_RUN_DENIED');
  if(authorize){if(run.status!=='running'||run.cancel_requested||run.lease_owner!==owner||!run.lease_valid||run.project_version!==project.version)throw fail('TOOL_OPERATION_RUN_DENIED');await assertCurrentRunPermissions(run,db,{requireLocalOnline:false,authorityLock:true,effect:'tool'});}
  return run;
 }
 private async contractIn(db:Db,run:any,input:EffectContract,agentId:string,taskId?:string){
  const contract=validateEffectContract(input),digest=effectDigest(contract),agent=run.snapshot.agents?.find((item:any)=>item.id===agentId);
  if(contract.source.kind!=='builtin'||!['read','workspace'].includes(contract.effect)||contract.cost.kind!=='free'||contract.retry==='provider-key')throw fail('TOOL_OPERATION_RUNTIME_UNSUPPORTED');
  if(run.snapshot.effectContractVersion!==1||!run.snapshot.effectContracts?.some((item:unknown)=>effectDigest(item)===digest)||!agent||!Array.isArray(agent.tools)||!agent.tools.includes(contract.toolName)&&!EMPLOYEE_INFRASTRUCTURE_TOOLS.includes(contract.toolName))throw fail('TOOL_OPERATION_PERMISSION_DENIED');
  if(taskId&&!run.snapshot.tasks?.some((task:any)=>task.id===taskId&&(task.assignee??task.assigneeId)===agentId))throw fail('TOOL_OPERATION_PERMISSION_DENIED');
  await this.options.contracts.assertContractIn(db,contract);return contract;
 }
 async prepareIn(db:Db,input:RuntimePrepareInput&{runId:string;owner:string}):Promise<RuntimeOperation>{
  const {runId,owner,...raw}=input,parsed=prepareSchema.parse(raw),run=await this.runIn(db,runId,owner,true),contract=await this.contractIn(db,run,parsed.contract as EffectContract,parsed.agentId,parsed.taskId);
  const existing=(await db.query<Row>("SELECT * FROM local_operations WHERE run_id=$1 AND executor_kind='runtime' AND effect_intent->'principal'->>'sessionId'=$2 AND effect_intent->>'callId'=$3 FOR UPDATE",[runId,parsed.sessionId,parsed.callId])).rows[0];
  const operationId=existing?.id??randomUUID();let parent:Row|undefined;
  if(parsed.parentOperationId){parent=(await db.query<Row>("SELECT * FROM local_operations WHERE id=$1 AND run_id=$2 AND executor_kind='runtime' FOR UPDATE",[parsed.parentOperationId,runId])).rows[0];if(!parent||parent.effect_state!=='dispatched'||parent.lease_owner!==owner||parent.effect_intent.principal.sessionId!==parsed.sessionId||parent.id===operationId)throw fail('TOOL_OPERATION_PARENT_INVALID');}
  const intent:EffectIntent={schema:1,operationId,runId,taskId:parsed.taskId??null,attemptId:null,rootCallId:parent?.effect_intent.rootCallId??parsed.callId,callId:parsed.callId,parentOperationId:parsed.parentOperationId??null,
   principal:{kind:'employee',id:parsed.agentId,sessionId:parsed.sessionId,authorizationVersion:effectDigest(run.snapshot)},contractSha256:effectDigest(contract),argumentsSha256:parsed.argumentsSha256,resourcePreconditions:{snapshotSha256:effectDigest(run.snapshot)},scopeRef:null,approvalId:null,budgetRefs:[],providerKey:null,compensatesOperationId:null};
  if(existing){if(effectDigest(existing.effect_intent)!==effectDigest(intent))throw fail('TOOL_OPERATION_IDENTITY_CONFLICT');return view(existing);}
  const row=(await db.query<Row>(`INSERT INTO local_operations(id,run_id,lease_owner,payload,status,executor_kind,effect_intent,effect_state,effect_version,parent_operation_id)
   VALUES($1,$2,$3,$4,'prepared','runtime',$5,'prepared',1,$6) RETURNING *`,[operationId,runId,owner,{contract},intent,parsed.parentOperationId??null])).rows[0];return view(row);
 }
 async dispatchIn(db:Db,input:z.infer<typeof dispatchSchema>&{runId:string;owner:string}):Promise<RuntimeOperation>{
  const {runId,owner,...raw}=input,parsed=dispatchSchema.parse(raw),run=await this.runIn(db,runId,owner,true);
  // Discover the immutable contract before the operation lock: contract -> operation lock order.
  const observed=(await db.query<Row>("SELECT * FROM local_operations WHERE id=$1 AND run_id=$2 AND executor_kind='runtime'",[parsed.operationId,runId])).rows[0];if(!observed)throw fail('TOOL_OPERATION_IDENTITY_CONFLICT');
  await this.contractIn(db,run,observed.payload.contract,observed.effect_intent.principal.id,observed.effect_intent.taskId??undefined);
  const row=await this.rowIn(db,runId,owner,parsed);if(row.effect_state!=='prepared'||row.effect_version!==parsed.expectedVersion||row.effect_intent.resourcePreconditions.snapshotSha256!==effectDigest(run.snapshot))throw fail('TOOL_OPERATION_DISPATCH_CONFLICT');
  const updated=(await db.query<Row>("UPDATE local_operations SET effect_state='dispatched',effect_version=effect_version+1,status='dispatched',started=true WHERE id=$1 AND effect_version=$2 AND effect_state='prepared' RETURNING *",[row.id,parsed.expectedVersion])).rows[0];if(!updated)throw fail('TOOL_OPERATION_DISPATCH_CONFLICT');
  await this.audit(db,updated,'dispatched');return view(updated);
 }
 private async rowIn(db:Db,runId:string,owner:string,input:z.infer<typeof reference>){
  const row=(await db.query<Row>("SELECT * FROM local_operations WHERE id=$1 AND run_id=$2 AND executor_kind='runtime' FOR UPDATE",[input.operationId,runId])).rows[0];
  if(!row||row.lease_owner!==owner||effectDigest(row.effect_intent)!==input.intentSha256)throw fail('TOOL_OPERATION_IDENTITY_CONFLICT');return row;
 }
 async abortPreparedIn(db:Db,input:z.infer<typeof dispatchSchema>&{runId:string;owner:string}):Promise<RuntimeOperation>{
  const {runId,owner,...raw}=input,parsed=dispatchSchema.parse(raw);
  // This closes an original, demonstrably unstarted attempt even after its
  // authorization was revoked. It cannot authorize any new effect.
  await this.runIn(db,runId,owner,false);const row=await this.rowIn(db,runId,owner,parsed);
  if(row.effect_state==='failed-known'&&row.effect_version===parsed.expectedVersion+1)return view(row);
  if(row.effect_state!=='prepared'||row.started||row.effect_version!==parsed.expectedVersion)throw fail('TOOL_OPERATION_ABORT_CONFLICT');
  const evidence={evidenceId:randomUUID(),outcome:'failed-known',receiptSha256:effectDigest({operationId:row.id,intentSha256:parsed.intentSha256,preparedVersion:parsed.expectedVersion,started:false}),reasonCode:'TOOL_RUNTIME_NOT_DISPATCHED'};
  const updated=(await db.query<Row>("UPDATE local_operations SET effect_state='failed-known',effect_version=effect_version+1,status='failed',finished_at=now(),evidence_records=$3 WHERE id=$1 AND effect_version=$2 AND effect_state='prepared' AND started=false RETURNING *",[row.id,parsed.expectedVersion,JSON.stringify([...row.evidence_records,evidence])])).rows[0];
  if(!updated)throw fail('TOOL_OPERATION_ABORT_CONFLICT');
  await this.audit(db,updated,'failed-known',evidence.evidenceId);return view(updated);
 }
 async recordEvidenceIn(db:Db,input:RuntimeEvidenceInput&{runId:string;owner:string}):Promise<RuntimeOperation>{
  const {runId,owner,evidence,...ref}=input,parsed=reference.parse(ref),item=evidenceSchema.parse(evidence);await this.runIn(db,runId,owner,false);const row=await this.rowIn(db,runId,owner,parsed);
  const old=row.evidence_records.find(record=>record.evidenceId===item.evidenceId);if(old){if(effectDigest(old)!==effectDigest(item))throw fail('TOOL_OPERATION_EVIDENCE_CONFLICT');return view(row);}
  if(row.effect_state==='prepared'||row.effect_state==='confirmed'||row.effect_state==='failed-known')throw fail('TOOL_OPERATION_EVIDENCE_CONFLICT');
  const records=[...row.evidence_records,item];if(records.length>32||Buffer.byteLength(JSON.stringify(records))>32768)throw fail('TOOL_OPERATION_EVIDENCE_FULL');
  const updated=(await db.query<Row>("UPDATE local_operations SET effect_state=$1,effect_version=effect_version+1,evidence_records=$2,status=$3,finished_at=CASE WHEN $1='confirmed' THEN now() ELSE finished_at END WHERE id=$4 RETURNING *",[item.outcome,JSON.stringify(records),item.outcome==='confirmed'?'completed':'unknown',row.id])).rows[0];
  await this.audit(db,updated,item.outcome,item.evidenceId);return view(updated);
 }
 async markUnknownIn(db:Db,input:z.infer<typeof reference>&{runId:string;owner:string;reasonCode:string}){
  const {reasonCode,...ref}=input;return this.recordEvidenceIn(db,{...ref,evidence:{evidenceId:randomUUID(),outcome:'unknown',receiptSha256:effectDigest({reasonCode}),reasonCode}});
 }
 async requireResolvedEffectsIn(db:Db,runIds:string[]):Promise<void>{
  return requireResolvedEffectsIn(db,runIds);
 }
 private async audit(db:Db,row:Row,state:'dispatched'|'confirmed'|'failed-known'|'unknown',receiptId?:string){
  const eventId=randomUUID(),intent=row.effect_intent,contract=row.payload.contract;
  const common={eventId,actor:{kind:'system' as const,service:'runtime-tool-effects'},executedEmployee:{employeeId:intent.principal.id,agentId:intent.principal.id,sessionId:intent.principal.sessionId},correlation:{correlationId:intent.callId,runId:row.run_id,operationId:row.id,...(intent.parentOperationId?{parentOperationId:intent.parentOperationId}:{})},resource:{type:'tool_operation' as const,id:row.id,departmentIds:[]},changes:{state,capabilityId:contract.capabilityId,capabilitySha256:intent.contractSha256,effect:contract.effect,...(receiptId?{receiptId}:{})}};
  if(state==='dispatched')await appendAudit(db,{...common,action:'tool.dispatch',outcome:'success',changes:{...common.changes,state},authority:{decisionId:eventId,checkedAt:new Date().toISOString(),policyVersion:'runtime-tool-operations-v1',principalKey:'system:runtime-tool-effects',departmentIds:[],membershipVersions:[],grantVersions:[],permissionSha256:intent.principal.authorizationVersion}});
  else await appendAudit(db,{...common,action:'tool.result',outcome:state==='confirmed'?'success':state==='failed-known'?'failure':'unknown',changes:{...common.changes,state}});
 }
}
