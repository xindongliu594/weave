import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { effectDigest } from './tool-effects.mjs';

const MAX_MESSAGE = 1024 * 1024, DEADLINE_MS = 10000;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url), base = createRequire(require.resolve('@deepseek-ai/dsh-base/package.json'));
const packages = [
  ['@deepseek-ai/cordis','4.0.2'], ['@deepseek-ai/schemastery','3.18.2'],
  ...['dsh-base','dsh-llm','dsh-session','dsh-session-projection','dsh-session-checkpoint-policy','dsh-session-persistence-jsonl','dsh-system-prompt','dsh-tools','dsh-agent','dsh-subagent','dsh-skill','dsh-tool-skill','dsh-scope','dsh-util-values','dsh-invariants'].map(name=>['@deepseek-ai/'+name,'0.1.5-rc.1']),
  ['@nanmicoder/dsh-agent-teams','0.1.20'],
];
const modules = ['dsh-llm','dsh-session','dsh-session-projection','dsh-system-prompt','dsh-tools','dsh-agent','dsh-subagent','dsh-skill','dsh-tool-skill'];
const freeze = value => { if(value && typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value; };
const failure = code => Error(code);

function checkedInput(value = {}) {
  try {
    effectDigest(value); // Reject accessors/proxies before inspecting caller-owned values.
    if(!value || Array.isArray(value) || Object.keys(value).some(key=>!['variant','includeRecovery','nativeBindings'].includes(key)))throw Error();
    const input=JSON.parse(JSON.stringify(value));
    if(!['container','local','demo'].includes(input.variant) || input.includeRecovery!==undefined && typeof input.includeRecovery!=='boolean')throw Error();
    if(input.nativeBindings!==undefined && (!Array.isArray(input.nativeBindings) || input.nativeBindings.length>32))throw Error();
    if(Buffer.byteLength(JSON.stringify(input))>256*1024)throw Error();
    return input;
  }catch{throw failure('TOOL_INVENTORY_INPUT_INVALID');}
}

function releaseFingerprint() {
  const files=[], versions=[];let bytes=0;
  const add=(file,label)=>{
    const stat=lstatSync(file);
    if(!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1 || stat.size>8*1024*1024 || files.length>=2000 || (bytes+=stat.size)>64*1024*1024)
      throw failure('TOOL_INVENTORY_SOURCE_INVALID');
    const body=readFileSync(file);
    if(body.length!==stat.size)throw failure('TOOL_INVENTORY_SOURCE_CHANGED');
    files.push({path:label,sha256:createHash('sha256').update(body).digest('hex'),bytes:body.length});
  };
  const walk=(directory,label,extensions,recursive=false)=>{
    const stat=lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw failure('TOOL_INVENTORY_SOURCE_INVALID');
    const entries=readdirSync(directory,{withFileTypes:true});if(entries.length>2000)throw failure('TOOL_INVENTORY_SOURCE_INVALID');
    for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){
      const path=join(directory,entry.name), name=label+'/'+entry.name;
      if(entry.isDirectory()){if(recursive)walk(path,name,extensions,true);}
      else if(extensions.includes(extname(entry.name)) && !entry.name.endsWith('.test.mjs'))add(path,name);
    }
  };
  // Deployment sources, not run data. Broad application coverage intentionally
  // invalidates the release when a dependency of an injected API callback changes.
  for(const directory of ['services/agent-runtime','apps/api/src','packages/contracts','services/embedding'])
    walk(join(root,directory),directory,['.mjs','.ts',...(directory==='services/embedding'?['.json']:[])],directory==='packages/contracts');
  for(const file of ['package.json','package-lock.json','services/agent-runtime/package.json','services/agent-runtime/package-lock.json'])add(join(root,file),file);
  for(const name of ['openshell-executor','native-plugin-worker','local-executor','sandbox-storage','checkpoint-test-profile']){
    const file=`apps/desktop/${name}.cjs`;add(join(root,file),file);
  }
  for(const [name,expected] of packages){
    const resolver=name==='@nanmicoder/dsh-agent-teams'||name==='@deepseek-ai/cordis'?require:base;
    const manifest=resolver.resolve(name+'/package.json'), directory=dirname(manifest);
    const within=relative(root,realpathSync(directory));if(within.startsWith('..')||isAbsolute(within))throw failure('TOOL_INVENTORY_SOURCE_OUTSIDE_RELEASE');
    const metadata=JSON.parse(readFileSync(manifest,'utf8'));
    if(metadata.name!==name||metadata.version!==expected)throw failure('TOOL_INVENTORY_VERSION_MISMATCH');
    const label='dependencies/'+name+'@'+expected;
    versions.push({name,version:expected});add(manifest,label+'/package.json');walk(join(directory,'lib'),label+'/lib',['.js','.mjs'],true);
  }
  files.sort((a,b)=>a.path.localeCompare(b.path));versions.sort((a,b)=>a.name.localeCompare(b.name));
  const sha256=createHash('sha256').update(JSON.stringify({schema:1,files,packages:versions})).digest('hex');
  return {schema:1,sha256,files,packages:versions};
}

