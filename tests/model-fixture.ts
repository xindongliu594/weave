// Only isolated test schemas may install this synthetic capability evidence.
export const toolEvidence={tools:{status:'supported' as const,checkedAt:'2026-09-20T00:00:00.000Z',testId:'local-fixture',probeVersion:'chat-tools-roundtrip-v1'}};

/** Read DSH's latest protected task snapshot, including after history compaction. */
export const fixtureRuntimeContextPrefix = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n';
export function fixtureTaskContext(messages: Array<{ role: string; content?: unknown }>) {
 const parse = (content: string) => content.split('\n').map(line => {
  try { return JSON.parse(line); } catch { return undefined; }
 }).find(value => typeof value?.runtimeTaskId === 'string' && typeof value?.attemptId === 'string' && typeof value?.task?.subject === 'string');
 const current = messages.findLast(message => message.role === 'user' && typeof message.content === 'string' &&
  message.content.startsWith(fixtureRuntimeContextPrefix));
 // An incomplete newest snapshot cannot silently resurrect an older attempt.
 if (current) return parse(current.content as string);
 return messages.filter(message => message.role === 'system' && typeof message.content === 'string').reverse()
  .map(message => parse(message.content as string)).find(Boolean);
}

export async function recoveryModel(pool:any){
 const {routeFingerprint}=await import('../apps/api/src/model-capabilities.ts');
 const data={name:'Recovery fixture',gatewayId:'recovery-gateway',model:'fixture',inputRate:0,outputRate:0};
 await pool.query("INSERT INTO gateways(id,data) VALUES('recovery-gateway',$1) ON CONFLICT DO NOTHING",[{name:'Fixture',baseUrl:'http://127.0.0.1:1/v1'}]);
 await pool.query("INSERT INTO models(id,data,status,capabilities) VALUES('recovery-model',$1,'available',$2) ON CONFLICT DO NOTHING",[data,toolEvidence]);
 // Read jsonb back so the fingerprint matches the canonical stored configuration.
 const model=(await pool.query("SELECT data FROM models WHERE id='recovery-model'")).rows[0];
 return {agents:[{id:'employee-1',employeeId:'employee',role:'manager',modelId:'recovery-model',tools:[]}],modelRoutes:[{id:'recovery-model',configurationHash:routeFingerprint(model.data,1)}]};
}
