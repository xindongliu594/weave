import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {executionBackendSchema,type ExecutionBackend,type TaskExecutionReceipt} from '../../../packages/contracts/index.ts';
import {AppError} from './provider.ts';

export function executionBackend(value:unknown):ExecutionBackend {
 return executionBackendSchema.parse(value??{kind:'native'});
}
export function assertExecutionBackendBinding(backend:ExecutionBackend,approved:unknown) {
 if((backend.kind==='openshell'&&approved===undefined)||(approved!==undefined&&!isDeepStrictEqual(executionBackend(approved),backend)))
  throw new AppError(422,'执行环境已变化，请重新选择设备并批准方案','LOCAL_BACKEND_CHANGED');
}
const executionProofSchema=z.object({kind:z.literal('openshell'),version:z.literal('0.1.2'),gateway:z.string(),image:z.string(),
 policySha256:z.string(),fingerprint:z.string(),sandboxId:z.uuid(),sandboxName:z.string().regex(/^[a-zA-Z0-9_-]{1,19}$/),
 uid:z.literal(1000),gid:z.literal(1000),node:z.literal('v24.19.0'),
 cpu:z.tuple([z.number().int().positive(),z.number().int().positive()]).refine(([quota,period])=>quota/period===1),
 memory:z.literal('536870912'),
 effectivePolicyHash:z.literal('27ae8e91e5dd6b505e6a331bb5b24a7a2b47aced33257f4f7e7a7c892978e6b5')}).passthrough();
export function assertExecutionBackendReceipt(backend:ExecutionBackend,result:any,expectedTaskExecution?:TaskExecutionReceipt) {
 if(expectedTaskExecution&&(backend.kind!=='openshell'||!isDeepStrictEqual(result.taskExecution,expectedTaskExecution)))
  throw new AppError(422,'任务执行回执与已批准操作不符','LOCAL_BACKEND_PROOF_INVALID');
 if(backend.kind==='native'){
  if(result.execution?.kind==='openshell')throw new AppError(422,'原生执行设备不能返回沙箱执行证明','LOCAL_BACKEND_PROOF_INVALID');
  return;
 }
 const parsed=executionProofSchema.safeParse(result.execution);
 if(!parsed.success||Object.keys(backend).some(key=>(parsed.data as any)[key]!==backend[key as keyof typeof backend]))
  throw new AppError(422,'沙箱执行回执与已授权环境不符','LOCAL_BACKEND_PROOF_INVALID');
}
