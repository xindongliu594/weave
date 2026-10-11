export type JournalCandidate={runId:string;bytes:number;sha256:string;identity:string;snapshotSha256:string;snapshotIdentity:string};
export function assertJournalWritable(dir:string):void;
export function readJournal(dir:string):string;
export function journalArchiveCandidate(root:string,runId:string):JournalCandidate;
export function archiveJournal(root:string,candidate:JournalCandidate):{runId:string;originalBytes:number;compressedBytes:number;savedBytes:number;sha256:string};
