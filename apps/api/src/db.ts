import pg from 'pg';
import {migrateStorage} from './storage-governance.ts';
import { migrateProduct } from './product-schema.ts';
import { migrateManagerChat } from './manager-chat.ts';
import { migrateBrowserMcp } from './work-tools-browser.ts';
import { migrateWorkFiles } from './work-files.ts';
import { migrateAutomationLearning } from './automation-learning.ts';
import {migrateIdentity} from './identity-schema.ts';
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://agent_department:local-development-only@127.0.0.1:55432/agent_department' });
export async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gateways (
      id text PRIMARY KEY, data jsonb NOT NULL, credential text, version integer NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS departments (
      id text PRIMARY KEY, data jsonb NOT NULL, version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS models (
      id text PRIMARY KEY, data jsonb NOT NULL, credential text, version integer NOT NULL DEFAULT 1,
      status text NOT NULL DEFAULT 'untested', checked_at timestamptz, deleted_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS projects (
      id text PRIMARY KEY, department_id text NOT NULL REFERENCES departments(id), department_version integer NOT NULL,
      department_name text NOT NULL, requirement text NOT NULL, policy jsonb NOT NULL,
      plan jsonb NOT NULL, version integer NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'DRAFT',
      source text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS plan_versions (
      project_id text NOT NULL REFERENCES projects(id), version integer NOT NULL, plan jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(project_id, version)
    );
    CREATE TABLE IF NOT EXISTS activity (
      id text PRIMARY KEY, kind text NOT NULL, title text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS usage (
      id text PRIMARY KEY, model_id text NOT NULL REFERENCES models(id), project_id text REFERENCES projects(id),
      input_tokens integer NOT NULL, output_tokens integer NOT NULL, cost numeric NOT NULL,
      purpose text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS project_runs (
      id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id), project_version integer NOT NULL,
      status text NOT NULL, snapshot jsonb NOT NULL, error text,
      created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz,
      UNIQUE(project_id, project_version)
    );
    CREATE INDEX IF NOT EXISTS projects_department ON projects(department_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS usage_project ON usage(project_id);
    CREATE INDEX IF NOT EXISTS project_runs_project ON project_runs(project_id, created_at DESC);
  `);
  await migrateProduct(pool);
  await pool.query(`
    ALTER TABLE request_keys ADD COLUMN IF NOT EXISTS principal_key text;
    UPDATE request_keys SET principal_key='legacy-local' WHERE principal_key IS NULL;
    ALTER TABLE request_keys ALTER COLUMN principal_key SET NOT NULL;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='request_keys'::regclass AND conname='request_keys_pkey'
        AND pg_get_constraintdef(oid)='PRIMARY KEY (key)') THEN
        ALTER TABLE request_keys DROP CONSTRAINT request_keys_pkey;
        ALTER TABLE request_keys ADD PRIMARY KEY (principal_key,key);
      END IF;
    END $$;
  `);
  await migrateIdentity(pool);
  await migrateStorage(pool);
  await migrateManagerChat(pool);
  await migrateBrowserMcp(pool);
  await migrateWorkFiles(pool);
  await migrateAutomationLearning(pool);
}
