import {identitySession} from './identity-session.ts';
import {ApiError,readApiResponse} from './api.ts';

export type MemberDepartment={id:string;name:string;description?:string};
export type MemberProject={id:string;requirement:string;departmentName?:string;status:string;version?:number};
export type MemberRun={id:string;projectId?:string;title?:string|null;status:string;createdAt?:string};
type Resource='departments'|'projects'|'runs';
type Rows={departments:MemberDepartment[];projects:MemberProject[];runs:MemberRun[]};
export const memberPageSize=100;

/** A narrow read surface; it never accepts arbitrary API paths or mutation verbs. */
export async function memberRead<K extends Resource>(resource:K,offset=0,signal?:AbortSignal):Promise<Rows[K]>{
 if(!['departments','projects','runs'].includes(resource)||!Number.isSafeInteger(offset)||offset<0||offset>1000000)throw Error('读取范围无效。');
 const identity=await identitySession.requireMemberRead();
 const current=()=>{if(identity.generation!==identitySession.getSnapshot().generation)throw new DOMException('身份已变更。','AbortError');};
 const path=resource+(resource==='departments'?'':`?limit=${memberPageSize}&offset=${offset}`);
 const response=await fetch((import.meta.env?.BASE_URL??'/')+'api/'+path,{method:'GET',credentials:'same-origin',cache:'no-store',signal:AbortSignal.any([identity.signal,...(signal?[signal]:[]),AbortSignal.timeout(30000)])});
 current();if(response.status===401){identitySession.invalidate();throw new ApiError('登录已失效，请重新登录。',401);}
 const rows=await readApiResponse<unknown>(response);current();
 if(!Array.isArray(rows)||rows.some(row=>!row||typeof row.id!=='string'||!row.id
  ||typeof row[resource==='departments'?'name':resource==='projects'?'requirement':'status']!=='string'
  ||resource==='projects'&&typeof row.status!=='string'
  ||['description','departmentName','title','createdAt'].some(key=>row[key]!=null&&typeof row[key]!=='string')
  ||row.version!==undefined&&(!Number.isSafeInteger(row.version)||row.version<1)))throw Error('资源列表格式无效，请刷新重试。');
 return rows as Rows[K];
}

export type MemberWorkspaceState=Rows&{status:'idle'|'loading'|'ready'|'error';error:string;projectOffset:number;runOffset:number};
const empty=():Rows=>({departments:[],projects:[],runs:[]});
export function createMemberWorkspace(){
 let state:MemberWorkspaceState={...empty(),status:'idle',error:'',projectOffset:0,runOffset:0},serial=0,controller:AbortController|undefined,unregister:(()=>void)|undefined;
 const listeners=new Set<()=>void>();
 function publish(next:MemberWorkspaceState){state=next;for(const listener of listeners)listener();}
 function reset(){serial++;controller?.abort();publish({...state,...empty(),status:'idle',error:'',projectOffset:0,runOffset:0});}
 async function refresh(offsets:Partial<Pick<MemberWorkspaceState,'projectOffset'|'runOffset'>>={}){
  controller?.abort();const ticket=++serial;controller=new AbortController();const signal=controller.signal;
  publish({...state,...offsets,...empty(),status:'loading',error:''});
  try{
   const [departments,projects,runs]=await Promise.all([memberRead('departments',0,signal),memberRead('projects',state.projectOffset,signal),memberRead('runs',state.runOffset,signal)]);
   if(ticket===serial&&!signal.aborted)publish({...state,departments,projects,runs,status:'ready'});
  }catch(error){if(ticket===serial){controller?.abort();publish({...state,...empty(),status:'error',error:error instanceof ApiError&&[403,404].includes(error.status)?'当前资源不可访问，权限可能已变更，请刷新登录状态后重试。':error instanceof Error&&error.name==='TimeoutError'?'读取超时，请刷新重试。':'未能读取当前授权资源，请确认登录状态和服务连接后重试。'});}}
 }
 async function refreshAutomatically(){
  // Session polling must neither starve slow reads nor retry a failed read.
  if(state.status==='loading'||state.status==='error')return;
  await refresh();
 }
 return {getSnapshot:()=>state,refresh,refreshAutomatically,subscribe(listener:()=>void){listeners.add(listener);unregister??=identitySession.onReset(reset);return()=>{listeners.delete(listener);if(!listeners.size){unregister?.();unregister=undefined;reset();}};}};
}
