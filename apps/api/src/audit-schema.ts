import type { IdentityQueryExecutor } from './identity-schema.ts';

/** Additive audit extension: schema-1 rows and their attribution are never backfilled. */
export async function migrateAudit(db: IdentityQueryExecutor): Promise<void> {
  await db.query(`
    ALTER TABLE human_audit_events ADD COLUMN IF NOT EXISTS schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version IN (1,2));
    ALTER TABLE human_audit_events ADD COLUMN IF NOT EXISTS source_event_id text UNIQUE;
    ALTER TABLE human_audit_events ADD COLUMN IF NOT EXISTS correlation_id text;
    ALTER TABLE human_audit_events ADD COLUMN IF NOT EXISTS project_id text;
    ALTER TABLE human_audit_events ADD COLUMN IF NOT EXISTS run_id text;
    ALTER TABLE human_audit_events ADD COLUMN IF NOT EXISTS task_id text;
    ALTER TABLE human_audit_events ADD COLUMN IF NOT EXISTS attempt_id text;
    ALTER TABLE human_audit_events ADD COLUMN IF NOT EXISTS operation_id text;
    ALTER TABLE human_audit_events ADD COLUMN IF NOT EXISTS parent_operation_id text;
    ALTER TABLE human_audit_events ADD COLUMN IF NOT EXISTS approval_id text;
    ALTER TABLE human_audit_events ADD COLUMN IF NOT EXISTS merge_id text;
    ALTER TABLE human_audit_events ADD COLUMN IF NOT EXISTS requested_by_audit_id text REFERENCES human_audit_events(id);
    ALTER TABLE human_audit_events ADD COLUMN IF NOT EXISTS executed_employee jsonb;
    ALTER TABLE human_audit_events ADD COLUMN IF NOT EXISTS authority_evidence jsonb;
    ALTER TABLE human_audit_events ADD COLUMN IF NOT EXISTS resource_versions jsonb;
    ALTER TABLE human_audit_events ADD COLUMN IF NOT EXISTS canonical_payload jsonb;
    ALTER TABLE human_audit_events DROP CONSTRAINT IF EXISTS human_audit_events_actor_kind_check;
    ALTER TABLE human_audit_events ADD CONSTRAINT human_audit_events_actor_kind_check CHECK (actor_kind IN ('human','local-owner','device','system','unidentified'));
    ALTER TABLE human_audit_events DROP CONSTRAINT IF EXISTS human_audit_events_outcome_check;
    ALTER TABLE human_audit_events ADD CONSTRAINT human_audit_events_outcome_check CHECK (outcome IN ('success','denied','failure','unknown'));
    ALTER TABLE audit_outbox ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0);
    ALTER TABLE audit_outbox ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();
    ALTER TABLE audit_outbox ADD COLUMN IF NOT EXISTS last_error_code text CHECK (last_error_code IN ('AUDIT_SOURCE_INVALID','AUDIT_RELATION_CONFLICT','AUDIT_PROJECTION_FAILED','AUDIT_STORAGE_UNAVAILABLE'));
    CREATE INDEX IF NOT EXISTS audit_outbox_pending ON audit_outbox(next_attempt_at,created_at,id) WHERE published_at IS NULL;
    CREATE INDEX IF NOT EXISTS human_audit_events_correlation ON human_audit_events(correlation_id,occurred_at,id);
    CREATE INDEX IF NOT EXISTS human_audit_events_run ON human_audit_events(run_id,occurred_at,id);
    CREATE TABLE IF NOT EXISTS audit_run_projection (
      audit_event_id text PRIMARY KEY REFERENCES human_audit_events(id), run_id text, correlation_id text NOT NULL,
      occurred_at timestamptz NOT NULL, summary jsonb NOT NULL CHECK (jsonb_typeof(summary)='object')
    );
    CREATE INDEX IF NOT EXISTS audit_run_projection_run ON audit_run_projection(run_id,occurred_at,audit_event_id);
  `);
}
