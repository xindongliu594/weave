export const RUN_ARCHIVE_LIMIT_BYTES:number;
export const ARCHIVE_ROOT_LIMIT_BYTES:number;
export function archiveStorageUsage(root:string):{bytes:number;files:number};
export function assertArchiveCapacity(root:string,maxBytes?:number):{bytes:number;files:number};
