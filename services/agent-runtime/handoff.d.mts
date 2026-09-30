export function teamTaskPlan(tasks: any[]): any[];
export function stageApprovedTeam(host: any, captain: any, plan: any, signal?: AbortSignal): Promise<any>;
export function inspectArtifact(root: string, declaration: any): { path: string; sha256: string; size: number };
export function workspaceRevision(root: string): string;
export class HandoffGate {
  constructor(options:any);
  commit(record:any):void;
}
