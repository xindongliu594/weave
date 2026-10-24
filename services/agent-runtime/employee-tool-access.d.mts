import type {Context} from '@deepseek-ai/cordis';
import type {ToolDispatchExecution,ToolDefinition} from '@deepseek-ai/dsh-tools';
import type {EffectContract} from '../../packages/contracts/tool-effects.ts';
import type {CapturedToolDefinition} from './tool-definition-effects.mjs';
export const EMPLOYEE_INFRASTRUCTURE_TOOLS:readonly string[];
export function installEmployeeToolAccess(ctx:Context,agentCtx:Context,input:{
  agent:NonNullable<ToolDispatchExecution['agent']>;employee:{tools:string[]};infrastructureNames?:readonly string[];
  boundary?:{setPolicy(check:(exec:ToolDispatchExecution,actual?:ToolDefinition)=>string|undefined):void};
  sourceCheck?:(name:string)=>boolean;effectContracts?:Map<string,EffectContract>;
  contractBinding?:(name:string)=>CapturedToolDefinition|undefined;
}):{check(exec:ToolDispatchExecution,actual?:ToolDefinition):string|undefined;catalog():{name:string;description:string;effectContract:unknown}[];granted:string[];removed:string[]};
