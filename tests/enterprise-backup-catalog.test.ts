import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {assertEnterpriseCatalog} from '../apps/api/src/enterprise-backup-catalog.ts';

test('fixed portable catalog covers formal migrations, normalizes owned schema names and rejects drift',async()=>{
  assert.equal(process.env.SIMULATED_INTEGRATION,'pglite');
  assert.ok(process.env.DATABASE_URL?.startsWith('postgresql://postgres:postgres@127.0.0.1:'));
  const {pool,migrate}=await import('../apps/api/src/db.ts');
  const schema='backup_catalog_'+randomUUID().replaceAll('-','');
  try{
    await migrate();await assertEnterpriseCatalog(pool);
    await pool.query('CREATE SCHEMA '+schema);await pool.query('SET search_path TO '+schema+',public');
    await migrate();await assertEnterpriseCatalog(pool);
    await pool.query('ALTER TABLE activity ADD COLUMN newer_format text');
    await assert.rejects(assertEnterpriseCatalog(pool),(error:any)=>error.status===422&&error.code==='BACKUP_SCHEMA_UNSUPPORTED');
    await pool.query('ALTER TABLE activity DROP COLUMN newer_format');
    await assertEnterpriseCatalog(pool);
    await pool.query('CREATE TABLE unregistered_plugin_history(id text PRIMARY KEY)');
    await assert.rejects(assertEnterpriseCatalog(pool),(error:any)=>error.code==='BACKUP_SCHEMA_UNSUPPORTED');
  }finally{await pool.query('SET search_path TO public');await pool.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await pool.end();}
});
