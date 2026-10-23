// Consume an installed, reviewed native package. Package installation remains
// DSH/pnpm's responsibility; this script only packages the sandbox entry point.
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, renameSync, realpathSync, lstatSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { nativeManifestId } from '../../services/agent-runtime/native-capabilities.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export async function buildNativeToolBundle(definitionFile, installedPackage, lockFile, outputRoot) {
definitionFile=resolve(definitionFile);installedPackage=resolve(installedPackage);lockFile=resolve(lockFile);outputRoot=resolve(outputRoot);
const definition = JSON.parse(readFileSync(definitionFile, 'utf8'));
const pkg = JSON.parse(readFileSync(join(installedPackage, 'package.json'), 'utf8'));
if (pkg.name !== definition.package || pkg.version !== definition.version) throw Error('NATIVE_PACKAGE_VERSION_MISMATCH');
const packageRoot=realpathSync(installedPackage), runtimeModules=realpathSync(join(repo,'services/agent-runtime/node_modules'));
let modulesRoot=dirname(packageRoot);while(modulesRoot!==dirname(modulesRoot)&&basename(modulesRoot).toLowerCase()!=='node_modules')modulesRoot=dirname(modulesRoot);
const roots=[packageRoot,runtimeModules,...(basename(modulesRoot).toLowerCase()==='node_modules'?[modulesRoot]:[])];
const within=(path,root)=>{const rel=relative(root,path);return rel===''||rel!=='..'&&!rel.startsWith('..\\')&&!rel.startsWith('../')&&!isAbsolute(rel);};
const allowed=path=>roots.some(root=>within(path,root));
const entry=resolve(installedPackage,pkg.main??'lib/index.js');
if(!within(entry,installedPackage)||!existsSync(entry)||!lstatSync(entry).isFile()||!allowed(realpathSync(entry)))throw Error('NATIVE_PACKAGE_ENTRY_DENIED');
const req = createRequire(join(repo, 'services/agent-runtime/package.json'));
const hash = value => createHash('sha256').update(value).digest('hex');
mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
const staging = mkdtempSync(join(outputRoot, '.build-'));
try {
  mkdirSync(join(staging, 'lib'));
  const metadata = readFileSync(req.resolve('@deepseek-ai/dsh-llm/package.json'));
  writeFileSync(join(staging, 'package.json'), metadata);
  const source = `import {Context} from ${JSON.stringify(req.resolve('@deepseek-ai/cordis'))};
import SystemPrompt from ${JSON.stringify(req.resolve('@deepseek-ai/dsh-system-prompt'))};
import Tools from ${JSON.stringify(req.resolve('@deepseek-ai/dsh-tools'))};
import * as plugin from ${JSON.stringify(entry)};
const ctx=new Context(),fibers=[];
async function mount(plugin,config){const f=ctx.plugin(plugin,config);fibers.push(f);await f.await();}
try {
 await mount(SystemPrompt);await mount(Tools,{mode:'native'});await mount(plugin,${JSON.stringify(definition.config)});
 const chunks=[];let bytes=0;for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>1048576)throw Error('NATIVE_INPUT_LIMIT');chunks.push(chunk);}
 const request=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 const result=request.name==='__schemas'?ctx.tools.schemas():await ctx.tools.execute({name:request.name,arguments:request.arguments,callId:request.callId,signal:AbortSignal.timeout(45000)});
 process.stdout.write(JSON.stringify(result));
}finally{for(const f of fibers.reverse())await f.dispose();}`;
  await build({ stdin: { contents: source, resolveDir: repo, sourcefile: 'native-plugin-entry.mjs' }, nodePaths:[join(repo,'services/agent-runtime/node_modules')], bundle: true, platform: 'node', format: 'esm', target: 'node24', outfile: join(staging, 'lib/runner.mjs'), minify: false, external: ['@napi-rs/canvas'],
    plugins:[{name:'native-source-boundary',setup(build){
      build.onResolve({filter:/^(?:\.{1,2}[\\/]|[A-Za-z]:[\\/]|[\\/])/},args=>{const candidate=resolve(args.resolveDir,args.path);if(!allowed(candidate))throw Error('NATIVE_PACKAGE_SOURCE_DENIED');return null;});
      build.onResolve({filter:/^[^./\\][^\\]*$/},async args=>{
        if(args.pluginData?.nativeBoundaryResolve||args.path.startsWith('node:'))return null;
        const options={resolveDir:args.resolveDir,kind:args.kind,pluginData:{nativeBoundaryResolve:true}};
        const original=await build.resolve(args.path,options);
        if(original.external||!original.path||original.errors.length)return null;
        if(allowed(realpathSync(original.path)))return {path:original.path,namespace:original.namespace};
        const fallback=await build.resolve(args.path,{...options,resolveDir:join(repo,'services/agent-runtime')});
        if(fallback.errors.length||!fallback.path||fallback.external||!within(realpathSync(fallback.path),runtimeModules))throw Error('NATIVE_PACKAGE_SOURCE_DENIED');
        return {path:fallback.path,namespace:fallback.namespace};
      });
      build.onLoad({filter:/.*/,namespace:'file'},args=>{if(!allowed(realpathSync(args.path)))throw Error('NATIVE_PACKAGE_SOURCE_DENIED');return null;});
    }}],
    banner: { js: "import {createRequire as __nativeRequire} from 'node:module'; import {fileURLToPath as __fileURLToPath} from 'node:url'; import {dirname as __nativeDirname} from 'node:path'; const require=__nativeRequire(import.meta.url), __filename=__fileURLToPath(import.meta.url), __dirname=__nativeDirname(__filename);" } });
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'LANG'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  const probe = await new Promise((resolve,reject)=>{const child=execFile(process.execPath,['--permission',`--allow-fs-read=${staging}`,join(staging,'lib/runner.mjs')],{
    cwd:staging,env,encoding:'utf8',timeout:30000,killSignal:'SIGKILL',maxBuffer:1024*1024,windowsHide:true},(error,stdout)=>error?reject(Error('NATIVE_SCHEMA_PROBE_FAILED')):resolve(stdout));
    child.stdin.end(JSON.stringify({name:'__schemas'}));});
  const schemas = JSON.parse(probe);
  if (schemas.length !== Object.keys(definition.files).length || schemas.some(tool => !definition.files[tool.name])) throw Error('NATIVE_TOOL_INVENTORY_CHANGED');
  const code = readFileSync(join(staging, 'lib/runner.mjs')), compressed = gzipSync(code);
  const manifest = { format: 'dsh-native-tools-v1', namespace: definition.namespace, package: pkg.name, version: pkg.version,
    source: definition.source, dshVersion: '0.1.5-rc.1', config: definition.config, lockSha256: hash(readFileSync(lockFile)),
    bundle: { sha256: hash(compressed), codeSha256: hash(code), metadataSha256: hash(metadata), bytes: compressed.length },
    tools: schemas.map(tool => ({ name: `plugin__${definition.namespace}__${tool.name}`, originalName: tool.name, description: tool.description, parameters: tool.parameters, files: definition.files[tool.name] })) };
  const id = nativeManifestId(manifest), destination = join(outputRoot, id);
  const result={ id, directory: destination, package: pkg.name, version: pkg.version, tools: schemas.length, compressedBytes: compressed.length, modelCalls: 0 };
  if(existsSync(destination)) {
    const existing=JSON.parse(readFileSync(join(destination,'manifest.json'),'utf8'));
    if(nativeManifestId(existing)!==id || !readFileSync(join(destination,'bundle.gz')).equals(compressed) || !readFileSync(join(destination,'package.json')).equals(metadata))throw Error('NATIVE_VERSION_CONFLICT');
  } else {
    writeFileSync(join(staging,'bundle.gz'),compressed,{flag:'wx'});
    writeFileSync(join(staging,'manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx'});
    rmSync(join(staging,'lib'),{recursive:true});
    renameSync(staging,destination);
  }
  return result;
} finally { rmSync(staging, { recursive: true, force: true }); }
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const args=process.argv.slice(2);
 if(args.length!==4)throw Error('Usage: node build-native-tool-bundle.mjs definition.json installed-package-directory lockfile output-root');
 console.log(JSON.stringify(await buildNativeToolBundle(...args)));
}
