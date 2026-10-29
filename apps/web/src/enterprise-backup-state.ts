import {ENTERPRISE_BACKUP_FORMAT,ENTERPRISE_ENVELOPE_LIMIT_BYTES} from '../../../packages/contracts/backup.ts';
export async function readBackupFile(file:{size:number;text:()=>Promise<string>}):Promise<Record<string,unknown>>{
 if(!Number.isSafeInteger(file.size)||file.size<0||file.size>ENTERPRISE_ENVELOPE_LIMIT_BYTES)throw Error('备份文件超过 70 MiB 在线限制，请使用停机目录副本。');
 let value;try{value=JSON.parse(await file.text());}catch{throw Error('备份文件不是有效 JSON。');}
 if(!value||typeof value!=='object'||Array.isArray(value)||![ENTERPRISE_BACKUP_FORMAT,'agent-department-backup-v1'].includes(value.format))throw Error('不支持此备份格式，请选择完整企业 v2 或旧业务 v1 备份。');
 return value;
}
export function canRestoreBackup(input:{backup:any;preview:any;password:string;confirmation:string;busy:boolean}){
 if(input.busy||input.password.length<12||input.password.length>200||!input.backup)return false;
 if(input.backup.format===ENTERPRISE_BACKUP_FORMAT)return input.preview?.format===ENTERPRISE_BACKUP_FORMAT&&input.confirmation==='RESTORE ENTERPRISE';
 return input.backup.format==='agent-department-backup-v1'&&input.confirmation==='RESTORE';
}
export function backupFailureMessage(error:any):string{
 if(error?.code==='BACKUP_DECRYPT_FAILED')return '密码不正确或备份已损坏，请核对原文件和密码。';
 if(error?.code==='BACKUP_DESTINATION_NOT_FRESH')return '目标已有数据或历史，请在全新隔离实例恢复；当前数据未覆盖。';
 if(error?.code==='BACKUP_RESTORE_RECONCILIATION_REQUIRED')return '恢复结果尚未核对，执行保持阻止。请保留当前目录并重启检查，不要重复导入。';
 if(error?.code==='BACKUP_ACTIVATION_REAUTHENTICATION_REQUIRED')return '请在目标环境使用原身份服务的当前管理员账户重新登录，再核对并激活。';
 return typeof error?.message==='string'?error.message:'操作未确认，请先重新核对恢复状态。';
}
export function backupStateMessage(status:any):string{
 switch(status?.state){
  case 'normal':return '当前实例未处于企业恢复隔离。';
  case 'quarantined':return '数据已导入，执行保持隔离。请在目标环境重新登录管理员账户，核对后激活。';
  case 'active':return '恢复环境已激活。设备、插件、MCP 和定时计划仍需按需重新授权。';
  case 'reconciliation-required':return '恢复记录或文件尚未通过核对，执行继续阻止。请保留目录并重启服务检查，不要重复导入。';
  default:return '恢复状态尚未读取，确认状态前不能导入。';
 }
}
