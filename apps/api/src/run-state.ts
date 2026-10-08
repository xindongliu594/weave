import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import {pool} from './db.ts';
import {shareCostMaintenance} from './cost-control.ts';
type Terminal='completed'|'failed'|'cancelled'|'interrupted';
export function terminalStatus(value:unknown):value is Terminal{return ['completed','failed','cancelled','interrupted'].includes(String(value));}
async function lockedRun<T>(id:string,work:(client:pg.PoolClient,row:any)=>Promise<T>){
 const client=await pool.connect();
 try{await client.query('BEGIN');await shareCostMaintenance(client);
  const identity=(await client.query('SELECT project_id FROM project_runs WHERE id=$1',[id])).rows[0];
  if(!identity){await client.query('ROLLBACK');return null;}
  await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[identity.project_id]);
  const row=(await client.query('SELECT * FROM project_runs WHERE id=$1 FOR UPDATE',[id])).rows[0];
  const result=await work(client,row);await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
/** Recovery retains a live reservation and excludes retry until archive reconciliation is finished. */
export async function claimExpiredRun(id:string,exclude?:(row:any)=>boolean){
 return lockedRun(id,async(client,row)=>{
  if(!row||row.status!=='running'||(row.lease_until&&new Date(row.lease_until).getTime()>Date.now())||exclude?.(row))return null;
  const owner='recovery:'+randomUUID();
  const updated=(await client.query("UPDATE project_runs SET lease_owner=$1,lease_until=clock_timestamp()+interval '5 minutes' WHERE id=$2 RETURNING *",[owner,id])).rows[0];
  return updated;
 });
}
/** Run and project state become visible together, fenced by owner, lease, version and attempt. */
export async function finishRun(id:string,owner:string,status:Terminal,message:string|null=null,writeTrace?:(row:any)=>void){
 if(!terminalStatus(status))throw new Error('Invalid terminal run status');
 return lockedRun(id,async(client,row)=>{
  if(!row||row.status!=='running'||row.lease_owner!==owner||!row.lease_until||new Date(row.lease_until).getTime()<=Date.now())return false;
  writeTrace?.(row);
  await client.query('UPDATE project_runs SET status=$1,error=$2,finished_at=clock_timestamp(),lease_owner=NULL,lease_until=NULL WHERE id=$3',[status,message,id]);
  await client.query("UPDATE tool_approvals SET status='cancelled',decided_at=clock_timestamp() WHERE run_id=$1 AND status='pending'",[id]);
  await client.query(`UPDATE projects SET status=$1 WHERE id=$2 AND version=$3 AND NOT EXISTS(
    SELECT 1 FROM project_runs newer WHERE newer.project_id=$2 AND (newer.project_version>$3 OR (newer.project_version=$3 AND newer.attempt>$4)))`,[status.toUpperCase(),row.project_id,row.project_version,row.attempt]);
  return true;
 });
}
