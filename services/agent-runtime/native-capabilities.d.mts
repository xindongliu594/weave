export function validateNativeManifest(value: any): any;
export function nativeManifestId(manifest: any): string;
export function nativeToolBinding(snapshot: any, name: string): any;
export function nativeFileAccess(tool: any, args: any): {read: string[]; write: string[]};
export function assertNativeTaskAccess(snapshot: {agents: any[]; tasks: any[]; nativeCapabilities: any[]}): void;
