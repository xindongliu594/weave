// Operator bootstrap only. No CLI execution, network request, model call or host command.
const fs=require('node:fs'),path=require('node:path');
const {createHash,randomBytes,randomUUID}=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const FIXED=Object.freeze({version:'0.1.2',cliSha256:'f334da80f867776dde9034e0ca3c2406d48ba77b0d0abe64b5aa610490a34fca',gateway:'weiwu-openshell-v012',image:'docker.io/library/node:24.19.0-bookworm-slim@sha256:e5a8dee7bc1e6a215d224a7ef8206f7e77271bc3cabd5febf2beafac0674f174',policyHash:'997f69aba4386ad9f67410ba9221626d507851f0524258d22bfd28f9ffba9bee',cpu:'1',memory:'512Mi'});
const fields=['version','cliPath','cliSha256','home','gateway','image','policyPath','policyHash','cpu','memory'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function fail(message,code='OPENSHELL_CONFIG_INVALID'){throw Object.assign(Error(message),{code});}
function canonical(value,directory=false){
 if(typeof value!=='string'||!path.isAbsolute(value)||path.resolve(value)!==value)fail('OpenShell 配置路径必须是规范绝对路径');
 let at=path.parse(value).root;
 for(const part of value.slice(at.length).split(path.sep).filter(Boolean)){
  at=path.join(at,part);if(fs.lstatSync(at).isSymbolicLink())fail('OpenShell 配置路径不能包含符号链接');
 }
 const stat=fs.lstatSync(value);
 if(directory?!stat.isDirectory():!stat.isFile())fail('OpenShell 配置路径类型不正确');
 return value;
}
function readConfig(file,{fingerprint,expected=FIXED,readBytes=fs.readFileSync}={}){
 if(typeof fingerprint!=='function')fail('OpenShell 配置指纹实现不可用');
 canonical(file);if(fs.statSync(file).size>16384)fail('OpenShell 启动配置超过大小限制');
 let config;try{config=JSON.parse(fs.readFileSync(file,'utf8'));}catch{fail('OpenShell 启动配置不是合法 JSON');}
 if(!config||typeof config!=='object'||Array.isArray(config)||Object.keys(config).some(k=>!fields.includes(k))||fields.some(k=>typeof config[k]!=='string'))fail('OpenShell 启动配置字段不完整或包含未允许的字段');
 for(const [key,value]of Object.entries(expected))if(config[key]!==value)fail('OpenShell 固定版本、镜像、策略或资源配置不匹配');
 canonical(config.cliPath);canonical(config.home,true);canonical(config.policyPath);
 if(hash(readBytes(config.cliPath))!==config.cliSha256)fail('OpenShell CLI 文件与固定哈希不一致','OPENSHELL_CLI_CHANGED');
 if(hash(readBytes(config.policyPath))!==config.policyHash)fail('OpenShell 策略文件与固定哈希不一致','OPENSHELL_POLICY_CHANGED');
 const value=fingerprint(config);if(!/^[a-f0-9]{64}$/.test(value))fail('OpenShell 配置指纹不正确');
 return {config,fingerprint:value};
}
function locations(root){
 canonical(root,true);return {directory:path.join(root,'openshell'),deviceFile:path.join(root,'openshell','device.credential'),workspacesPath:path.join(root,'openshell','workspaces'),journalRoot:path.join(root,'openshell','journal')};
}
function readDevice(root,unseal){
 const paths=locations(root);if(!fs.existsSync(paths.deviceFile))return undefined;
 canonical(paths.deviceFile);if(fs.statSync(paths.deviceFile).size>16384)fail('OpenShell 设备凭据超过大小限制','OPENSHELL_DEVICE_INVALID');let device;
 try{device=JSON.parse(unseal(fs.readFileSync(paths.deviceFile,'utf8')));}catch{fail('OpenShell 已保存的设备凭据无法读取','OPENSHELL_DEVICE_INVALID');}
 if(!/^[a-f0-9-]{36}$/.test(device?.id)||!/^[a-f0-9]{64}$/.test(device?.token)||!/^[a-f0-9-]{36}$/.test(device?.grant?.id)||device.grant.root!==paths.workspacesPath||device.grant.allowCommands!==true||device.backend?.kind!=='openshell'||! /^[a-f0-9]{64}$/.test(device.backend.fingerprint??''))fail('OpenShell 已保存的设备授权不正确','OPENSHELL_DEVICE_INVALID');
 return device;
}
function prepareDevice({root,config,fingerprint,seal,unseal,reenable=false}){
 const paths=locations(root);
 for(const value of [paths.directory,paths.workspacesPath,paths.journalRoot]){if(!fs.existsSync(value))fs.mkdirSync(value,{mode:0o700});canonical(value,true);}
 const backend={kind:'openshell',version:config.version,gateway:config.gateway,image:config.image,policySha256:config.policyHash,fingerprint};
 const previous=readDevice(root,unseal);
 if(previous&&!isDeepStrictEqual(previous.backend,backend))fail('OpenShell 配置已改变，原授权不能沿用；保留原设备和回执，请建立新的明确授权','OPENSHELL_GRANT_CHANGED');
 if(previous&&!reenable)return {...paths,device:previous,backend};
 const device={id:randomUUID(),token:randomBytes(32).toString('hex'),name:'OpenShell 隔离执行设备',backend,grant:{id:randomUUID(),root:paths.workspacesPath,allowCommands:true}};
 const sealed=seal(JSON.stringify(device));
 if(previous){
  const oldBytes=fs.readFileSync(paths.deviceFile);fs.writeFileSync(paths.deviceFile+'.retired-'+randomUUID(),oldBytes,{flag:'wx',mode:0o600});
  const prepared=paths.deviceFile+'.prepared-'+randomUUID();
  fs.writeFileSync(prepared,sealed,{flag:'wx',mode:0o600});
  // Atomic replacement protects the previous encrypted credential on failure.
  // The retired copy and a failed prepared file remain private audit evidence.
  fs.renameSync(prepared,paths.deviceFile);
 }else fs.writeFileSync(paths.deviceFile,sealed,{flag:'wx',mode:0o600});
 return {...paths,device,backend};
}
async function prepareApprovedDevice({root,config,fingerprint,seal,unseal,assertApproved}){
 if(typeof assertApproved!=='function')fail('企业模式缺少设备授权检查','OPENSHELL_DEVICE_INVALID');
 const saved=readDevice(root,unseal);
 if(!saved)fail('企业模式需要已保存且由管理员登记的 OpenShell 设备','OPENSHELL_DEVICE_INVALID');
 await assertApproved(saved);
 // Enterprise startup never rotates a saved grant, including explicit re-enable.
 const opened=prepareDevice({root,config,fingerprint,seal,unseal,reenable:false});
 if(opened.device.id!==saved.id||opened.device.grant.id!==saved.grant.id)fail('OpenShell 已保存的授权发生变化','OPENSHELL_GRANT_CHANGED');
 return opened;
}
module.exports={FIXED,readConfig,readDevice,prepareDevice,prepareApprovedDevice,locations};
