import { createApp } from './app.ts';
import { migrate, pool } from './db.ts';
await migrate();
const app = createApp();
const port=Number(process.env.API_PORT??4311),host=process.env.API_HOST??'127.0.0.1';
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('API_PORT must be an integer from 1 to 65535');
if((process.env.WEIWU_AUTH_MODE??'legacy-local')==='legacy-local'&&!['127.0.0.1','localhost','::1'].includes(host))throw new Error('Legacy local authentication requires loopback listen');
await app.locals.ready;
const server = app.listen(port, host, () => console.log(`为伍 API http://${host}:${port}`));
let shutdown:Promise<void>|undefined;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => {
  if(shutdown)return;
  shutdown=new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))
    .then(()=>app.locals.shutdown()).then(()=>pool.end()).then(()=>{process.exit(0);});
  shutdown.catch(()=>{console.error('Shutdown failed: runtime writers are not drained; database remains open.');process.exitCode=1;});
});
