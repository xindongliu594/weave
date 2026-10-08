import type { Server } from 'node:http';
export function assertLocalStaticBuild(buildRoot: string): Promise<string>;
export function createLocalStaticWeb(options: {
  buildRoot: string;
  apiPort: number;
  webPort: number;
  allowedOrigins?: ReadonlySet<string>;
}): Promise<{ server: Server; listen(): Promise<void>; close(): Promise<void> }>;
