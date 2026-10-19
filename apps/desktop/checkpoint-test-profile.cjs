// Pure argument builder reused by the trusted OpenShell runner. No shell or
// writable files, child processes, addons or worker permissions are granted.
function checkpointTestInvocation(command,root) {
 if(typeof command!=='string'||!/^node --test [A-Za-z0-9_./-]+(?: [A-Za-z0-9_./-]+)*$/.test(command))throw Error('CHECKPOINT_TEST_COMMAND_INVALID');
 const files=command.slice('node --test '.length).split(' ');
 if(files.some(file=>file.startsWith('-')||file.startsWith('/')||file.split('/').some(part=>!part||part==='.'||part==='..')||!file.endsWith('.mjs')))throw Error('CHECKPOINT_TEST_COMMAND_INVALID');
 return {args:['--permission','--allow-fs-read='+root,'--test-isolation=none','--test',...files],
  env:{PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',TZ:'UTC',HOME:root},profile:'node-permission-workspace-v1'};
}
module.exports={checkpointTestInvocation};
