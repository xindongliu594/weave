const fs=require('node:fs'),path=require('node:path');
const SANDBOX_STORAGE_LIMITS=Object.freeze({workspaceBytes:20*1024*1024,workspaceFiles:128,workspaceEntries:512,tempBytes:64*1024*1024,tempEntries:4096,minFreeBytes:256*1024*1024});
function storageDenied(message){return Object.assign(Error(message),{code:'SANDBOX_STORAGE_LIMIT',notExecuted:true});}
function boundedStorage(root,maxBytes,maxEntries,maxFiles=maxEntries){
 const original=fs.lstatSync(root);if(!original.isDirectory()||original.isSymbolicLink())throw storageDenied('沙箱扫描根目录未核对');
 for(let attempt=0;attempt<3;attempt++){const result={bytes:0,files:0,entries:0},pending=[root];let at=root;
 try{while(pending.length){at=pending.pop();const stat=fs.lstatSync(at);
  if(++result.entries>maxEntries||stat.isSymbolicLink())throw storageDenied('沙箱磁盘条目过多或包含未核对链接，已阻止新增工作');
  if(stat.isDirectory()){const dir=fs.opendirSync(at);try{let entry;while((entry=dir.readSync())){if(result.entries+pending.length>=maxEntries)throw storageDenied('沙箱磁盘条目超过限制');pending.push(path.join(at,entry.name));}}finally{dir.closeSync();}}
  else if(stat.isFile()){result.bytes+=stat.size;result.files++;if(result.bytes>maxBytes||result.files>maxFiles)throw storageDenied('沙箱工作区或临时文件达到容量限制');}
  else throw storageDenied('沙箱目录包含非普通文件');
 }
 const current=fs.lstatSync(root);if(current.isSymbolicLink()||current.dev!==original.dev||current.ino!==original.ino)throw storageDenied('沙箱扫描根目录已变化');return result;
 }catch(error){if(at===root||!['ENOENT','ENOTDIR'].includes(error.code))throw error;
  const current=fs.lstatSync(root);if(!current.isDirectory()||current.isSymbolicLink()||current.dev!==original.dev||current.ino!==original.ino)throw storageDenied('沙箱扫描根目录已变化');
  if(attempt===2)throw storageDenied('沙箱目录持续变化，三次核对均未完成，已保留现场');
 }}
}
function checkSandboxStorage(workspace='/sandbox',temp='/tmp'){
 const limits=SANDBOX_STORAGE_LIMITS,volume=fs.statfsSync(workspace),freeBytes=volume.bavail*volume.bsize;
 if(freeBytes<limits.minFreeBytes)throw storageDenied('沙箱文件系统剩余空间不足 256 MiB');
 return {workspace:boundedStorage(workspace,limits.workspaceBytes,limits.workspaceEntries,limits.workspaceFiles),temp:boundedStorage(temp,limits.tempBytes,limits.tempEntries),disk:{freeBytes},limits,hardQuota:false,checkedAt:new Date().toISOString()};
}
module.exports={SANDBOX_STORAGE_LIMITS,storageDenied,boundedStorage,checkSandboxStorage};
