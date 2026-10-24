import {api} from './api.ts';
import type {EffectContract} from '../../../packages/contracts/tool-effects.ts';
export type ToolEffectReview={digest:string;contract:EffectContract;status:'unreviewed'|'reviewed'|'retired';version?:number};
type State={items:EffectContract[];selected:ToolEffectReview|null;busy:boolean;error:string};
type Send=(path:string,method:string,body:unknown,signal?:AbortSignal)=>Promise<unknown>;
export const canReviewToolEffect=(item:ToolEffectReview|null)=>!!item&&item.status==='unreviewed'&&item.contract.effect!=='unknown'&&item.contract.cost.kind==='free'&&item.contract.retry!=='provider-key';

export function createToolEffectReviewClient(send:Send=(path,method,body,signal)=>api(path,method,body,undefined,signal)){
 let state:State={items:[],selected:null,busy:false,error:''},active=false,disposed=false,serial=0,pending:Promise<void>|undefined,controller:AbortController|undefined;
 const listeners=new Set<()=>void>();
 const publish=(next:State)=>{state=next;for(const listener of listeners)listener();};
 function setActive(value:boolean){active=value;if(!value){serial++;controller?.abort();controller=undefined;pending=undefined;publish({items:[],selected:null,busy:false,error:''});}}
 function request(path:string,method='GET',body?:unknown,catalog=false):Promise<void>{
  if(!active||disposed)return Promise.resolve();if(pending)return pending;
  const ticket=++serial;controller=new AbortController();publish({...state,selected:null,busy:true,error:''});
  const work=(async()=>{try{const result=await send(path,method,body,controller?.signal);
   if(active&&!disposed&&ticket===serial)publish({...state,...(catalog?{items:result as EffectContract[]}:{selected:result as ToolEffectReview}),busy:false,error:''});
  }catch(error){if(active&&!disposed&&ticket===serial)publish({items:[],selected:null,busy:false,error:error instanceof Error?error.message:'无法确认操作结果，请重新读取当前状态。'});}
  finally{if(ticket===serial){pending=undefined;controller=undefined;}}})();pending=work;return work;
 }
 return {getSnapshot:()=>state,subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},setActive,
  catalog:()=>request('/tool-effect-contracts/sources','GET',undefined,true),
  select:(key:Pick<EffectContract,'namespace'|'toolName'>)=>request('/tool-effect-contracts/candidate?'+new URLSearchParams({namespace:key.namespace,toolName:key.toolName})),
  review(){const item=state.selected;return canReviewToolEffect(item)?request('/tool-effect-contracts/reviews','POST',{namespace:item!.contract.namespace,toolName:item!.contract.toolName,expectedDigest:item!.digest}):Promise.resolve();},
  retire(){const item=state.selected;return item?.status==='reviewed'&&Number.isInteger(item.version)?request('/tool-effect-contracts/'+encodeURIComponent(item.digest)+'/retire','POST',{expectedVersion:item.version}):Promise.resolve();},
  dispose(){setActive(false);disposed=true;listeners.clear();},
 };
}
