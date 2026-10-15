export const POLICY={sourceRunId:'e5b2acfd-ecc4-4127-bd2f-4e65aad60baa',candidateId:'reuse-7fc6493f431e89a7b2e2c0de541d424c02cff6c9',modelId:'c8a4e6ad-1aaf-43a4-8ba1-d0a6cce59051',purpose:'经验文档提炼 2026-10-15',previousPurpose:'SkillX隔离试验 2026-10-15',budget:.022,sharedBudget:.03,cumulative:2.80,phase:.72,phaseBaseline:2.0708184,stages:{extract:4096,'general-filter':2048}};
export function admit(s,request){
 const bad=()=>{throw Error('EXPERIENCE_ADMISSION_DENIED');};
 if(!s.sourceValid||s.pending||s.active||s.modelId!==POLICY.modelId||s.inputRate!==.3||s.outputRate!==1.2)bad();
 if(!Number.isInteger(s.count)||Object.keys(POLICY.stages)[s.count]!==request.stage)bad();
 if(!Number.isSafeInteger(request.inputBytes)||request.inputBytes<1||request.inputBytes>24000)bad();
 const amount=(request.inputBytes*.3+POLICY.stages[request.stage]*1.2)/1e6;
 if(!Number.isFinite(request.reservation)||Math.abs(request.reservation-amount)>1e-10)bad();
 if([s.occupied,s.own,s.shared].some(v=>!Number.isFinite(v)||v<0)||s.own+amount>POLICY.budget+1e-10||s.shared+amount>POLICY.sharedBudget+1e-10||s.occupied+amount>POLICY.cumulative+1e-10||s.occupied-POLICY.phaseBaseline+amount>POLICY.phase+1e-10)bad();
 return amount;
}
