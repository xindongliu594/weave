import { createApp } from './app.ts';
import { migrate, pool } from './db.ts';
await migrate();
const app = createApp();
const server = app.listen(4311, '127.0.0.1', () => console.log('Agent Department API http://127.0.0.1:4311'));
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => server.close(() => { void app.locals.shutdown().then(() => pool.end()).then(() => process.exit(0)); }));
