import {mkdirSync,lstatSync,readFileSync,writeFileSync} from 'node:fs';
import {join,dirname,resolve,sep} from 'node:path';
import {readStepCheckpoint,checkpointContract,checkpointLineage} from '../../../services/agent-runtime/step-checkpoints.mjs';
import {unresolvedOperations,READ_ONLY_TOOLS} from '../../../services/agent-runtime/recovery.mjs';
import {completedTasks} from './handoff-checkpoints.ts';

export function stepCheckpointError(error:unknown) {
 const code=error instanceof Error?error.message:String(error);
 const messages:Record<string,string>={
  CHECKPOINT_OPERATION_UNKNOWN:'该运行或其恢复来源仍有结果未知的操作，请先核对操作结果，再选择检查点。',
  CHECKPOINT_CONTRACT_CHANGED:'检查点的任务要求与当前批准方案不一致，不能沿用。',
  CHECKPOINT_ISOLATION_REQUIRED:'步骤回退需要固定的 OpenShell 沙箱环境；此运行可使用原有节点恢复。',
  CHECKPOINT_TASK_ALREADY_COMPLETED:'该节点已经完成，请保留完成结果并继续后续节点。',
  CHECKPOINT_OTHER_TASK_CHANGED:'此检查点之后其他员工已更新成果，请选择更晚的检查点，避免覆盖其工作。',
  CHECKPOINT_EXTERNAL_EFFECT:'此检查点之后存在外部操作，文件回退不能撤销该操作，请先核对其结果。',
  CHECKPOINT_TARGET_EXISTS:'恢复目录已存在，系统不会覆盖；请检查对应的续跑记录。',
  CHECKPOINT_PATH_UNSAFE:'检查点包含不安全的文件路径，恢复已停止，原文件保持不变。',
 };
 return messages[code]??(code.startsWith('CHECKPOINT_')?'检查点或恢复来源不完整，无法安全恢复；请查看原始记录或恢复备份。':code);
}

/** File rollback never rolls back accounting, grants or external effects. */
export function selectStepCheckpoint(root:string,run:any,id:string) {
 if(!run||run.integrity!=='ok')throw Error('CHECKPOINT_ARCHIVE_INVALID');
 if(unresolvedOperations(run.events).length)throw Error('CHECKPOINT_OPERATION_UNKNOWN');
 checkpointLineage(root,run);
 const checkpoint=readStepCheckpoint({root,runId:run.id,checkpointId:id});
 const task=(run.snapshot.approvedTasks??run.snapshot.tasks).find((item:any)=>item.id===checkpoint.boundary.taskId);
 if(!task||checkpointContract(run.snapshot,task)!==checkpoint.boundary.contractHash)throw Error('CHECKPOINT_CONTRACT_CHANGED');
 if(run.snapshot.executionTarget?.backend?.kind!=='openshell')throw Error('CHECKPOINT_ISOLATION_REQUIRED');
 if(completedTasks(run.events,run.snapshot).has(task.id))throw Error('CHECKPOINT_TASK_ALREADY_COMPLETED');
 const after=run.events.filter((event:any)=>event.seq>checkpoint.seq);
 for(const event of after) {
  if(['artifact/updated','handoff/accepted','quality/rework-created'].includes(event.type)&&
     (event.taskId??event.data?.taskId)!==task.id)throw Error('CHECKPOINT_OTHER_TASK_CHANGED');
  if(event.type==='tool/start'||event.type==='runtime/operation-start') {
   const name=event.data.name;
   if(!READ_ONLY_TOOLS.has(name)&&!['terminal','terminal_test','artifact_write'].includes(name)&&!name?.startsWith('agent_teams_'))
    throw Error('CHECKPOINT_EXTERNAL_EFFECT');
   if(['terminal','terminal_test','artifact_write'].includes(name)&&(event.taskId??event.data?.taskId)!==task.id)
    throw Error('CHECKPOINT_OTHER_TASK_CHANGED');
  }
 }
 return {checkpoint,reference:{id,runId:run.id,sha256:checkpoint.sha256},events:run.events.filter((event:any)=>event.seq<=checkpoint.seq)};
}
function plainChain(path:string) {
 const absolute=resolve(path),parent=dirname(absolute);if(parent!==absolute)plainChain(parent);
 const stat=lstatSync(absolute,{throwIfNoEntry:false});
 if(stat&&(stat.isSymbolicLink()||!stat.isDirectory()))throw Error('CHECKPOINT_PATH_UNSAFE');
}
/** The destination is a new run. Never overwrite any existing workspace. */
export function restoreStepWorkspace(root:string,reference:{id:string;runId:string;sha256:string},target:string) {
 const checkpoint=readStepCheckpoint({root,runId:reference.runId,checkpointId:reference.id});
 if(checkpoint.sha256!==reference.sha256)throw Error('CHECKPOINT_MANIFEST_INVALID');
 plainChain(target);
 if(lstatSync(target,{throwIfNoEntry:false}))throw Error('CHECKPOINT_TARGET_EXISTS');
 const keys=new Set<string>(),base=resolve(target);
 const copies=checkpoint.files.map((file:any)=>{
  const key=file.path.toLowerCase(),path=resolve(base,file.path);
  if(!path.startsWith(base+sep)||keys.has(key)||[...keys].some(other=>key.startsWith(other+'/')||other.startsWith(key+'/')))throw Error('CHECKPOINT_PATH_UNSAFE');
  keys.add(key);return {path,bytes:readFileSync(join(root,reference.runId,'checkpoint-objects',file.sha256))};
 });
 mkdirSync(base,{recursive:true,mode:0o700});
 for(const file of copies){mkdirSync(dirname(file.path),{recursive:true,mode:0o700});writeFileSync(file.path,file.bytes,{flag:'wx',mode:0o600});}
 return checkpoint;
}
