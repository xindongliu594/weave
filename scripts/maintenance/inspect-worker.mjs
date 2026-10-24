import {workerData,parentPort} from 'node:worker_threads';
import {lstatSync} from 'node:fs';
import {scanStorage,assertStorageHeadroom} from '../../services/agent-runtime/storage-governance.mjs';
import {readEvidence} from './files.mjs';

const evidence=path=>{if(!path)return undefined;try{return readEvidence(path);}catch(error){return {code:error.code==='ENOENT'?'EVIDENCE_MISSING':['EVIDENCE_NOT_REGULAR','EVIDENCE_TOO_LARGE','EVIDENCE_CHANGED','EVIDENCE_INVALID_JSON'].includes(error.code)?error.code:'EVIDENCE_UNVERIFIED_PATH'};}};
if(parentPort){
 const {root,retentionInput,backupReport}=workerData;
 let storage,disk;
 try{const s=lstatSync(root);storage=s.isDirectory()&&!s.isSymbolicLink()?{present:true,...scanStorage(root,10000)}:{code:'STORAGE_NOT_DIRECTORY'};}catch{storage={code:'STORAGE_UNAVAILABLE'};}
 if(storage?.complete===true&&storage.links===0)try{disk=assertStorageHeadroom(root,0);}catch{disk=undefined;}
 parentPort.postMessage({storage,disk,retention:evidence(retentionInput),backup:evidence(backupReport)});
}
