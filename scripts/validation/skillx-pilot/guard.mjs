export const POLICY=Object.freeze({sourceRunId:'e5b2acfd-ecc4-4127-bd2f-4e65aad60baa',modelId:'c8a4e6ad-1aaf-43a4-8ba1-d0a6cce59051',
  pilotId:'skillx-pilot-20261015',purpose:'SkillX隔离试验 2026-10-15',budget:.03,cumulative:2.80,phase:.72,phaseBaseline:2.0708184,
  stages:Object.freeze({'extract':4096,'general-filter':1024,'tool-filter':1024})});
export function quotePilot(state,request){
 const deny=()=>{throw Error('PILOT_ADMISSION_DENIED');};
 if(!state.approved||state.sourceRunId!==POLICY.sourceRunId||state.sourceStatus!=='completed'||state.integrity!=='ok'||!state.shareable||
    state.modelId!==POLICY.modelId||state.inputRate!==.3||state.outputRate!==1.2||state.pendingCount||state.activeRuns)deny();
 if(!Number.isInteger(state.callCount)||state.callCount<0||state.callCount>=3||Object.keys(POLICY.stages)[state.callCount]!==request.stage)deny();
 if(!Number.isSafeInteger(request.inputBytes)||request.inputBytes<1||request.inputBytes>24000||
    !Number.isFinite(request.reservation)||request.reservation<0)deny();
 const amount=(request.inputBytes*.3+POLICY.stages[request.stage]*1.2)/1e6;
 if(Math.abs(amount-request.reservation)>1e-10)deny();
 if(!Number.isFinite(state.occupied)||state.occupied<0||!Number.isFinite(state.trialOccupied)||state.trialOccupied<0||
    state.occupied+amount>POLICY.cumulative+1e-10||state.occupied-POLICY.phaseBaseline+amount>POLICY.phase+1e-10||
    state.trialOccupied+amount>POLICY.budget+1e-10)deny();
 return amount;
}
