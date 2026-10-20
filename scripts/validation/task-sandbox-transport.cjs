// Explicit mock protocol check. A physical JJ/OpenShell acceptance run is separate.
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {OPENSHELL_CONSTANTS,MAX_TASK_EXEC_STDIN_BYTES,taskEnvelope}=require('../../apps/desktop/openshell-executor.cjs');
const sha=value=>createHash('sha256').update(value).digest('hex');

function option(name){const at=process.argv.indexOf(name);if(at<0||!process.argv[at+1])throw Error('Required option '+name);return path.resolve(process.argv[at+1]);}
const configPath=option('--config'),tempDir=option('--temp-dir');
for(const value of [configPath,tempDir])if(!path.isAbsolute(value)||fs.lstatSync(value).isSymbolicLink()||fs.realpathSync(value)!==value)throw Error('Config and temp paths must be canonical');
if(!fs.statSync(tempDir).isDirectory())throw Error('Explicit temp directory is required');
const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
for(const key of ['version','gateway','cliSha256','image','policyHash','cpu','memory'])if(config[key]!==OPENSHELL_CONSTANTS[key])throw Error('Fixed OpenShell configuration mismatch: '+key);
const base={nonce:'0'.repeat(32),name:'prepare',profile:'task-attempt-openshell-v1',files:[],arguments:{padding:''}};
const overhead=Buffer.byteLength(JSON.stringify(base),'utf8');
const input=taskEnvelope({...base,arguments:{padding:'x'.repeat(MAX_TASK_EXEC_STDIN_BYTES-overhead)}});
let adapterCalls=0;
const adapter=payload=>{adapterCalls++;return Buffer.from(payload,'utf8');};
const observed=adapter(input);
if(observed.length!==MAX_TASK_EXEC_STDIN_BYTES||sha(observed)!==sha(input))throw Error('Envelope round trip failed');
try{adapter(taskEnvelope({...base,arguments:{padding:'x'.repeat(MAX_TASK_EXEC_STDIN_BYTES-overhead+1)}}));throw Error('Oversized envelope was dispatched');}
catch(error){if(error.code!=='LOCAL_FILE_LIMIT')throw error;}
if(adapterCalls!==1)throw Error('Oversized envelope reached adapter');
const report={mode:'mock-protocol',cliSha256:OPENSHELL_CONSTANTS.cliSha256,serializedBytes:observed.length,sentSha256:sha(input),observedSha256:sha(observed),oversizeBytes:MAX_TASK_EXEC_STDIN_BYTES+1,oversizeAdapterCalls:0};
fs.writeFileSync(path.join(tempDir,'task-sandbox-transport.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify(report));
