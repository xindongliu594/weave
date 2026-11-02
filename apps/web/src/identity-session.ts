export type IdentityUser = {id:string;displayName:string|null;email:string|null;status:'pending'|'active'|'disabled';orgRole:'admin'|'member'|'auditor'};
type Session = {mode:'legacy-local'|'oidc';authenticated:boolean;user:IdentityUser|null;csrf:string|null;loginAvailable:boolean};
export type IdentitySnapshot = {status:'loading'|'local-owner'|'authenticated'|'pending'|'disabled'|'member'|'signed-out'|'unavailable';session:Session|null;generation:number;error:string;busy:boolean};
type Options = {fetch?:typeof fetch;navigate?:(url:string)=>void;activity?:Pick<EventTarget,'addEventListener'|'removeEventListener'>;visibility?:Pick<EventTarget,'addEventListener'|'removeEventListener'>;visible?:()=>boolean;schedule?:(fn:()=>void,ms:number)=>unknown;cancel?:(id:unknown)=>void};
const base=()=>import.meta.env?.BASE_URL??'/';
function decode(value:any):Session {
 if(!value||!['legacy-local','oidc'].includes(value.mode)||typeof value.authenticated!=='boolean'||typeof value.loginAvailable!=='boolean')throw Error('Invalid session');
 if(value.mode==='legacy-local'){
  if(!value.authenticated||value.user!==null||value.csrf!==null||value.loginAvailable)throw Error('Invalid local session');
 }else{
  if(typeof value.csrf!=='string'||!value.csrf||value.csrf.length>128)throw Error('Invalid session token');
  const u=value.user;
  if(u!==null&&(!u||typeof u.id!=='string'||!u.id||!(u.displayName===null||typeof u.displayName==='string')||!(u.email===null||typeof u.email==='string')||!['pending','active','disabled'].includes(u.status)||!['admin','member','auditor'].includes(u.orgRole)))throw Error('Invalid identity');
  if(value.authenticated&&(!u||u.status!=='active'))throw Error('Invalid authentication');
 }
 return value;
}
const statusOf=(s:Session):IdentitySnapshot['status']=>s.mode==='legacy-local'?'local-owner':s.user?.status==='pending'?'pending':s.user?.status==='disabled'?'disabled':s.authenticated?(s.user?.orgRole==='admin'?'authenticated':'member'):'signed-out';
export const identityAuthorized=(s:IdentitySnapshot)=>s.status==='local-owner'||s.status==='authenticated';
export const identityMemberReadable=(s:IdentitySnapshot)=>s.status==='member'&&s.session?.authenticated===true&&s.session.user?.status==='active'&&s.session.user.orgRole==='member';
const scopeOf=(s:IdentitySnapshot)=>s.status==='local-owner'?'legacy-local':s.session?.user?`human:${s.session.user.id}:${s.session.user.orgRole}:${s.session.user.status}:${s.session.authenticated}`:s.status;

