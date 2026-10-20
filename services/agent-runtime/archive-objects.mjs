import {constants,lstatSync,fstatSync,openSync,readFileSync,writeSync,fsyncSync,closeSync,existsSync,mkdirSync} from 'node:fs';
import {join,resolve,parse,relative,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {assertArchiveCapacity,archiveStorageUsage,RUN_ARCHIVE_LIMIT_BYTES} from './archive-storage.mjs';
const sha=/^[a-f0-9]{64}$/,hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const invalid=()=>Object.assign(Error('ARCHIVE_OBJECT_INVALID'),{code:'ARCHIVE_OBJECT_INVALID'});
const unsafe=()=>Object.assign(Error('ARCHIVE_PATH_UNSAFE'),{code:'ARCHIVE_PATH_UNSAFE'});
export function assertArchivePlain(path,kind){
 let at=parse(resolve(path)).root;
 for(const part of relative(at,resolve(path)).split(sep).filter(Boolean)){
  at=join(at,part);const s=lstatSync(at);
  if(s.isSymbolicLink()||s.isFile()&&s.nlink!==1)throw unsafe();
 }
 const stat=lstatSync(path);
 if(kind==='directory'?!stat.isDirectory():!stat.isFile()||stat.nlink!==1)throw unsafe();return stat;
}
// Windows cannot open directory handles with Node's fs.open. File fsync is
// mandatory everywhere; POSIX also persists directory entries. No other error
// is suppressed. Physical Windows power-loss durability is a deployment gate.
export function syncArchiveDirectory(dir){
 assertArchivePlain(dir,'directory');if(process.platform==='win32')return;
 const fd=openSync(dir,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
}
export function readArchiveObject(dir,entry){
 if(!sha.test(entry?.sha256??'')||!Number.isSafeInteger(entry.size)||entry.size<0||entry.size>5*1024*1024)throw invalid();
 assertArchivePlain(dir,'directory');const target=join(dir,entry.sha256),stat=assertArchivePlain(target,'file');
 if(stat.size!==entry.size)throw invalid();
 const fd=openSync(target,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 try{
  const before=fstatSync(fd);if(!before.isFile()||before.nlink!==1||before.size!==entry.size)throw invalid();
  const bytes=readFileSync(fd),after=fstatSync(fd),latest=lstatSync(target);
  if(bytes.length!==entry.size||hash(bytes)!==entry.sha256||['dev','ino','size','mtimeMs','ctimeMs','nlink'].some(key=>before[key]!==after[key]||after[key]!==latest[key]))throw invalid();
  return bytes;
 }finally{closeSync(fd);}
}
/** Immutable, bounded SHA objects. A failed exclusive write is retained and
 * fails verification on retry; no head can publish a partial or corrupt blob. */
export function storeArchiveObjects(archiveDir,files,{afterFsync}={}){
 assertArchivePlain(archiveDir,'directory');assertArchiveCapacity(archiveDir);
 const dir=join(archiveDir,'checkpoint-objects');
 if(!existsSync(dir)){mkdirSync(dir,{mode:0o700});syncArchiveDirectory(archiveDir);}assertArchivePlain(dir,'directory');
 let total=0;
 for(const file of files){
  if(!sha.test(file.sha256??'')||!Buffer.isBuffer(file.content)||file.content.length!==file.size||file.size>5*1024*1024||(total+=file.size)>20*1024*1024||hash(file.content)!==file.sha256)throw invalid();
 }
 if(files.length>128)throw invalid();
 const fresh=new Map(files.filter(f=>!existsSync(join(dir,f.sha256))).map(f=>[f.sha256,f]));
 if(archiveStorageUsage(archiveDir).bytes+[...fresh.values()].reduce((sum,f)=>sum+f.size,0)+1024>RUN_ARCHIVE_LIMIT_BYTES)throw Error('CHECKPOINT_STORAGE_LIMIT');
 for(const file of files){
  const target=join(dir,file.sha256);
  if(existsSync(target))readArchiveObject(dir,file);
  else{
   const fd=openSync(target,'wx',0o600);
   try{let offset=0;while(offset<file.content.length){const n=writeSync(fd,file.content,offset,file.content.length-offset);if(!n)throw invalid();offset+=n;}fsyncSync(fd);}
   finally{closeSync(fd);}
  }
  // Re-sync an existing verified object too: it might be a complete write whose
  // first fsync acknowledgement was lost before a crash.
  // Windows FlushFileBuffers requires a writable handle. Opening r+ does not
  // truncate or change bytes; validation still runs before and after syncing.
  const fd=openSync(target,(process.platform==='win32'?constants.O_RDWR:constants.O_RDONLY)|(constants.O_NOFOLLOW??0));try{fsyncSync(fd);}finally{closeSync(fd);}
  syncArchiveDirectory(dir);readArchiveObject(dir,file);afterFsync?.(file);
 }
 syncArchiveDirectory(archiveDir);
 return dir;
}
