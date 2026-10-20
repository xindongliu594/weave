import type pg from 'pg';
export type IdentityQueryExecutor = Pick<pg.Pool, 'query'>;

/** Additive only. Sessions and login transactions contain transient secrets: exclude both from backups. */
export async function migrateIdentity(db: IdentityQueryExecutor): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS human_users (
      id text PRIMARY KEY, issuer text NOT NULL CHECK (length(issuer)>0), subject text NOT NULL CHECK (length(subject)>0),
      display_name text, email text, status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','disabled')),
      org_role text NOT NULL DEFAULT 'member' CHECK (org_role IN ('member','admin','auditor')),
      session_epoch bigint NOT NULL DEFAULT 0 CHECK (session_epoch BETWEEN 0 AND 9007199254740991),
      version integer NOT NULL DEFAULT 1 CHECK (version>0),
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(issuer,subject)
    );
    CREATE TABLE IF NOT EXISTS department_memberships (
      department_id text NOT NULL REFERENCES departments(id), user_id text NOT NULL REFERENCES human_users(id),
      role text NOT NULL CHECK (role IN ('viewer','operator','manager')), can_approve boolean NOT NULL DEFAULT false,
      version integer NOT NULL DEFAULT 1 CHECK (version>0), granted_by text REFERENCES human_users(id),
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(department_id,user_id)
    );
    CREATE INDEX IF NOT EXISTS department_memberships_user ON department_memberships(user_id);
    -- connect-pg-simple's official sid/sess/expire layout (tableName: human_sessions).
    CREATE TABLE IF NOT EXISTS human_sessions (sid varchar NOT NULL PRIMARY KEY, sess json NOT NULL, expire timestamp(6) NOT NULL);
    CREATE INDEX IF NOT EXISTS human_sessions_expire ON human_sessions(expire);
    CREATE TABLE IF NOT EXISTS oidc_login_transactions (
      id text PRIMARY KEY, session_binding_hash text NOT NULL, state_hash text NOT NULL UNIQUE,
      nonce text NOT NULL, verifier text NOT NULL, issuer text NOT NULL, client_id text NOT NULL,
      redirect_uri text NOT NULL, return_to text NOT NULL, expires_at timestamptz NOT NULL,
      consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS oidc_login_transactions_expire ON oidc_login_transactions(expires_at);
    CREATE TABLE IF NOT EXISTS identity_bootstrap (
      id integer PRIMARY KEY CHECK (id=1), expected_fingerprint text, activated_at timestamptz,
      consumed_by text REFERENCES human_users(id), consumed_at timestamptz,
      version integer NOT NULL DEFAULT 1 CHECK (version>0),
      CHECK ((consumed_at IS NULL)=(consumed_by IS NULL)),
      CHECK (consumed_at IS NULL OR activated_at IS NOT NULL),
      CHECK ((activated_at IS NULL)=(expected_fingerprint IS NULL))
    );
    ALTER TABLE identity_bootstrap ADD COLUMN IF NOT EXISTS closed_at timestamptz;
    ALTER TABLE identity_bootstrap ADD COLUMN IF NOT EXISTS closed_reason text
      CHECK ((closed_at IS NULL)=(closed_reason IS NULL)
        AND (closed_reason IS NULL OR closed_reason IN ('existing-administration','disabled-bootstrap-identity'))
        AND (closed_at IS NULL OR (activated_at IS NOT NULL AND consumed_at IS NULL)));
    INSERT INTO identity_bootstrap(id) VALUES(1) ON CONFLICT(id) DO NOTHING;
    CREATE TABLE IF NOT EXISTS human_audit_events (
      id text PRIMARY KEY, occurred_at timestamptz NOT NULL DEFAULT now(),
      actor_kind text NOT NULL CHECK (actor_kind IN ('human','local-owner','device','system')),
      actor_user_id text REFERENCES human_users(id), actor_snapshot jsonb NOT NULL,
      action text NOT NULL, resource_type text NOT NULL, resource_id text NOT NULL,
      department_id text REFERENCES departments(id), request_id text,
      outcome text NOT NULL CHECK (outcome IN ('success','denied','failure')), reason text, changes jsonb NOT NULL DEFAULT '{}',
      CHECK ((actor_kind='human')=(actor_user_id IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS human_audit_events_occurred ON human_audit_events(occurred_at);
    CREATE TABLE IF NOT EXISTS audit_outbox (
      id text PRIMARY KEY, audit_event_id text NOT NULL UNIQUE REFERENCES human_audit_events(id),
      run_id text, event_type text NOT NULL, payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz
    );
    CREATE OR REPLACE FUNCTION reject_human_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'human audit events are append only'; END
    $$;
    DROP TRIGGER IF EXISTS human_audit_append_only ON human_audit_events;
    CREATE TRIGGER human_audit_append_only BEFORE UPDATE OR DELETE ON human_audit_events
      FOR EACH ROW EXECUTE FUNCTION reject_human_audit_mutation();
  `);
}
