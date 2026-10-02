import type { Server } from 'node:http';
import type { Agent, Plan } from '../../packages/contracts/index.ts';
export function createDemoGateway(): Promise<Server>;
export function createDemoPlan(agents: Agent[]): Plan;
export class DemoSandbox {
  constructor(archive: any);
  root: string;
  prepare(signal?: AbortSignal): Promise<void>;
  revision(): string;
  execute(name: string, args: any, signal?: AbortSignal): Promise<any>;
  close(): Promise<void>;
}
