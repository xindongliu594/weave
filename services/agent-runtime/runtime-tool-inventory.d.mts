export type ToolVariant = 'container' | 'local' | 'demo';
export type RuntimeToolEntry = Readonly<{
  name: string; description: string; parameters: unknown; outputSchema: unknown; definitionSha256: string;
  registrationBinding: 'weiwu-employee-registry-v1' | 'weiwu-coordinator-registry-v1'; nativeManifestId?: string;
}>;
export type RuntimeToolRelease = Readonly<{
  schema: 1; sha256: string;
  files: readonly Readonly<{path:string;sha256:string;bytes:number}>[];
  packages: readonly Readonly<{name:string;version:string}>[];
}>;
export type RuntimeToolInventory = Readonly<{
  schema:1; variant:ToolVariant; tools:readonly RuntimeToolEntry[]; release:RuntimeToolRelease;
  isolation:Readonly<{modelAdapters:0;agents:0;persistence:false;executions:0;disposed:true}>;
}>;
export function inspectRuntimeToolInventory(input:{variant:ToolVariant;includeRecovery?:boolean;nativeBindings?:readonly Readonly<{id:string;manifest:unknown}>[]}):Promise<RuntimeToolInventory>;
export function readRuntimeToolRelease():Promise<RuntimeToolRelease>;
