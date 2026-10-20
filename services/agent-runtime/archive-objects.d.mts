export function assertArchivePlain(path:string,kind:'directory'|'file'):import('node:fs').Stats;
export function syncArchiveDirectory(dir:string):void;
export function readArchiveObject(dir:string,entry:{sha256:string;size:number}):Buffer;
export function storeArchiveObjects(archiveDir:string,files:{sha256:string;size:number;content:Buffer}[],options?:{afterFsync?:(file:any)=>void}):string;
