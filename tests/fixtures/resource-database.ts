import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import type pg from 'pg';
import {migrateIdentity} from '../../apps/api/src/identity-schema.ts';
import {migrateWorkFiles} from '../../apps/api/src/work-files.ts';
import {migrateAutomationLearning} from '../../apps/api/src/automation-learning.ts';

/** Native lock fixture: actual relevant DDL, without installing the unrelated vector extension. */
export async function migrateResourceFixture(db:pg.Pool){
 const base=readFileSync(new URL('../../apps/api/src/db.ts',import.meta.url),'utf8').match(/await pool\.query\(`([\s\S]*?)`\);/);assert.ok(base);await db.query(base[1]);await migrateIdentity(db);
 const product=readFileSync(new URL('../../apps/api/src/product-schema.ts',import.meta.url),'utf8');
 for(const table of ['knowledge_spaces','knowledge_documents','knowledge_revisions','knowledge_chunks','product_settings','model_reservations','tool_approvals','request_keys']){
  const ddl=product.match(new RegExp('CREATE TABLE IF NOT EXISTS '+table+' ?\\([\\s\\S]*?\\);'));assert.ok(ddl,table);await db.query(ddl[0]);
 }
 for(const match of product.matchAll(/ALTER TABLE (?:models|plan_versions|project_runs|usage|knowledge_revisions|knowledge_spaces|knowledge_documents) ADD COLUMN IF NOT EXISTS [^;]+;/g))await db.query(match[0]);
 await db.query("INSERT INTO product_settings(id,data) VALUES(1,'{}'); ALTER TABLE request_keys ADD COLUMN principal_key text NOT NULL DEFAULT 'legacy-local'; ALTER TABLE request_keys DROP CONSTRAINT request_keys_pkey; ALTER TABLE request_keys ADD PRIMARY KEY(principal_key,key)");
 await migrateWorkFiles(db);await migrateAutomationLearning(db);
}