async function inventory(input) {
  const before=releaseFingerprint();
  const [{Context},{installProductTools},{installNativePluginTools},{installEmployeeCapabilities},{captureToolDefinition},{nativeManifestId}]=await Promise.all([
    import('@deepseek-ai/cordis'),import('./product-tools.mjs'),import('./native-plugin-tools.mjs'),import('./employee-capabilities.mjs'),import('./tool-definition-effects.mjs'),import('./native-capabilities.mjs'),
  ]);
  const nativeBindings=input.nativeBindings??[], nativeNames=new Map();
  for(const binding of nativeBindings){
    if(!binding || Object.keys(binding).some(key=>!['id','manifest'].includes(key)) || binding.id!==nativeManifestId(binding.manifest))throw failure('TOOL_INVENTORY_NATIVE_INVALID');
    for(const tool of binding.manifest.tools){if(nativeNames.has(tool.name))throw failure('TOOL_INVENTORY_NATIVE_DUPLICATE');nativeNames.set(tool.name,binding.id);}
  }
  if(nativeNames.size>220)throw failure('TOOL_INVENTORY_LIMIT');
  const ctx=new Context(), fibers=[];let executions=0,result,primary;
  try{
    for(const name of modules){
      const mod=await import(pathToFileURL(base.resolve('@deepseek-ai/'+name)).href);
      const fiber=ctx.plugin(mod.default??mod,{mode:'native',catalogDescriptionMaxLength:200});fibers.push(fiber);await fiber.await();
      if(name==='dsh-tools')ctx.tools.guard(()=>{executions++;return 'TOOL_INVENTORY_EXECUTION_DISABLED';});
    }
    const teams=await import('@nanmicoder/dsh-agent-teams');
    const teamFiber=ctx.plugin(teams,{stateDir:'.agent-teams',memberProvider:'spawn',memberMaxDepth:0,maxMembers:6,slashCommand:false});fibers.push(teamFiber);await teamFiber.await();
    const snapshot={agents:[],nativeCapabilities:nativeBindings,...(input.variant==='local'?{executionTarget:{kind:'local'}}:{}),
      ...(input.variant==='demo'?{demo:{fixture:true}}:{}),...(input.includeRecovery?{recovery:{}}:{})};
    // These are the exact existing registrations. No body, callback adapter,
    // agent factory, archive, persistent session or native bundle is supplied.
    installProductTools(ctx,{snapshot});installNativePluginTools(ctx,{snapshot});
    installEmployeeCapabilities(ctx,{employee:{id:'inventory-only',tools:['knowledge_search','knowledge_read']}});
    const tools=ctx.tools.schemas().map(({name})=>{
      const registrationBinding=['skill','capability_search','capability_use'].includes(name)?'weiwu-employee-registry-v1':'weiwu-coordinator-registry-v1';
      const definition=ctx.tools.get(name), captured=captureToolDefinition(definition,registrationBinding);
      return {name,description:captured.description,parameters:definition.parameters,outputSchema:definition.output.schema,definitionSha256:captured.definitionSha256,registrationBinding,
        ...(nativeNames.has(name)?{nativeManifestId:nativeNames.get(name)}:{})};
    }).sort((a,b)=>a.name.localeCompare(b.name));
    const isolation={modelAdapters:ctx.llm.listProviders().length,agents:ctx.agents.list().length,persistence:Boolean(ctx.get('sessionPersistence')),executions,disposed:false};
    if(tools.length>256||isolation.modelAdapters||isolation.agents||isolation.persistence||executions)throw failure('TOOL_INVENTORY_ISOLATION_FAILED');
    if(releaseFingerprint().sha256!==before.sha256)throw failure('TOOL_INVENTORY_SOURCE_CHANGED');
    result={schema:1,variant:input.variant,tools,release:before,isolation};
  }catch(error){primary=error;}
  finally{
    for(const fiber of fibers.reverse())try{await fiber.dispose();}catch(error){primary??=error;}
    if(ctx.get('tools')||ctx.get('agents')||ctx.get('sessions'))primary??=failure('TOOL_INVENTORY_DISPOSE_FAILED');
  }
  if(primary)throw primary;
  result.isolation.disposed=true;return result;
}

async function isolated(mode,input) {
  return new Promise((resolveResult,reject)=>{
    const worker=new Worker(new URL(import.meta.url),{workerData:{kind:'weiwu-tool-inventory-v1',mode,input},execArgv:[],resourceLimits:{maxOldGenerationSizeMb:192},stdout:true,stderr:true});
    let result,error,outputBytes=0;
    const stop=reason=>{error??=reason;void worker.terminate();};
    const timer=setTimeout(()=>stop(failure('TOOL_INVENTORY_TIMEOUT')),DEADLINE_MS);
    for(const stream of [worker.stdout,worker.stderr])stream.on('data',chunk=>{outputBytes+=chunk.length;if(outputBytes>64*1024)stop(failure('TOOL_INVENTORY_OUTPUT_LIMIT'));});
    worker.on('message',message=>{
      if(result!==undefined||error)return stop(failure('TOOL_INVENTORY_RESPONSE_INVALID'));
      if(Buffer.byteLength(JSON.stringify(message))>MAX_MESSAGE)return stop(failure('TOOL_INVENTORY_OUTPUT_LIMIT'));
      if(message.error)error=failure(message.error);else result=message.value;
    });
    worker.on('error',reason=>{error??=reason;});
    worker.on('exit',code=>{clearTimeout(timer);if(error||code!==0||result===undefined)reject(error??failure('TOOL_INVENTORY_FAILED'));else resolveResult(freeze(result));});
  });
}

/** Fresh module cache; no configured model adapter, archive or tool calls. */
export async function inspectRuntimeToolInventory(input) { return isolated('inventory',checkedInput(input)); }
/** Hashes only the fixed application/dependency allowlist, never user business data. */
export async function readRuntimeToolRelease() { return isolated('release'); }

if(!isMainThread && workerData?.kind==='weiwu-tool-inventory-v1'){
  try{parentPort.postMessage({value:workerData.mode==='release'?releaseFingerprint():await inventory(checkedInput(workerData.input))});}
  catch(error){parentPort.postMessage({error:typeof error?.message==='string'&&/^(TOOL_INVENTORY_|NATIVE_)/.test(error.message)?error.message:'TOOL_INVENTORY_FAILED'});}
  finally{parentPort.close();}
}
