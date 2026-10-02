import { createApp } from './app.ts';
import { migrate, pool } from './db.ts';
await migrate();
const app = createApp();
const port=Number(process.env.API_PORT??4311),host=process.env.API_HOST??'127.0.0.1';
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('API_PORT must be an integer from 1 to 65535');
const server = app.listen(port, host, () => console.log(`为伍 API http://${host}:${port}`));
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => server.close(() => { void app.locals.shutdown().then(() => pool.end()).then(() => process.exit(0)); }));
