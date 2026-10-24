import {api} from './api.ts';
import type {queryAuditEvents} from '../../api/src/audit-query.ts';

export type AuditPage=Awaited<ReturnType<typeof queryAuditEvents>>;
export type AuditFilters={runId?:string;correlationId?:string;outcome?:string;after?:string;before?:string};
type Snapshot={page:AuditPage|null;loading:boolean;error:string};
type Send=(path:string,signal:AbortSignal)=>Promise<AuditPage>;

/** One visible panel owns one cancellable read; closing it drops all history. */
export function createAuditHistoryReader(send:Send=(path,signal)=>api<AuditPage>(path,'GET',undefined,undefined,signal)) {
 let state:Snapshot={page:null,loading:false,error:''},active=false,disposed=false,serial=0,pending:Promise<void>|undefined,controller:AbortController|undefined;
 const listeners=new Set<()=>void>();
 const publish=(next:Snapshot)=>{state=next;for(const listener of listeners)listener();};
 function setActive(value:boolean){
  if(disposed||active===value)return;active=value;
  if(!value){serial++;controller?.abort();publish({page:null,loading:false,error:''});}
 }
 function load(filters:AuditFilters,cursor?:string):Promise<void>{
  if(disposed||!active)return Promise.resolve();if(pending)return pending;
  const ticket=++serial;controller=new AbortController();const signal=controller.signal;
  const parameters=new URLSearchParams({limit:'50'});for(const [key,value] of Object.entries(filters))if(value)parameters.set(key,value);if(cursor)parameters.set('cursor',cursor);
  publish({page:null,loading:true,error:''});
  const work=(async()=>{try{
   const page=await send(`/audit/events?${parameters}`,signal);
   if(active&&!disposed&&ticket===serial)publish({page,loading:false,error:''});
  }catch(error){if(active&&!disposed&&ticket===serial)publish({page:null,loading:false,error:error instanceof Error?error.message:'审计记录读取失败，请手动刷新。'});}
  finally{pending=undefined;controller=undefined;}})();
  pending=work;return work;
 }
 return {getSnapshot:()=>state,subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},setActive,load,
  dispose(){setActive(false);disposed=true;listeners.clear();}};
}
