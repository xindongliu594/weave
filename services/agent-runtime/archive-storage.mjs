import {existsSync,lstatSync,readdirSync} from 'node:fs';
import {join} from 'node:path';

export const RUN_ARCHIVE_LIMIT_BYTES=64*1024*1024;
export const ARCHIVE_ROOT_LIMIT_BYTES=1024*1024*1024;
/** Read only: quotas stop new work; they never remove a checkpoint or receipt. */
export function archiveStorageUsage(root){
 let bytes=0,files=0,entries=0;
 if(!existsSync(root))return {bytes,files};
 const pending=[root];
 while(pending.length){const path=pending.pop(),stat=lstatSync(path);if(++entries>100000)throw Object.assign(Error('运行档案条目过多，请先归档历史数据'),{code:'ARCHIVE_STORAGE_LIMIT'});
  if(stat.isSymbolicLink())throw Object.assign(Error('运行档案包含未核对的符号链接，不能核对容量'),{code:'ARCHIVE_STORAGE_LIMIT'});
  if(stat.isDirectory())for(const name of readdirSync(path))pending.push(join(path,name));
  else if(stat.isFile()){bytes+=stat.size;files++;}
 }
 return {bytes,files};
}
export function assertArchiveCapacity(root,maxBytes=RUN_ARCHIVE_LIMIT_BYTES){
 const usage=archiveStorageUsage(root);
 if(usage.bytes>=maxBytes)throw Object.assign(Error(`运行档案达到容量限额（${Math.round(maxBytes/1024/1024)} MiB），已停止新增调用或命令；原交付、检查点和费用保留，请先归档再继续`),{code:'ARCHIVE_STORAGE_LIMIT'});
 return usage;
}
