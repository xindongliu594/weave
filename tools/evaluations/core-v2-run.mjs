import {mkdirSync,writeFileSync,realpathSync} from 'node:fs';
import {resolve,relative,isAbsolute,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {toolRoot,readJson,readBounded,hash} from './files.mjs';
import {assertRuntime} from './run.mjs';
import {loadCoreDataset} from './core-v2-provider.mjs';
import {coreBindings,createCoreManifest,checkCoreGate} from './core-v2-gate.mjs';
export function buildCoreConfig(output){
 const file=name=>`file://${relative(output,resolve(toolRoot,name)).replaceAll('\\','/')}`;
 return {description:'Core v2: actual product functions on synthetic inputs plus pending real execution cases',sharing:false,prompts:['{{caseId}}'],providers:[{id:file('core-v2-provider.mjs'),config:{mode:'product-function'}}],tests:loadCoreDataset().cases.map(c=>({description:c.id,vars:{caseId:c.id},assert:[{type:'javascript',value:file('core-v2-assertion.mjs')}]})),evaluateOptions:{maxConcurrency:1},commandLineOptions:{cache:false,share:false,write:false}};
}
export async function runCore({outputDir,mode='product-function'}={}){
 if(mode==='execute')throw Error('LIVE_AUTHORIZATION_REQUIRED');if(mode!=='product-function')throw Error('unsupported-mode');assertRuntime();
 if(!outputDir)throw Error('explicit-output-required');
 const output=resolve(outputDir),root=resolve(toolRoot,'output'),rel=relative(root,output);
 if(!rel||rel==='..'||rel.startsWith('..\\')||rel.startsWith('../')||isAbsolute(rel))throw Error('unsafe-output-path');
 mkdirSync(root,{recursive:true});const parent=resolve(output,'..');mkdirSync(parent,{recursive:true});
 const physical=relative(realpathSync(root),realpathSync(parent));if(physical==='..'||physical.startsWith('..\\')||physical.startsWith('../')||isAbsolute(physical))throw Error('unsafe-output-path');
 mkdirSync(output);
 const installed=readJson(resolve(toolRoot,'node_modules/promptfoo/package.json')),lock=readJson(resolve(toolRoot,'package-lock.json'));
 if(installed.version!=='0.124.1'||readJson(resolve(toolRoot,'package.json')).dependencies.promptfoo!==installed.version||lock.packages['node_modules/promptfoo'].version!==installed.version||!lock.packages['node_modules/promptfoo'].integrity.startsWith('sha512-'))throw Error('evaluator-version-lock-mismatch');
 const bindings=coreBindings(),config=buildCoreConfig(output),configPath=join(output,'controlled-config.json');writeFileSync(configPath,JSON.stringify(config,null,2));
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>['path','systemroot','windir','temp','tmp','comspec','pathext'].includes(k.toLowerCase())));
 Object.assign(env,{HOME:output,USERPROFILE:output,CI:'true',DO_NOT_TRACK:'1',PROMPTFOO_CONFIG_DIR:join(output,'private-config'),PROMPTFOO_DISABLE_TELEMETRY:'true',PROMPTFOO_DISABLE_UPDATE:'true',PROMPTFOO_DISABLE_REMOTE_GENERATION:'true',PROMPTFOO_DISABLE_REDTEAM_REMOTE_GENERATION:'true'});
 const result=spawnSync(process.execPath,['--require',resolve(toolRoot,'offline-guard.cjs'),'--import',pathToFileURL(resolve(toolRoot,'../../node_modules/tsx/dist/loader.mjs')).href,resolve(toolRoot,'node_modules/promptfoo/dist/src/entrypoint.js'),'eval','--config',configPath,'--output',join(output,'promptfoo.json'),join(output,'promptfoo.junit.xml'),join(output,'promptfoo.html'),'--no-cache','--no-write','--no-progress-bar'],{cwd:output,env,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024,windowsHide:true});
 writeFileSync(join(output,'runner.log'),`${result.stdout??''}\n${result.stderr??''}`);
 if(result.error||![0,100].includes(result.status))throw Error(`promptfoo-runner-failed:${result.error?.code??result.status}`);
 for(const name of ['promptfoo.json','promptfoo.junit.xml','promptfoo.html'])if(!readBounded(join(output,name)).length)throw Error('missing-runner-report');
 const raw=readJson(join(output,'promptfoo.json')),stable=JSON.stringify(coreBindings())===JSON.stringify(bindings),m=createCoreManifest(raw,bindings,{sourceStable:stable});
 m.runnerExitCode=result.status;m.rawFileDigest=hash(readBounded(join(output,'promptfoo.json')));
 const gate=checkCoreGate(m,raw,coreBindings());
 writeFileSync(join(output,'manifest.json'),JSON.stringify(m,null,2));writeFileSync(join(output,'gate.json'),JSON.stringify(gate,null,2));
 return {outputDir:output,runnerExitCode:result.status,...gate};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{if(process.argv.length!==4||process.argv[2]!=='--output')throw Error('usage: node --import tsx core-v2-run.mjs --output tools/evaluations/output/UNIQUE');const result=await runCore({outputDir:process.argv[3]});console.log(JSON.stringify(result,null,2));process.exitCode=result.complete?0:1;}catch(e){console.error(e.message);process.exitCode=1;}}
