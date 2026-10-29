import type {ArchiveWriterManager} from '../../../services/agent-runtime/archive-writer-scope.mjs';
import type {BackupRestoreState} from './backup-restore-state.ts';
import {withVaultLock} from './obsidian.ts';

export type BackupSafety={unknown:boolean};
/** Known validation errors must not poison the shared writer fence. Unknown
 * persistence/lock outcomes deliberately escape and retain its safety latch. */
export async function underBackupRoot<T>(writers:ArchiveWriterManager,state:BackupRestoreState,work:(safety:BackupSafety)=>Promise<T>){
  const outcome=await writers.withRootExclusive(()=>withVaultLock(async()=>{
    const safety:BackupSafety={unknown:false};
    try{try{state.requireClear();}catch(error){safety.unknown=true;throw error;}return {ok:true as const,value:await work(safety)};}
    catch(error){if(safety.unknown)throw error;return {ok:false as const,error};}
  }),{timeoutMs:2000});
  if(!outcome.ok)throw outcome.error;return outcome.value;
}
