import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {assertEnterpriseCatalog} from '../apps/api/src/enterprise-backup-catalog.ts';

const native=process.env.BACKUP_RESTORE_POSTGRES_URL;
if(native){const url=new URL(native);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username!=='weiwu_test'||!/^\/weiwu_backup_test_[a-f0-9]{32}$/.test(url.pathname)||!url.port||url.search||url.hash)throw Error('Explicit owned backup native database required');process.env.DATABASE_URL=native;}

test('fixed portable catalog covers formal migrations, normalizes owned schema names and rejects drift',async()=>{
  assert.ok(native||process.env.SIMULATED_INTEGRATION==='pglite');
  if(!native)assert.ok(process.env.DATABASE_URL?.startsWith('postgresql://postgres:postgres@127.0.0.1:'));
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
    await pool.query('ALTER TABLE activity ALTER COLUMN kind DROP NOT NULL');
    await assert.rejects(assertEnterpriseCatalog(pool),(error:any)=>error.code==='BACKUP_SCHEMA_UNSUPPORTED');
    await pool.query('ALTER TABLE activity ALTER COLUMN kind SET NOT NULL');
    await assertEnterpriseCatalog(pool);
    await pool.query("ALTER TABLE activity ADD CONSTRAINT unexpected_history_check CHECK(kind<>'')");
    await assert.rejects(assertEnterpriseCatalog(pool),(error:any)=>error.code==='BACKUP_SCHEMA_UNSUPPORTED');
    await pool.query('ALTER TABLE activity DROP CONSTRAINT unexpected_history_check');
    await pool.query('ALTER TABLE knowledge_documents DROP CONSTRAINT knowledge_documents_space_id_fkey');
    await assert.rejects(assertEnterpriseCatalog(pool),(error:any)=>error.code==='BACKUP_SCHEMA_UNSUPPORTED');
    await pool.query('ALTER TABLE knowledge_documents ADD FOREIGN KEY(space_id) REFERENCES knowledge_spaces(id)');
    await assertEnterpriseCatalog(pool);
    await pool.query('CREATE FUNCTION unexpected_history_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$');
    await pool.query('CREATE TRIGGER unexpected_history BEFORE INSERT ON activity FOR EACH ROW EXECUTE FUNCTION unexpected_history_trigger()');
    await assert.rejects(assertEnterpriseCatalog(pool),(error:any)=>error.code==='BACKUP_SCHEMA_UNSUPPORTED');
    await pool.query('DROP TRIGGER unexpected_history ON activity');
    await pool.query('DROP FUNCTION unexpected_history_trigger()');
    await assertEnterpriseCatalog(pool);
    await pool.query('CREATE TABLE unregistered_plugin_history(id text PRIMARY KEY)');
    await assert.rejects(assertEnterpriseCatalog(pool),(error:any)=>error.code==='BACKUP_SCHEMA_UNSUPPORTED');
  }finally{await pool.query('SET search_path TO public');await pool.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await pool.end();}
});
