export type ArchiveFenceMode = 'writer' | 'source' | 'maintenance' | 'root-exclusive';
export interface ArchiveFenceGuard { release(): void }
export interface ArchiveFenceAcquireOptions { signal?: AbortSignal; timeoutMs?: number }
export interface ArchiveWriteFence {
  acquireWriter(runIds: readonly string[], options?: ArchiveFenceAcquireOptions): Promise<ArchiveFenceGuard>;
  acquireSource(runId: string, options?: ArchiveFenceAcquireOptions): Promise<ArchiveFenceGuard>;
  acquireMaintenance(runIds: readonly string[], options?: ArchiveFenceAcquireOptions): Promise<ArchiveFenceGuard>;
  acquireRootExclusive(options?: ArchiveFenceAcquireOptions): Promise<ArchiveFenceGuard>;
  assertGuard(guard: ArchiveFenceGuard, expected: { mode: ArchiveFenceMode; runId?: string }): void;
  withJournalAppendSync<T>(guard: ArchiveFenceGuard, runId: string, syncFn: () => T, options?: { timeoutMs?: number }): T;
}
/** Private primitive; production writer coverage and root mapping are caller responsibilities. */
export function createArchiveWriteFence(options: { traceRoot: string; lockRoot: string }): ArchiveWriteFence;
