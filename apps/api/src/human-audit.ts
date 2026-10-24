import type pg from 'pg';
import type {IdentityQueryExecutor} from './identity-schema.ts';
import {appendAudit,type AuditInput} from './audit-events.ts';

export {appendAudit as appendBusinessAudit} from './audit-events.ts';
/** Called only after the business transaction has ended; never changes its outcome. */
export async function recordDeniedAudit(pool:pg.Pool,event:AuditInput):Promise<string>{
  if(event.outcome==='success')throw Error('Non-success audit required');
  return appendAudit(pool,event);
}

/** Identity/audit and product tables must exist first. Historical NULL actors stay NULL. */
export async function migrateHumanApprovals(db:IdentityQueryExecutor):Promise<void>{
  await db.query(`ALTER TABLE tool_approvals
    ADD COLUMN IF NOT EXISTS decided_by_user_id text REFERENCES human_users(id),
    ADD COLUMN IF NOT EXISTS decided_epoch bigint CHECK(decided_epoch BETWEEN 0 AND 9007199254740991),
    ADD COLUMN IF NOT EXISTS decision_actor_kind text CHECK(decision_actor_kind IN ('human','local-owner')),
    ADD COLUMN IF NOT EXISTS decision_request_id text,
    ADD COLUMN IF NOT EXISTS decision_reason text CHECK(decision_reason IN ('approved-by-current-authority','denied-by-current-authority')),
    ADD COLUMN IF NOT EXISTS decision_audit_id text REFERENCES human_audit_events(id);
    DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='tool_approvals'::regclass AND conname='tool_approvals_human_decision') THEN
        ALTER TABLE tool_approvals ADD CONSTRAINT tool_approvals_human_decision CHECK(
          (decision_actor_kind IS NULL AND decided_by_user_id IS NULL AND decided_epoch IS NULL AND decision_request_id IS NULL AND decision_reason IS NULL AND decision_audit_id IS NULL)
          OR (decision_actor_kind IS NOT NULL AND status IN ('approved','denied') AND decided_at IS NOT NULL
            AND decision_request_id IS NOT NULL AND length(decision_request_id) BETWEEN 1 AND 128
            AND decision_reason IS NOT NULL AND decision_audit_id IS NOT NULL
            AND ((decision_actor_kind='human' AND decided_by_user_id IS NOT NULL AND decided_epoch IS NOT NULL)
              OR (decision_actor_kind='local-owner' AND decided_by_user_id IS NULL AND decided_epoch IS NULL))));
      END IF;
    END $$;`);
}
