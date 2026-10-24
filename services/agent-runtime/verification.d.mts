import type { RunDetail } from './trace-store.mjs';
import type { ArchiveWriterManager } from './archive-writer-scope.mjs';
export function runTraceVerification(root: string, options: {writers:ArchiveWriterManager;snapshot?:unknown}): Promise<RunDetail>;
