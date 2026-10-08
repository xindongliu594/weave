import {setTimeout as pause} from 'node:timers/promises';

// Only a stale authenticated device heartbeat is recoverable here. Each attempt
// owns and releases its transaction before this function waits; no dispatch or
// reservation may happen until the attempt has passed every admission check.
export const LOCAL_ADMISSION_WAIT_MS=10_000;
export const LOCAL_ADMISSION_POLL_MS=250;
export async function withFreshLocalAdmission<T>(attempt:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
 let expires:number|undefined;
 while(true){
  signal?.throwIfAborted();
  try{return await attempt();}
  catch(error){
   signal?.throwIfAborted();
   if((error as any)?.code!=='LOCAL_DEVICE_OFFLINE')throw error;
   expires??=Date.now()+LOCAL_ADMISSION_WAIT_MS;
   const remaining=expires-Date.now();if(remaining<=0)throw error;
   try{await pause(Math.min(LOCAL_ADMISSION_POLL_MS,remaining),undefined,{signal});}
   catch(waitError){signal?.throwIfAborted();throw waitError;}
  }
 }
}
