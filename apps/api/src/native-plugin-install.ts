import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync, lstatSync, statfsSync } from 'node:fs';
import { dirname, join, basename, resolve } from 'node:path';
import { z } from 'zod';
import { nativeCapabilityRoot, readNativeBundle, restoreNativeBundles } from './native-capabilities.ts';
import { nativeManifestId } from '../../../services/agent-runtime/native-capabilities.mjs';
import { buildNativeToolBundle } from '../../../scripts/plugins/build-native-tool-bundle.mjs';

const name=z.string().regex(/^(?:@[a-z0-9][a-z0-9_.-]*\/)?[a-z0-9][a-z0-9_.-]*$/).max(214);
const version=z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/).max(80);
const field=z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const policy=z.object({read:z.array(field).max(40),write:z.array(z.union([field,z.object({field,fallback:field}).strict()])).max(40)}).strict();
const recipe=z.object({namespace:z.string().regex(/^[a-z][a-z0-9_]{0,19}$/),package:name,version,config:z.record(z.string(),z.unknown()),files:z.record(field,policy)}).strict().refine(value=>!/(?:password|secret|api.?key|token|credential)/i.test(JSON.stringify(value.config))&&JSON.stringify(value.config).length<=16384&&Object.keys(value.files).length>=1&&Object.keys(value.files).length<=48,{message:'config and tool inventory must be bounded'});
const npmRequest=z.object({kind:z.literal('npm'),recipe}).strict();
const portableRequest=z.object({kind:z.literal('portable'),id:z.string().regex(/^[a-f0-9]{64}$/),manifest:z.unknown(),compressed:z.string().max(6*1024*1024),metadata:z.string().max(24000)}).strict();
export const installRequest=z.discriminatedUnion('kind',[npmRequest,portableRequest]);
type Request=z.infer<typeof installRequest>;
type InstallState={id:string;kind:'npm'|'portable';stage:'queued'|'installing'|'building'|'verifying'|'complete'|'failed'|'interrupted';createdAt:string;updatedAt:string;bundleId?:string;error?:string;scratchName?:string;scratchUnsafe?:boolean;childPid?:number};
const activeStages=new Set(['queued','installing','building','verifying']);
function assertPackageSize(directory:string){let files=0,bytes=0;const visit=(path:string)=>{let names:string[];try{names=readdirSync(path);}catch(error:any){if(error?.code==='ENOENT')return;throw error;}for(const name of names){if(name==='.bin')continue;const file=join(path,name);let stat;try{stat=lstatSync(file);}catch(error:any){if(error?.code==='ENOENT')continue;throw error;}if(stat.isSymbolicLink())continue;if(stat.isDirectory())visit(file);else if(stat.isFile()){files++;bytes+=stat.size;}if(files>20000||bytes>256*1024*1024)throw Error('NATIVE_PACKAGE_LIMIT');}};visit(directory);}
function assertInstallSpace(scratch:string){assertPackageSize(scratch);const disk=statfsSync(scratch);if(Number(disk.bavail)*Number(disk.bsize)<512*1024*1024)throw Error('NATIVE_DISK_RESERVE');}
function cleanupOwnedScratch(root:string,name:string|undefined){if(!name)return true;if(!/^\.install-[a-zA-Z0-9_-]{6}$/.test(name))return false;const path=resolve(root,name);if(dirname(path)!==resolve(root))return false;const owner=lstatSync(root);if(!owner.isDirectory()||owner.isSymbolicLink())return false;let stat;try{stat=lstatSync(path);}catch(error:any){if(error?.code==='ENOENT')return true;throw error;}if(!stat.isDirectory()||stat.isSymbolicLink())return false;rmSync(path,{recursive:true});return true;}
const publicState=(state:InstallState)=>{const {scratchName:_private,scratchUnsafe:_unsafe,childPid:_pid,...visible}=state;return visible;};
function childMayBeAlive(pid:number|undefined){if(pid===undefined)return false;if(!Number.isSafeInteger(pid)||pid<1)return true;try{process.kill(pid,0);return true;}catch(error:any){return error?.code!=='ESRCH';}}
function safeError(error:unknown) {
 const message=String(error instanceof Error?error.message:error);
 if(message.includes('NATIVE_SCHEMA_PROBE_FAILED'))return '插件工具探测失败；检查插件是否兼容当前 DSH 工具接口和本机受限运行环境。';
 if(message.includes('NATIVE_TOOL_INVENTORY_CHANGED'))return '接入配置的 files 必须逐一列出插件实际注册的工具。';
 if(message.includes('NATIVE_VERSION_CONFLICT'))return '相同版本编号的安装文件与既有记录不同；请检查来源完整性。';
 if(message.includes('NATIVE_BACKUP')||message.includes('NATIVE_BUNDLE')||message.includes('NATIVE_MANIFEST'))return '可移植安装包格式或哈希校验失败。';
 if(message.includes('NPM_UNAVAILABLE'))return '本机缺少标准 npm CLI；安装 Node.js 自带 npm 后重试。';
 if(message.includes('NPM_FAILED'))return '公共 npm 下载失败；核对精确包版本、网络和依赖后重试。';
 if(message.includes('NATIVE_NPM_PERMISSION_DENIED'))return 'npm 或插件依赖请求了安装沙箱外的权限，已拒绝；请核对包的兼容性。';
 if(message.includes('NATIVE_PACKAGE_LIMIT'))return '插件依赖超过安装空间限制。';
 if(message.includes('NATIVE_PACKAGE_ENTRY_DENIED')||message.includes('NATIVE_PACKAGE_SOURCE_DENIED'))return '插件入口或依赖越出安装目录，已拒绝；请核对原包或接入方式。';
 if(message.includes('NATIVE_DISK_RESERVE'))return '可用磁盘空间不足，安装已终止；请释放空间后重试。';
 if(message.includes('NATIVE_PACKAGE_VERSION_MISMATCH'))return '下载包名或版本与接入配置不符。';
 return '插件安装失败；请核对包格式、依赖及兼容性后重试。';
}
export function createNativeInstallManager(root=nativeCapabilityRoot(), buildBundle=buildNativeToolBundle) {
 const directory=join(root,'install-jobs');mkdirSync(directory,{recursive:true,mode:0o700});
 const states=new Map<string,InstallState>();let active=false;
 for(const file of readdirSync(directory))if(/^[a-f0-9-]{36}\.json$/.test(file))try{
  const state=JSON.parse(readFileSync(join(directory,file),'utf8')) as InstallState;
  if(activeStages.has(state.stage)||state.scratchName){let cleaned=false;try{if(!state.scratchUnsafe&&!childMayBeAlive(state.childPid))cleaned=cleanupOwnedScratch(root,state.scratchName);}catch{}if(activeStages.has(state.stage))state.stage='interrupted';state.error=cleaned?(state.stage==='interrupted'?'服务已重启，安装已中断；请重新提交。':state.error):'暂存目录归属或子进程退出无法确认，请管理员检查。';if(cleaned){delete state.scratchName;delete state.scratchUnsafe;delete state.childPid;}state.updatedAt=new Date().toISOString();writeFileSync(join(directory,file),JSON.stringify(state));}
  states.set(state.id,state);
 }catch{}
 function save(state:InstallState,stage:InstallState['stage'],extra:Partial<InstallState>={}){Object.assign(state,{stage,updatedAt:new Date().toISOString()},extra);const target=join(directory,state.id+'.json'),tmp=target+'.tmp';writeFileSync(tmp,JSON.stringify(state),{mode:0o600});renameSync(tmp,target);}
 async function execute(state:InstallState,input:Request) {
  let scratch:string|undefined,preserveScratch=false;
  try {
   if(input.kind==='portable'){
    save(state,'verifying');
    if(nativeManifestId(input.manifest)!==input.id)throw Error('NATIVE_MANIFEST_INVALID');
    restoreNativeBundles({[input.id]:{manifest:input.manifest,compressed:input.compressed,metadata:input.metadata}},root);
    readNativeBundle(input.id,root);save(state,'complete',{bundleId:input.id});return;
   }
   const def=input.recipe;
   save(state,'installing');
   scratch=mkdtempSync(join(root,'.install-'));
   save(state,'installing',{scratchName:basename(scratch)});
   const npmCli=[join(dirname(process.execPath),'node_modules','npm','bin','npm-cli.js'),join(dirname(dirname(process.execPath)),'lib','node_modules','npm','bin','npm-cli.js'),'/usr/share/nodejs/npm/bin/npm-cli.js','/usr/local/lib/node_modules/npm/bin/npm-cli.js'].find(existsSync);
   if(!npmCli)throw Error('NPM_UNAVAILABLE');
   const env:NodeJS.ProcessEnv={};for(const key of ['SystemRoot','WINDIR','LANG'])if(process.env[key])env[key]=process.env[key];
   env.PATH=process.platform==='win32'?[dirname(process.execPath),join(process.env.SystemRoot??'C:\\Windows','System32')].join(';'):'/usr/bin:/bin';
   const temp=join(scratch,'tmp');mkdirSync(temp,{mode:0o700});env.TEMP=temp;env.TMP=temp;env.TMPDIR=temp;
   env.npm_config_userconfig=join(scratch,'empty.npmrc');env.npm_config_globalconfig=join(scratch,'empty-global.npmrc');
   writeFileSync(env.npm_config_userconfig,'');writeFileSync(env.npm_config_globalconfig,'');
   env.npm_config_cache=join(scratch,'cache');env.npm_config_registry='https://registry.npmjs.org/';env.npm_config_ignore_scripts='true';env.npm_config_audit='false';env.npm_config_fund='false';env.npm_config_legacy_peer_deps='true';
   writeFileSync(join(scratch,'package.json'),JSON.stringify({private:true,name:'native-plugin-isolation',version:'1.0.0'}));
   assertInstallSpace(scratch);
   const abort=new AbortController();let resourceError:Error|undefined;
   const timer=setInterval(()=>{try{assertInstallSpace(scratch!);}catch(error){resourceError=error as Error;abort.abort();}},500);
   let child:ReturnType<typeof execFile>|undefined,closed=false,resolveClose!:()=>void;
   const close=new Promise<void>(resolve=>{resolveClose=resolve;});
   const npmReadRoot=npmCli.startsWith('/usr/share/nodejs/')?'/usr/share/nodejs':dirname(dirname(npmCli));
   save(state,'installing',{scratchUnsafe:true});
   let npmStderr='';
   const completion=new Promise<void>((resolve,reject)=>{child=execFile(process.execPath,['--permission',`--allow-fs-read=${npmReadRoot}`,`--allow-fs-read=${scratch}`,`--allow-fs-write=${scratch}`,npmCli,'install','--ignore-scripts','--bin-links=false','--no-audit','--no-fund','--legacy-peer-deps','--save-exact',`${def.package}@${def.version}`],{cwd:scratch,env,signal:abort.signal,timeout:120000,maxBuffer:1024*1024,windowsHide:true},(error,_stdout,stderr)=>{npmStderr=stderr??'';error?reject(error):resolve();});child.once('close',()=>{closed=true;resolveClose();});});
   try {if(child?.pid)save(state,'installing',{childPid:child.pid,scratchUnsafe:false});await completion;}catch(error:any){const permission=/ERR_ACCESS_DENIED|ERR_UNKNOWN_OPTION|operation not permitted/i.test(npmStderr)||['EACCES','EPERM','ERR_ACCESS_DENIED'].includes(String(error?.code));throw resourceError??Error(permission?'NATIVE_NPM_PERMISSION_DENIED':'NPM_FAILED');}finally{clearInterval(timer);if(!closed){await Promise.race([close,new Promise(resolve=>setTimeout(resolve,5000))]);if(!closed){child?.kill('SIGKILL');await Promise.race([close,new Promise(resolve=>setTimeout(resolve,5000))]);}if(!closed){preserveScratch=true;state.scratchUnsafe=true;save(state,state.stage);}}if(closed){delete state.childPid;delete state.scratchUnsafe;save(state,state.stage);}}
   if(preserveScratch)throw Error('NPM_CHILD_STILL_RUNNING');
   const lock=join(scratch,'package-lock.json');if(!existsSync(lock))throw Error('NPM_FAILED');
   assertPackageSize(join(scratch,'node_modules'));
   const lockData=JSON.parse(readFileSync(lock,'utf8'));const locked=lockData.packages?.[`node_modules/${def.package}`];
   if(locked?.version!==def.version||typeof locked.integrity!=='string'||Object.values(lockData.packages??{}).some((entry:any)=>entry.resolved&&!String(entry.resolved).startsWith('https://registry.npmjs.org/')))throw Error('NPM_FAILED');
   const definition={...def,source:{kind:'npm',reference:`${def.package}@${def.version}`,integrity:locked.integrity}};
   const definitionFile=join(scratch,'definition.json');writeFileSync(definitionFile,JSON.stringify(definition));
   save(state,'building');const built=await buildBundle(definitionFile,join(scratch,'node_modules',...def.package.split('/')),lock,root);
   save(state,'verifying');readNativeBundle(built.id,root);save(state,'complete',{bundleId:built.id});
  }catch(error){save(state,'failed',{error:preserveScratch?'npm 子进程未确认退出；暂存目录已保留，请管理员检查。':safeError(error)});}finally{try{if(scratch&&!preserveScratch){if(!cleanupOwnedScratch(root,basename(scratch)))throw Error('NATIVE_CLEANUP_UNPROVEN');delete state.scratchName;save(state,state.stage);}}catch{save(state,state.stage,{error:'安装暂存目录清理失败，请管理员检查安装空间。'});}finally{active=false;}}
 }
 return {start(raw:unknown){const input=installRequest.parse(raw);if(active)throw Object.assign(Error('已有安装任务正在执行，请等待完成。'),{status:409});if(states.size>=200)throw Object.assign(Error('安装记录已满，请联系管理员归档。'),{status:422});if(readdirSync(root).filter(name=>/^[a-f0-9]{64}$/.test(name)).length>=100&&(input.kind==='npm'||!existsSync(join(root,input.id))))throw Object.assign(Error('插件版本目录已满，请先归档未引用版本。'),{status:422});active=true;const id=randomUUID();const now=new Date().toISOString();const state:InstallState={id,kind:input.kind,stage:'queued',createdAt:now,updatedAt:now};states.set(id,state);try{save(state,'queued');}catch(error){states.delete(id);active=false;throw error;}void execute(state,input);return publicState(state);},get(id:string){const state=states.get(id);return state&&publicState(state);}};
}
