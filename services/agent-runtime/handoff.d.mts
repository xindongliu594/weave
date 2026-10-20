export function teamTaskPlan(tasks: any[]): any[];
export function stageApprovedTeam(host: any, captain: any, plan: any, signal?: AbortSignal): Promise<any>;
export function inspectArtifact(root: string, declaration: any): { path: string; sha256: string; size: number };
export function workspaceRevision(root: string): string;
export class HandoffGate {
  constructor(options:any);
  assertRunCheckpointReady():void;
  failCheckpointPublication(error:Error):Error;
  failCheckpoint(taskId:string,attemptId:string,generation:number,error:Error):void;
  assertCheckpointReady(taskId:string,attemptId:string,generation:number):void;
  bindCheckpoint(taskId:string,attemptId:string,refs:import('../../packages/contracts/task-execution.ts').TaskCheckpointRefs,context?:{sessionId:string}):void;
  bindExecutionScope(taskId:string,attemptId:string,scope:any):void;
  taskWorkRevision(taskId:string,attemptId:string):string;
  prepare(taskId:string,attemptId:string,update:any):any;
  observe(taskId:string,attemptId:string,name:string,args:any,result:any,before:any[],context?:any):void;
  commit(record:any):void;
}
