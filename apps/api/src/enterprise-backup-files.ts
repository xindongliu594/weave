import {constants,openSync,closeSync,readSync,fstatSync,lstatSync,readdirSync,type Stats} from 'node:fs';
import {join,relative,dirname} from 'node:path';
import {assertArchivePlain} from '../../../services/agent-runtime/archive-objects.mjs';
import {ENTERPRISE_BACKUP_LIMIT_BYTES} from './enterprise-backup-schema.ts';

const fields=['dev','ino','mode','size','mtimeMs','ctimeMs','nlink'] as const;
const same=(a:Stats,b:Stats)=>fields.every(key=>a[key]===b[key]);
const invalid=(code='BACKUP_FILE_UNSAFE')=>Object.assign(Error('备份文件不完整、被修改或包含不支持的链接。'),{status:422,code});
/** Reuse archive ancestor/link ownership checks; bound allocation before opening
 * and retain a read-set to detect changes during asynchronous SQL/encryption. */
export function createBackupFileReader(){
  let total=0,count=0;const reads=new Map<string,Stats>(),directories=new Map<string,{stat:Stats;names:string[]}>(),absent=new Set<string>();
  function read(path:string){
    try{
      const stat=assertArchivePlain(path,'file');
      if(stat.size>ENTERPRISE_BACKUP_LIMIT_BYTES||(total+=stat.size)>ENTERPRISE_BACKUP_LIMIT_BYTES||++count>100000)throw invalid('BACKUP_SIZE_LIMIT');
      const fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
      try{
        const before=fstatSync(fd);if(!same(stat,before)||!before.isFile()||before.nlink!==1)throw invalid();
        const bytes=Buffer.alloc(before.size);let offset=0;
        while(offset<bytes.length){const n=readSync(fd,bytes,offset,bytes.length-offset,null);if(!n)throw invalid();offset+=n;}
        if(readSync(fd,Buffer.alloc(1),0,1,null)!==0||!same(before,fstatSync(fd))||!same(before,assertArchivePlain(path,'file')))throw invalid();
        reads.set(path,before);return bytes;
      }finally{closeSync(fd);}
    }catch(error:any){if(error.code?.startsWith('BACKUP_'))throw error;throw invalid();}
  }
  function optional(path:string){
    try{lstatSync(path);}catch(error:any){
      if(error.code!=='ENOENT')throw invalid();
      try{assertArchivePlain(dirname(path),'directory');}catch{throw invalid();}
      absent.add(path);return null;
    }return read(path);
  }
  function tree(root:string){
    const files:Record<string,string>={};let entries=0;
    function walk(dir:string,depth:number){
      if(depth>64||++entries>100000)throw invalid('BACKUP_SIZE_LIMIT');
      const stat=assertArchivePlain(dir,'directory'),names=readdirSync(dir).sort();directories.set(dir,{stat,names});
      for(const name of names){if(++entries>100000)throw invalid('BACKUP_SIZE_LIMIT');const path=join(dir,name),entry=lstatSync(path);
        if(entry.isDirectory()&&!entry.isSymbolicLink())walk(path,depth+1);
        else files[relative(root,path).replaceAll('\\','/')]=read(path).toString('base64');
      }
    }
    try{walk(root,0);return files;}catch(error:any){if(error.code?.startsWith('BACKUP_'))throw error;throw invalid();}
  }
  function verify(){
    try{
      for(const [path,before] of reads)if(!same(before,assertArchivePlain(path,'file')))throw invalid();
      for(const [path,before] of directories)if(!same(before.stat,assertArchivePlain(path,'directory'))||JSON.stringify(before.names)!==JSON.stringify(readdirSync(path).sort()))throw invalid();
      for(const path of absent){try{lstatSync(path);}catch(error:any){if(error.code==='ENOENT'){assertArchivePlain(dirname(path),'directory');continue;}throw error;}throw invalid();}
    }catch{throw invalid('BACKUP_SOURCE_CHANGED');}
  }
  return {read,optional,tree,verify};
}