export function createIdentitySession(options:Options={}) {
 let snapshot:IdentitySnapshot={status:'loading',session:null,generation:0,error:'',busy:false};
 let pending:Promise<void>|undefined,serial=0,timer:unknown,reads=new AbortController(),loggingOut=false,logoutUnconfirmed=false;
 const listeners=new Set<()=>void>(),resets=new Set<()=>void>();
 const send:typeof fetch=(...args)=>(options.fetch??globalThis.fetch)(...args);
 const visible=options.visible??(()=>true),schedule=options.schedule??((fn,ms)=>setTimeout(fn,ms)),cancel=options.cancel??(id=>clearTimeout(id as ReturnType<typeof setTimeout>));
 function stop(){if(timer!==undefined){cancel(timer);timer=undefined;}}
 function publish(next:IdentitySnapshot){
  const changed=scopeOf(next)!==scopeOf(snapshot);
  if(changed){next={...next,generation:snapshot.generation+1};reads.abort();reads=new AbortController();}
  snapshot=next;
  // Publish the revoked identity even if an optional cache cannot clear itself.
  if(changed)for(const reset of resets){try{reset();}catch{snapshot={...snapshot,status:'unavailable',session:null,error:'工作空间缓存未能清理，请重新加载网页。'};}}
  for(const listener of listeners)listener();
 }
 function later(){if(!logoutUnconfirmed&&timer===undefined&&!pending&&listeners.size&&visible())timer=schedule(()=>{timer=undefined;if(!logoutUnconfirmed&&listeners.size&&visible())void refresh();},15000);}
 function refresh():Promise<void>{
  if(loggingOut)return Promise.resolve();
  if(pending)return pending;stop();const ticket=++serial;
  const work=(async()=>{try{
   const response=await send(base()+'auth/session',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(15000)});
   if(!response.ok)throw Error('Session unavailable');const session=decode(await response.json());
   if(ticket===serial)publish({...snapshot,status:statusOf(session),session,error:''});
  }catch{if(ticket===serial)publish({...snapshot,status:'unavailable',session:null,error:'无法确认登录状态，请检查服务后刷新。'});}
  finally{if(ticket===serial){pending=undefined;later();}}})();
  pending=work;return work;
 }
 function invalidate(){serial++;pending=undefined;stop();publish({...snapshot,status:'signed-out',session:null,busy:false,error:'登录已失效，请重新登录；已提交操作请先核对结果。'});later();}
 function wake(){stop();if(!logoutUnconfirmed&&listeners.size&&visible())void refresh();}
 function suspend(){stop();if(logoutUnconfirmed)return;serial++;pending=undefined;publish({...snapshot,status:'loading',session:null,busy:false,error:''});}
 function restore(){if(snapshot.session?.user||identityAuthorized(snapshot))suspend();wake();}
 function subscribe(listener:()=>void){listeners.add(listener);if(listeners.size===1){options.activity?.addEventListener('focus',wake);options.activity?.addEventListener('pagehide',suspend);options.activity?.addEventListener('pageshow',restore);options.visibility?.addEventListener('visibilitychange',wake);if(!logoutUnconfirmed)void refresh();}return()=>{listeners.delete(listener);if(!listeners.size){stop();options.activity?.removeEventListener('focus',wake);options.activity?.removeEventListener('pagehide',suspend);options.activity?.removeEventListener('pageshow',restore);options.visibility?.removeEventListener('visibilitychange',wake);}};}
 async function requireAuthorized(){if(snapshot.status==='loading')await refresh();if(!identityAuthorized(snapshot))throw Error('请先确认登录状态和工作空间权限。');return {generation:snapshot.generation,csrf:snapshot.session!.csrf,signal:reads.signal};}
 async function requireMemberRead(){if(snapshot.status==='loading')await refresh();if(!identityMemberReadable(snapshot))throw Error('请先确认成员身份和资源读取权限。');return {generation:snapshot.generation,signal:reads.signal};}
 async function authAction(kind:'login'|'logout',returnTo=base()){
  if(snapshot.busy)return;
  if(!snapshot.session)await refresh();
  const session=snapshot.session;if(!session||session.mode!=='oidc')return;
  if(kind==='logout'){loggingOut=true;logoutUnconfirmed=true;invalidate();}
  const generation=snapshot.generation;publish({...snapshot,busy:true,error:''});
  try{
   const response=await send(base()+'auth/'+kind,{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf!},...(kind==='login'?{body:JSON.stringify({returnTo})}:{})});
   if(generation!==snapshot.generation)return;
   if(response.status===401){invalidate();return;}
   if(!response.ok)throw Error(kind==='login'?'登录暂不可用，请刷新登录状态后重试。':'退出结果尚未确认，请刷新登录状态后核对。');
   if(kind==='logout'){loggingOut=false;logoutUnconfirmed=false;await refresh();}
   else {const data=await response.json();if(generation!==snapshot.generation)return;const url=new URL(data.authorizationUrl);if(url.protocol!=='https:'||url.username||url.password)throw Error('登录地址无效，请刷新后重试。');(options.navigate??(url=>window.location.assign(url)))(url.href);}
  }catch(error){if(generation===snapshot.generation)publish({...snapshot,error:error instanceof Error?error.message:'登录服务暂不可用。'});}
  finally{loggingOut=false;publish({...snapshot,busy:false});}
 }
 return {getSnapshot:()=>snapshot,subscribe,refresh:()=>{if(!loggingOut)logoutUnconfirmed=false;return refresh();},invalidate,requireAuthorized,requireMemberRead,login:(returnTo?:string)=>authAction('login',returnTo),logout:()=>authAction('logout'),onReset(fn:()=>void){resets.add(fn);return()=>{resets.delete(fn);};}};
}
export const identitySession=createIdentitySession({activity:typeof window==='undefined'?undefined:window,visibility:typeof document==='undefined'?undefined:document,visible:()=>typeof document==='undefined'||!document.hidden});

// Capture the principal now so a late old component cannot write into a new user's draft.
export function principalStorage(storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>){
 const state=identitySession.getSnapshot(),principal=state.status==='local-owner'?'legacy-local':identityAuthorized(state)?`human:${state.session!.user!.id}`:undefined;
 const key=(value:string)=>{if(!principal)throw Error('Session is not authorized');return principal==='legacy-local'?value:`weiwu:${encodeURIComponent(principal)}:${value}`;};
 return {getItem:(value:string)=>storage.getItem(key(value)),setItem:(value:string,data:string)=>storage.setItem(key(value),data),removeItem:(value:string)=>storage.removeItem(key(value))};
}
