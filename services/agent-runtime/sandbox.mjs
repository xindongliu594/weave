import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, lstatSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { Semaphore } from './limits.mjs';
import { canonicalManifest } from '../../apps/desktop/local-executor.cjs';
export const SANDBOX_IMAGE='node:22.19.0-bookworm-slim';
export function validArtifactPath(value) {
  if(typeof value!=='string'||!value||value.length>240||value.includes('\\')||value.includes('\0')||value.startsWith('/')||value.split('/').some(p=>!p||p==='.'||p==='..'||p.startsWith('.agent')))throw Error('非法工作区路径');
  return value;
}
export function command(args,{input='',signal,limit=35*1024*1024}={}) {
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const child=spawn('docker',args,{stdio:['pipe','pipe','pipe']});let out=[],err=[],bytes=0,overflow=false;
    const abort=()=>child.kill('SIGKILL');signal?.addEventListener('abort',abort,{once:true});
    child.stdout.on('data',c=>{bytes+=c.length;if(bytes>limit){overflow=true;child.kill('SIGKILL');}else out.push(c);});
    child.stderr.on('data',c=>{if(err.reduce((n,b)=>n+b.length,0)<8192)err.push(c);});
    child.on('error',e=>{signal?.removeEventListener('abort',abort);reject(e);});
    child.on('close',code=>{signal?.removeEventListener('abort',abort);if(signal?.aborted)return reject(signal.reason);if(overflow)return reject(Error('工具输出超过大小限制'));if(code!==0)return reject(Error('Docker 操作失败: '+Buffer.concat(err).toString().slice(0,500)));resolve(Buffer.concat(out).toString());});
    child.stdin.on('error',()=>{});child.stdin.end(input);
  });
}
export function listArtifacts(root) {
  if(!existsSync(root))return [];
  const out=[];
  function walk(dir){for(const name of readdirSync(dir)){const file=join(dir,name),stat=lstatSync(file);if(stat.isSymbolicLink())continue;if(stat.isDirectory())walk(file);else if(stat.isFile()&&stat.size<=5*1024*1024){const path=relative(root,file).split('\\').join('/');validArtifactPath(path);out.push({path,size:stat.size,sha256:createHash('sha256').update(readFileSync(file)).digest('hex')});}}}
  walk(root);return out.slice(0,128);
}
export function artifactFile(root,path) {
  validArtifactPath(path);let current=resolve(root);
  for(const part of path.split('/')){current=join(current,part);if(lstatSync(current).isSymbolicLink())throw Error('不允许符号链接');}
  if(!lstatSync(current).isFile()||lstatSync(current).size>5*1024*1024)throw Error('交付物不是可下载文件或超过大小限制');
  return current;
}
const fileScript=String.raw`
const fs=require('fs'),p=require('path'),crypto=require('crypto');const hash=b=>crypto.createHash('sha256').update(b).digest('hex');let raw='';process.stdin.on('data',c=>raw+=c);process.stdin.on('end',()=>{try{const x=JSON.parse(raw);const safe=value=>{if(typeof value!=='string'||!value||value.startsWith('/')||value.includes('\\')||value.split('/').some(s=>!s||s==='.'||s==='..'))throw Error('Invalid path');let at='/workspace';for(const part of value.split('/')){at=p.join(at,part);if(fs.existsSync(at)&&fs.lstatSync(at).isSymbolicLink())throw Error('Symlinks forbidden');}return at;};
if(x.action==='write'){const file=safe(x.path);const bytes=x.encoding==='base64'?Buffer.from(x.content,'base64'):Buffer.from(x.content);if(bytes.length>5242880)throw Error('File too large');const current=fs.existsSync(file)?hash(fs.readFileSync(file)):null;if(!x.restore&&current!==(x.expectedSha256??null))throw Error('FILE_VERSION_CONFLICT: 文件已变化，请重新读取并合并后携带 sha256 写入');fs.mkdirSync(p.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);console.log(JSON.stringify({path:x.path,bytes:bytes.length,sha256:hash(bytes)}));}
else if(x.action==='read'){const file=safe(x.path);if(fs.statSync(file).size>1048576)throw Error('File too large');const bytes=fs.readFileSync(file);console.log(JSON.stringify({path:x.path,content:bytes.toString('utf8'),sha256:hash(bytes)}));}
else {let files=[],total=0;function walk(dir){for(const name of fs.readdirSync(dir)){const file=p.join(dir,name),s=fs.lstatSync(file);if(s.isSymbolicLink())continue;if(s.isDirectory())walk(file);else if(s.isFile()){if(files.length>=128||s.size>5242880||(total+=s.size)>20971520)throw Error('Artifact quota exceeded');files.push({path:p.relative('/workspace',file),content:fs.readFileSync(file).toString('base64')});}}}walk('/workspace');console.log(JSON.stringify(files));}
}catch(e){console.error(e.message);process.exitCode=1;}});`;
export class RunSandbox {
  static async assertReady(signal){
    await command(['image','inspect',SANDBOX_IMAGE],{signal,limit:100000});
  }
  constructor(id,root){this.name='agent-department-'+id;this.root=root;this.started=false;this.starting=undefined;this.mutex=new Semaphore(1);}
  async start(signal){
    if(this.started)return;
    return this.starting??=(async()=>{
      await RunSandbox.assertReady(signal);
      this.started=true;
      await command(['run','-d','--name',this.name,'--network','none','--memory','512m','--cpus','1','--pids-limit','64','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user','1000:1000','--tmpfs','/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000','--tmpfs','/workspace:rw,nosuid,size=128m,uid=1000,gid=1000','--workdir','/workspace',SANDBOX_IMAGE,'sleep','infinity'],{signal});
      this.started=true;mkdirSync(this.root,{recursive:true,mode:0o700});
      const files=listArtifacts(this.root);for(const file of files){const content=readFileSync(artifactFile(this.root,file.path)).toString('base64');await this.file('write',{path:file.path,content,encoding:'base64',restore:true},signal);}
    })();
  }
  async file(action,args,signal){return JSON.parse(await command(['exec','-i',this.name,'node','-e',fileScript],{input:JSON.stringify({action,...args}),signal}));}
  async sync(signal){
    const files=await this.file('export',{},signal);
    const paths=new Set(files.map(file=>file.path));
    for(const old of listArtifacts(this.root))if(!paths.has(old.path))unlinkSync(artifactFile(this.root,old.path));
    for(const file of files){validArtifactPath(file.path);const target=join(this.root,file.path);mkdirSync(dirname(target),{recursive:true,mode:0o700});writeFileSync(target,Buffer.from(file.content,'base64'),{mode:0o600});}
    return listArtifacts(this.root);
  }
  revision(){return createHash('sha256').update(JSON.stringify(canonicalManifest(listArtifacts(this.root)))).digest('hex');}
  async execute(name,args,signal){
    const release=await this.mutex.acquire(signal);
    const abort=()=>{void this.close();};signal?.addEventListener('abort',abort,{once:true});
    try{
      if(args.expectedWorkspaceRevision&&args.expectedWorkspaceRevision!==this.revision())throw Error('WORKSPACE_VERSION_CONFLICT: 审批后的工作区已变化，请重新申请审批');
      await this.start(signal);
      let result;
      if(name==='artifact_write'){validArtifactPath(args.path);result=await this.file('write',{path:args.path,content:args.content,expectedSha256:args.expectedSha256},signal);}
      else if(name==='filesystem'){validArtifactPath(args.path);result=await this.file('read',args,signal);}
      else {if(typeof args.command!=='string'||args.command.length>5000)throw Error('Invalid command');
        const script='timeout 60s sh -lc "$1" 2>&1; code=$?; printf "\\n[exit_code=%s]\\n" "$code"';
        result={output:await command(['exec',this.name,'sh','-c',script,'sh',args.command],{signal,limit:1024*1024})};}
      if(name==='terminal'||name==='terminal_test'){
        const match=/\n\[exit_code=(\d+)\]\n?$/.exec(result.output);
        if(!match)throw Error('COMMAND_RESULT_MISSING: 无法核对命令退出码');
        result.exitCode=Number(match[1]);result.output=result.output.slice(0,match.index);
      }
      const artifacts=await this.sync(signal);if(name==='terminal'||name==='terminal_test')await this.close();return {...result,artifacts,workspaceRevision:this.revision()};
    }finally{signal?.removeEventListener('abort',abort);release();}
  }
  async close(){if(this.started){this.started=false;this.starting=undefined;await command(['rm','-f',this.name]).catch(()=>{});}}
}
