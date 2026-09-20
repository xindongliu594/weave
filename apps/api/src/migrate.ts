import { migrate, pool } from './db.ts';
await migrate();
await pool.end();
console.log('Database migrations complete');
