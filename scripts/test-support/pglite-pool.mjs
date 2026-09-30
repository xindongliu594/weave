import pg from 'pg';

// PGlite owns one PostgreSQL backend. One product connection avoids pretending
// to test independent backend locks or concurrent database workers.
if (process.env.SIMULATED_INTEGRATION !== 'pglite') throw Error('This preload is only for the PGlite test runner');
const NativePool = pg.Pool;
pg.Pool = class extends NativePool {
  constructor(options) { super({ ...options, max: 1 }); }
};
