import type pg from 'pg';
export async function migrateProduct(pool: pg.Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS department_versions (department_id text NOT NULL, version integer NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(department_id,version));
    INSERT INTO department_versions(department_id,version,data) SELECT id,version,data FROM departments ON CONFLICT DO NOTHING;
    CREATE OR REPLACE FUNCTION record_department_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      INSERT INTO department_versions(department_id,version,data) VALUES(NEW.id,NEW.version,NEW.data) ON CONFLICT DO NOTHING; RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS department_version_history ON departments;
    CREATE TRIGGER department_version_history AFTER INSERT OR UPDATE ON departments FOR EACH ROW EXECUTE FUNCTION record_department_version();
    CREATE TABLE IF NOT EXISTS templates (id text PRIMARY KEY, kind text NOT NULL, name text NOT NULL, data jsonb NOT NULL, version integer NOT NULL DEFAULT 1, deleted_at timestamptz);
    CREATE TABLE IF NOT EXISTS knowledge_spaces (id text PRIMARY KEY, name text NOT NULL, scope text NOT NULL, department_id text, agent_ids jsonb NOT NULL DEFAULT '[]', version integer NOT NULL DEFAULT 1, deleted_at timestamptz);
    CREATE TABLE IF NOT EXISTS knowledge_documents (id text PRIMARY KEY, space_id text NOT NULL REFERENCES knowledge_spaces(id), title text NOT NULL, version integer NOT NULL DEFAULT 1, deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS knowledge_revisions (document_id text NOT NULL REFERENCES knowledge_documents(id), version integer NOT NULL, content text NOT NULL, sha256 text NOT NULL, source jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(document_id,version));
    CREATE TABLE IF NOT EXISTS knowledge_chunks (id text PRIMARY KEY, document_id text NOT NULL, version integer NOT NULL, line_start integer NOT NULL, line_end integer NOT NULL, content text NOT NULL, tokens jsonb NOT NULL);
    CREATE INDEX IF NOT EXISTS knowledge_chunks_document ON knowledge_chunks(document_id,version);
    ALTER TABLE knowledge_spaces ADD COLUMN IF NOT EXISTS vault_folder text;
    ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS vault_path text;
    ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS vault_hash text;
    CREATE TABLE IF NOT EXISTS product_settings (id integer PRIMARY KEY CHECK(id=1), version integer NOT NULL DEFAULT 1, data jsonb NOT NULL);
    INSERT INTO product_settings(id,data) VALUES(1,'{"autoBudgetLimit":0.25,"dailyBudgetLimit":20,"maxActiveRuns":2,"retentionDays":0}') ON CONFLICT DO NOTHING;
    ALTER TABLE project_runs ADD COLUMN IF NOT EXISTS lease_owner text;
    ALTER TABLE project_runs ADD COLUMN IF NOT EXISTS lease_until timestamptz;
    ALTER TABLE project_runs ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 1;
    ALTER TABLE project_runs ADD COLUMN IF NOT EXISTS parent_run_id text;
    ALTER TABLE project_runs ADD COLUMN IF NOT EXISTS cancel_requested boolean NOT NULL DEFAULT false;
    ALTER TABLE usage ADD COLUMN IF NOT EXISTS run_id text;
    CREATE TABLE IF NOT EXISTS organization_previews(id text PRIMARY KEY,data jsonb NOT NULL,project_id text,department_id text,created_at timestamptz NOT NULL DEFAULT now());
    ALTER TABLE usage ADD COLUMN IF NOT EXISTS planning_preview_id text;
    ALTER TABLE usage ADD COLUMN IF NOT EXISTS agent_id text;
    ALTER TABLE usage ADD COLUMN IF NOT EXISTS employee_id text;
    ALTER TABLE usage ADD COLUMN IF NOT EXISTS session_id text;
    ALTER TABLE usage ADD COLUMN IF NOT EXISTS task_id text;
    ALTER TABLE usage ADD COLUMN IF NOT EXISTS attempt_id text;
    ALTER TABLE usage ADD COLUMN IF NOT EXISTS request_id text;
    ALTER TABLE usage ADD COLUMN IF NOT EXISTS duration_ms integer;
    ALTER TABLE project_runs DROP CONSTRAINT IF EXISTS project_runs_project_id_project_version_key;
    CREATE UNIQUE INDEX IF NOT EXISTS project_runs_attempt ON project_runs(project_id,project_version,attempt);
    CREATE TABLE IF NOT EXISTS tool_approvals (id text PRIMARY KEY, run_id text NOT NULL REFERENCES project_runs(id), agent_id text NOT NULL, tool text NOT NULL, arguments jsonb NOT NULL, status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz);
    CREATE TABLE IF NOT EXISTS request_keys (key text PRIMARY KEY, fingerprint text NOT NULL, status integer, response jsonb, created_at timestamptz NOT NULL DEFAULT now());
  `);
}
