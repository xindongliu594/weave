import type {RestoreDb} from '../../apps/api/src/enterprise-restore-admission.ts';
import {migrateEnterpriseRestoreAdmission} from '../../apps/api/src/enterprise-restore-admission.ts';
import {migrateBackupRestoreState} from '../../apps/api/src/backup-restore-state.ts';

/** Minimal component fixtures still need the real restore control schema. */
export async function migrateRestoreControlFixture(db:RestoreDb){
 await migrateBackupRestoreState(db);await migrateEnterpriseRestoreAdmission(db);
}
