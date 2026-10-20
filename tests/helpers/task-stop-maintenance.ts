import type {SandboxMaintenance} from '../../apps/api/src/storage-lifecycle.ts';

/** In-progress API fixtures never accept tasks; any stop is a test failure. */
export function inProgressTaskMaintenance(deviceId:string,grantId:string,fingerprint:string){
 const unexpected=async():Promise<never>=>{throw Error('In-progress fixture unexpectedly requested accepted-task maintenance');};
 const executor:SandboxMaintenance['executor']={acceptedStopCapabilities:()=>({version:1,deadline:'shared-abort-v1'}),storageScopes:()=>[],inspectStorage:unexpected,retireStorage:unexpected,reconcileStorage:unexpected,stopAcceptedTask:unexpected,reconcileAcceptedTaskStop:unexpected};
 return {sandboxMaintenance:()=>({deviceId,grantId,fingerprint,executor})};
}
