import {createHash} from 'node:crypto';
import type pg from 'pg';
import {enterpriseTableSpecs,type EnterpriseTableName} from './enterprise-backup-tables.ts';

type Query=Pick<pg.Pool,'query'>;
const excluded=['human_sessions','human_session_lifecycles','oidc_login_transactions','request_keys','backup_restore_anchor','backup_restore_receipts','enterprise_restore_admission'];
function unsupported():never{throw Object.assign(new Error('当前数据库结构与固定企业备份格式不匹配，未导出或替换数据。'),{status:422,code:'BACKUP_SCHEMA_UNSUPPORTED'});}
function normalized(value:any,schema:string):any{
  if(typeof value==='string')return value.replaceAll('"'+schema.replaceAll('"','""')+'".','').replaceAll(schema+'.','');
  if(Array.isArray(value))return value.map(item=>normalized(item,schema));
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,normalized(value[key],schema)]));
  return value;
}
export function enterpriseCatalogFingerprint(value:unknown,schema:string):string{return createHash('sha256').update(JSON.stringify(normalized(value,schema))).digest('hex');}

/** Catalog names are fixed by this module. Parameters never supply SQL statements. */
export async function inspectEnterpriseTable(db:Query,name:EnterpriseTableName){
  if(!Object.hasOwn(enterpriseTableSpecs,name))unsupported();
  const columns=(await db.query(`SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS required FROM pg_attribute a WHERE a.attrelid=format('%I.%I',current_schema(),$1::text)::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,[name])).rows;
  const constraints=(await db.query(`SELECT c.contype AS kind,pg_get_constraintdef(c.oid) AS definition,
    ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum,n) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.n) AS columns,
    CASE WHEN c.contype='f' THEN c.confrelid::regclass::text END AS target,
    CASE WHEN c.contype='f' THEN ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum,n) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum ORDER BY k.n) END AS "targetColumns"
    FROM pg_constraint c WHERE c.conrelid=format('%I.%I',current_schema(),$1::text)::regclass ORDER BY c.contype,pg_get_constraintdef(c.oid)`,[name])).rows;
  const triggers=(await db.query(`SELECT pg_get_triggerdef(t.oid) AS definition,pg_get_functiondef(t.tgfoid) AS function FROM pg_trigger t WHERE t.tgrelid=format('%I.%I',current_schema(),$1::text)::regclass AND NOT t.tgisinternal ORDER BY t.tgname`,[name])).rows;
  return {name,columns,constraints,triggers};
}
export async function assertEnterpriseCatalog(db:Query):Promise<void>{
  const schema=(await db.query('SELECT current_schema() AS name')).rows[0]?.name;
  if(typeof schema!=='string'||!schema)unsupported();
  const actual=(await db.query('SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename')).rows.map(row=>row.tablename);
  const expected=[...Object.keys(enterpriseTableSpecs),...excluded];
  if(actual.some(name=>!expected.includes(name))||Object.keys(enterpriseTableSpecs).some(name=>!actual.includes(name)))unsupported();
  for(const name of Object.keys(enterpriseTableSpecs) as EnterpriseTableName[]){
    const table=await inspectEnterpriseTable(db,name);
    if(enterpriseCatalogFingerprint(table,schema)!==enterpriseTableSpecs[name].databaseFingerprint)unsupported();
  }
}
