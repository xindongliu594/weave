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
  /** Only the live, top-level source callback for this exact manager and run. */
  assertSource(runId:string):void;
  /** Exclusive maintenance may borrow writer helpers; the reverse is forbidden. */
  assertMaintenance(runId:string):void;
  assertRootExclusive():void;
  withWriter<T>(runIds:readonly string[],fn:(scope:ArchiveWriterScope)=>T|Promise<T>,options?:ArchiveFenceAcquireOptions):Promise<T>;
  withMaintenance<T>(runIds:readonly string[],fn:(scope:ArchiveWriterScope)=>T|Promise<T>,options?:ArchiveFenceAcquireOptions):Promise<T>;
  /** Original native root gate; cannot upgrade a run scope or impersonate run authority. */
  withRootExclusive<T>(fn:(scope:ArchiveWriterScope)=>T|Promise<T>,options?:ArchiveFenceAcquireOptions):Promise<T>;
  /** Read-only native source exclusion; no transferable owner or nested acquisition. */
  withSource<T>(runId:string,fn:()=>T|Promise<T>,options?:ArchiveFenceAcquireOptions):Promise<T>;
  /** Top-level source exclusion plus child-only writes. Retained producers never receive source authority. */
  withRecoverySource<T>(sourceRunId:string,childRunId:string,fn:(scope:ArchiveWriterScope)=>T|Promise<T>,options?:ArchiveFenceAcquireOptions):Promise<T>;
}
/** Startup configuration only; source approval is a separate, still closed gate. */
export function createArchiveWriterManager(options:{traceRoot:string;lockRoot?:string;workspaceRoots?:readonly string[];initializeTraceRoot?:boolean}):ArchiveWriterManager;
/** Enforce original live ownership on this production logical root. No unregister/opt-out. */
export function registerArchiveWriterRoot(manager:ArchiveWriterManager):void;
/** Require the original factory manager and its actual live source authority. */
export function assertArchiveSourceScope(manager:ArchiveWriterManager,runId:string):void;
export function bindArchiveJournal(root:string,runId:string):<T>(fn:()=>T)=>T;
export function withArchiveMutationSync<T>(root:string,runId:string,mode:'writer'|'maintenance',fn:()=>T):T;
