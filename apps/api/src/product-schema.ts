import type pg from 'pg';
import {bindPolicy} from '../../../packages/contracts/index.ts';
export async function migrateProduct(pool: pg.Pool) {
  // Tests use isolated search paths; install the shared extension once under an advisory lock.
  const extension=await pool.connect();
  try{await extension.query('BEGIN');await extension.query('SELECT pg_advisory_xact_lock(918276)');await extension.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');await extension.query('COMMIT');}
  catch(error){await extension.query('ROLLBACK');throw error;}finally{extension.release();}
  await pool.query(`
    CREATE TABLE IF NOT EXISTS department_versions (department_id text NOT NULL, version integer NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(department_id,version));
    INSERT INTO department_versions(department_id,version,data) SELECT id,version,data FROM departments ON CONFLICT DO NOTHING;
    CREATE OR REPLACE FUNCTION record_department_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      INSERT INTO department_versions(department_id,version,data) VALUES(NEW.id,NEW.version,NEW.data) ON CONFLICT DO NOTHING; RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS department_version_history ON departments;
    CREATE TRIGGER department_version_history AFTER INSERT OR UPDATE ON departments FOR EACH ROW EXECUTE FUNCTION record_department_version();
    CREATE TABLE IF NOT EXISTS templates (id text PRIMARY KEY, kind text NOT NULL, name text NOT NULL, data jsonb NOT NULL, version integer NOT NULL DEFAULT 1, deleted_at timestamptz);
    ALTER TABLE models ADD COLUMN IF NOT EXISTS capabilities jsonb NOT NULL DEFAULT '{}';
    ALTER TABLE plan_versions ADD COLUMN IF NOT EXISTS policy jsonb;
    CREATE TABLE IF NOT EXISTS model_capability_tests(id text PRIMARY KEY,model_id text NOT NULL REFERENCES models(id),model_version int NOT NULL,probe_version text NOT NULL,status text NOT NULL,code text,request_ids jsonb NOT NULL DEFAULT '[]',created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz);
    CREATE TABLE IF NOT EXISTS knowledge_spaces (id text PRIMARY KEY, name text NOT NULL, scope text NOT NULL, department_id text, agent_ids jsonb NOT NULL DEFAULT '[]', version integer NOT NULL DEFAULT 1, deleted_at timestamptz);
    CREATE TABLE IF NOT EXISTS knowledge_documents (id text PRIMARY KEY, space_id text NOT NULL REFERENCES knowledge_spaces(id), title text NOT NULL, version integer NOT NULL DEFAULT 1, deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS knowledge_revisions (document_id text NOT NULL REFERENCES knowledge_documents(id), version integer NOT NULL, content text NOT NULL, sha256 text NOT NULL, source jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(document_id,version));
    ALTER TABLE knowledge_revisions ADD COLUMN IF NOT EXISTS source_bounds jsonb;
    CREATE TABLE IF NOT EXISTS knowledge_chunks (id text PRIMARY KEY, document_id text NOT NULL, version integer NOT NULL, line_start integer NOT NULL, line_end integer NOT NULL, content text NOT NULL, tokens jsonb NOT NULL);
    CREATE INDEX IF NOT EXISTS knowledge_chunks_document ON knowledge_chunks(document_id,version);
    CREATE INDEX IF NOT EXISTS knowledge_chunks_tokens ON knowledge_chunks USING gin(tokens);
    CREATE TABLE IF NOT EXISTS knowledge_embeddings(chunk_id text NOT NULL,model_version text NOT NULL,title text NOT NULL,embedding public.vector(384) NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(chunk_id,model_version,title));
    ALTER TABLE knowledge_spaces ADD COLUMN IF NOT EXISTS vault_folder text;
    ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS vault_path text;
    ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS vault_hash text;
    CREATE TABLE IF NOT EXISTS native_capabilities(namespace text PRIMARY KEY, manifest_id text NOT NULL, enabled boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS product_settings (id integer PRIMARY KEY CHECK(id=1), version integer NOT NULL DEFAULT 1, data jsonb NOT NULL);
    INSERT INTO product_settings(id,data) VALUES(1,'{"autoBudgetLimit":0.25,"dailyBudgetLimit":20,"maxActiveRuns":2,"retentionDays":0}') ON CONFLICT DO NOTHING;
    ALTER TABLE project_runs ADD COLUMN IF NOT EXISTS lease_owner text;
    ALTER TABLE project_runs ADD COLUMN IF NOT EXISTS lease_until timestamptz;
    ALTER TABLE project_runs ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 1;
    ALTER TABLE project_runs ADD COLUMN IF NOT EXISTS parent_run_id text;
    ALTER TABLE project_runs ADD COLUMN IF NOT EXISTS cancel_requested boolean NOT NULL DEFAULT false;
    ALTER TABLE project_runs ADD COLUMN IF NOT EXISTS department_ids text[] NOT NULL DEFAULT '{}';
    ALTER TABLE project_runs ADD COLUMN IF NOT EXISTS requested_by_user_id text REFERENCES human_users(id);
    ALTER TABLE project_runs ADD COLUMN IF NOT EXISTS authorized_by_user_id text REFERENCES human_users(id);
    ALTER TABLE project_runs ADD COLUMN IF NOT EXISTS authorized_epoch bigint CHECK(authorized_epoch BETWEEN 0 AND 9007199254740991);
    ALTER TABLE project_runs ADD COLUMN IF NOT EXISTS authority_kind text CHECK(authority_kind IN ('human','local-owner','automatic-policy'));
    ALTER TABLE project_runs ADD COLUMN IF NOT EXISTS authority_department_ids text[];
    ALTER TABLE project_runs ADD COLUMN IF NOT EXISTS source_bounds jsonb;
    ALTER TABLE project_runs ADD COLUMN IF NOT EXISTS canonical_workspace jsonb;
    UPDATE project_runs SET department_ids=ARRAY[snapshot->>'departmentId'] WHERE department_ids='{}' AND snapshot ? 'departmentId';
    CREATE INDEX IF NOT EXISTS project_runs_departments ON project_runs USING gin(department_ids);
    ALTER TABLE usage ADD COLUMN IF NOT EXISTS run_id text;
    ALTER TABLE usage ADD COLUMN IF NOT EXISTS department_id text;
    CREATE TABLE IF NOT EXISTS organization_previews(id text PRIMARY KEY,data jsonb NOT NULL,project_id text,department_id text,created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS organization_conversations(id text PRIMARY KEY,turn_id text NOT NULL,preview_id text,updated_at timestamptz NOT NULL DEFAULT now());
    ALTER TABLE organization_conversations ADD COLUMN IF NOT EXISTS failed_draft jsonb;
    ALTER TABLE usage ADD COLUMN IF NOT EXISTS planning_preview_id text;
    ALTER TABLE usage ADD COLUMN IF NOT EXISTS agent_id text;
    ALTER TABLE usage ADD COLUMN IF NOT EXISTS employee_id text;
    ALTER TABLE usage ADD COLUMN IF NOT EXISTS session_id text;
    ALTER TABLE usage ADD COLUMN IF NOT EXISTS task_id text;
    ALTER TABLE usage ADD COLUMN IF NOT EXISTS attempt_id text;
    ALTER TABLE usage ADD COLUMN IF NOT EXISTS request_id text;
    ALTER TABLE usage ADD COLUMN IF NOT EXISTS duration_ms integer;
    CREATE TABLE IF NOT EXISTS model_reservations (
      id text PRIMARY KEY, model_id text NOT NULL REFERENCES models(id), project_id text REFERENCES projects(id), department_id text, run_id text,
      purpose text NOT NULL, amount numeric NOT NULL CHECK(amount>=0), input_rate numeric NOT NULL, output_rate numeric NOT NULL,
      status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','uncertain','settled','released')), context jsonb NOT NULL DEFAULT '{}',
      history jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes'
    );
    CREATE INDEX IF NOT EXISTS model_reservations_open ON model_reservations(status,project_id,run_id);
    ALTER TABLE project_runs DROP CONSTRAINT IF EXISTS project_runs_project_id_project_version_key;
    CREATE UNIQUE INDEX IF NOT EXISTS project_runs_attempt ON project_runs(project_id,project_version,attempt);
    CREATE TABLE IF NOT EXISTS tool_approvals (id text PRIMARY KEY, run_id text NOT NULL REFERENCES project_runs(id), agent_id text NOT NULL, tool text NOT NULL, arguments jsonb NOT NULL, status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz);
    CREATE TABLE IF NOT EXISTS request_keys (key text PRIMARY KEY, fingerprint text NOT NULL, status integer, response jsonb, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS local_devices (
      id text PRIMARY KEY, token_hash text NOT NULL, name text NOT NULL, platform text NOT NULL,
      grant_id text NOT NULL, label text NOT NULL, allow_commands boolean NOT NULL DEFAULT false,
      enabled boolean NOT NULL DEFAULT true, last_seen timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS local_operations (
      id text PRIMARY KEY, device_id text NOT NULL REFERENCES local_devices(id), run_id text NOT NULL REFERENCES project_runs(id),
      grant_id text NOT NULL, lease_owner text NOT NULL, payload jsonb NOT NULL, approval_id text UNIQUE REFERENCES tool_approvals(id),
      status text NOT NULL DEFAULT 'queued', claim_token text, started boolean NOT NULL DEFAULT false,
      result jsonb, late_result jsonb, deadline timestamptz NOT NULL DEFAULT now()+interval '90 seconds',
      created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS local_operations_device ON local_operations(device_id,status,created_at);
    ALTER TABLE local_operations ADD COLUMN IF NOT EXISTS merge_state text CHECK(merge_state IN ('pending','committed','rejected','unknown'));
    ALTER TABLE local_operations ADD COLUMN IF NOT EXISTS merge_record jsonb;
    ALTER TABLE local_operations ADD COLUMN IF NOT EXISTS merge_rejection jsonb;
    ALTER TABLE local_devices ADD COLUMN IF NOT EXISTS backend jsonb NOT NULL DEFAULT '{"kind":"native"}'::jsonb;
    CREATE TABLE IF NOT EXISTS task_attempt_workspaces (
      run_id text NOT NULL REFERENCES project_runs(id),task_id text NOT NULL,attempt_id text NOT NULL,generation integer NOT NULL CHECK(generation>0),
      principal text NOT NULL,session_id text NOT NULL,runtime_task_id text NOT NULL,contract_hash text NOT NULL,
      permission_hash text NOT NULL,capability_hash text NOT NULL,contract jsonb NOT NULL,
      input_origins jsonb NOT NULL DEFAULT '[]',committed_outputs jsonb NOT NULL DEFAULT '[]',sandbox_identity jsonb,
      scope jsonb,work_revision text,phase text NOT NULL DEFAULT 'active' CHECK(phase IN ('active','retired','unknown')),
      PRIMARY KEY(run_id,task_id,attempt_id,generation)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS task_attempt_active_generation ON task_attempt_workspaces(run_id,task_id) WHERE phase='active';
    ALTER TABLE task_attempt_workspaces ADD COLUMN IF NOT EXISTS accepted_stop jsonb;
  `);
  // Preserve the existing scope on upgrade; do not invent policies for older historical versions.
  const client=await pool.connect();
  try{await client.query('BEGIN');
    const legacy=(await client.query("SELECT id,department_id,policy,plan FROM projects WHERE NOT (policy ?& ARRAY['allowedModelIds','allowedTools','allowedKnowledgeSpaceIds','allowedDepartmentIds']) FOR UPDATE")).rows;
    for(const row of legacy)await client.query('UPDATE projects SET policy=$1 WHERE id=$2',[bindPolicy(row.policy,row.plan.agents,row.department_id),row.id]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
