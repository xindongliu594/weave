import {Worker} from 'node:worker_threads';
import {isAbsolute,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildHealthReport,encodeReport} from './health.mjs';
import {contains,plainPath,saveReport} from './files.mjs';

function parseArgs(args){
 const values={};
 for(const arg of args){const match=/^--(root|retention-input|backup-report|report-dir|timeout-ms)=(.+)$/.exec(arg);if(!match||Object.hasOwn(values,match[1]))throw Error('INVALID_ARGUMENT');values[match[1]]=match[2];}
 if(!values.root)throw Error('ROOT_REQUIRED');
 for(const key of ['root','retention-input','backup-report','report-dir'])if(values[key]){if(!isAbsolute(values[key])||/^[\\/]{2}|^[a-z]+:\/\//i.test(values[key]))throw Error('ABSOLUTE_LOCAL_PATH_REQUIRED');values[key]=resolve(values[key]);}
 const timeout=Number(values['timeout-ms']??30000);if(!Number.isSafeInteger(timeout)||timeout<1||timeout>120000)throw Error('INVALID_TIMEOUT');
 if(values['report-dir'])for(const input of [values.root,values['retention-input'],values['backup-report']].filter(Boolean)){
  try{plainPath(input);}catch(error){if(error.code!=='ENOENT')throw Error('INPUT_PATH_UNVERIFIED');}
  if(contains(input,values['report-dir'])||contains(values['report-dir'],input))throw Error('REPORT_INPUT_OVERLAP');
 }
 return {root:values.root,retentionInput:values['retention-input'],backupReport:values['backup-report'],reportDir:values['report-dir'],timeout};
}
async function inspect(options){
 const worker=new Worker(new URL('./inspect-worker.mjs',import.meta.url),{workerData:options,resourceLimits:{maxOldGenerationSizeMb:128,stackSizeMb:4}});
 return await new Promise(resolveResult=>{
  let finished=false;
  const finish=async value=>{if(finished)return;finished=true;clearTimeout(timer);await worker.terminate();resolveResult(value);};
  const timer=setTimeout(()=>{void finish({storage:{code:'INSPECTION_TIMEOUT'}});},options.timeout);
  worker.once('message',value=>{void finish(value);});
  worker.once('error',()=>{void finish({storage:{code:'INSPECTION_FAILED'}});});
  worker.once('exit',()=>{if(!finished)void finish({storage:{code:'INSPECTION_FAILED'}});});
 });
}
export async function main(args=process.argv.slice(2)){
 if(args.length===1&&args[0]==='--help'){process.stdout.write('Usage: node scripts/maintenance/report.mjs --root=<absolute-directory> [--retention-input=<absolute-json>] [--backup-report=<absolute-json>] [--report-dir=<absolute-directory>] [--timeout-ms=30000]\nOffline read-only health evidence. Exit: 0 passed, 1 failed/invalid, 2 unknown.\n');return;}
 try{
  const options=parseArgs(args),data=await inspect(options),report=buildHealthReport(data),text=encodeReport(report);
  if(options.reportDir)saveReport(options.reportDir,text);
  process.stdout.write(text);process.exitCode=report.status==='failed'?1:report.status==='unknown'?2:0;
 }catch(error){process.stderr.write('Maintenance report failed: '+(/^[A-Z][A-Z0-9_]{0,63}$/.test(error.message)?error.message:'REPORT_IO_FAILED')+'\n');process.exitCode=1;}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await main();
