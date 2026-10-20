import type { ArchiveFenceAcquireOptions } from './archive-write-fence.mjs';
export interface ArchiveWriterProducer {
  run<T>(fn:()=>T):T;
  /** Finish after original work settles. An early finish cannot release an in-flight run(). */
  finish(error?:unknown):void;
}
export interface ArchiveWriterScope {
  retain(label:string):ArchiveWriterProducer;
}
export interface ArchiveWriterOwner extends ArchiveWriterProducer,ArchiveWriterScope {
  readonly writerDrained:Promise<void>;
  closeAdmission():void;
}
export interface ArchiveWriterManager {
  readonly traceRoot:string;
  readonly lockRoot:string;
  acquireOwner(runIds:readonly string[],options?:ArchiveFenceAcquireOptions):Promise<ArchiveWriterOwner>;
  assertOwner(owner:ArchiveWriterOwner,runId:string):void;
  assertWriter(runId:string):void;
  withWriter<T>(runIds:readonly string[],fn:(scope:ArchiveWriterScope)=>T|Promise<T>,options?:ArchiveFenceAcquireOptions):Promise<T>;
}
/** Startup configuration only; source approval and strict trace registration remain disabled. */
export function createArchiveWriterManager(options:{traceRoot:string;lockRoot?:string;workspaceRoots?:readonly string[]}):ArchiveWriterManager;
