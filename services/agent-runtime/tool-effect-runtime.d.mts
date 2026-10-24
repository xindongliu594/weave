import type {Context} from '@deepseek-ai/cordis';
import type {ToolRunContext,ToolDispatchExecution} from '@deepseek-ai/dsh-tools';
import type {EffectContract} from '../../packages/contracts/tool-effects.ts';
import type {RuntimeOperations} from '../../apps/api/src/tool-operations.ts';
export interface RuntimeEffectBoundary {
  setBodyPolicy(check:(exec:ToolRunContext)=>string|undefined):void;
}
export function installToolEffectRuntime(ctx:Context,input:{
  operations:RuntimeOperations;contracts:Map<string,EffectContract>;
  access:{check(exec:ToolDispatchExecution):string|undefined};boundary:RuntimeEffectBoundary;
  employee:{id:string;role?:string};activeWork?:(agent:NonNullable<ToolRunContext['agent']>)=>{taskId?:string};
  prepareArguments?:(exec:ToolDispatchExecution)=>unknown;timeoutMs?:number;
}):{effectiveArguments(exec:ToolRunContext):unknown;stopAdmission():void;close():Promise<void>};
