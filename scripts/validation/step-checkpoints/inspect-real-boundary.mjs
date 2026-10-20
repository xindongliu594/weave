// Read-only audit of this authorized synthetic task; no model or execution calls.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {readRun} from '../../../services/agent-runtime/trace-store.mjs';
import {validateInheritedEvidence} from '../../../services/agent-runtime/step-checkpoints.mjs';
const base='/home/jj/.local/share/weiwu',root=join(base,'data/pilot/runs');
const state=JSON.parse(readFileSync(join(base,'validation/step-acceptance-20261020/state.json'),'utf8'));
const run=readRun(root,state.runId),task=run.snapshot.tasks.find(t=>t.id===state.taskIds.qa);
const event=run.events.findLast(e=>e.type==='step/checkpoint'&&e.data.boundary.taskId===task.id);
const reference={id:event.data.id,runId:run.id,sha256:event.data.sha256};
const report={runId:run.id,projectId:run.snapshot.projectId,integrity:run.integrity,
 approvedVerificationReuse:state.plan.preview.plan.tasks.find(t=>t.id===task.id).verificationReuse,
 runtimeVerificationReuse:task.verificationReuse??null,reference,
 proof:validateInheritedEvidence({root,reference,snapshot:run.snapshot,task,workspace:join(root,run.id,'artifacts'),environment:event.data.boundary.environment}),
 receipt:event.data.receipts.map(r=>({command:r.command,exitCode:r.exitCode,profile:r.evidence.verificationProfile??null,nodeTests:r.evidence.nodeTests})),
 completedTaskIds:run.events.filter(e=>e.type==='handoff/accepted').map(e=>e.data.taskId),
 dispatchedModelCalls:run.events.filter(e=>e.type==='model/wire-request').length,
 lastDispatchSeq:run.events.findLast(e=>e.type==='model/wire-request')?.seq,
 checkpointSeq:event.seq,lastOutcome:run.events.findLast(e=>e.type==='run/finished')?.data};
console.log(JSON.stringify(report,null,2));
