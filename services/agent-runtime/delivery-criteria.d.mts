export type DeliveryCriterionEvidence={criterionId:string;description:string;status:string;reason:string;evidenceRefs:{taskId:string;criterionIndex:number;sourceRunId:string;attemptId:string;kind:string}[]};
export function evaluateDeliveryCriteria(snapshot:any,records:Map<string,any>,effectiveTasks?:any[],currentFiles?:{path:string;sha256:string}[]):DeliveryCriterionEvidence[];
export function assertDeliveryCriteria(snapshot:any,records:Map<string,any>,effectiveTasks?:any[],currentFiles?:{path:string;sha256:string}[]):DeliveryCriterionEvidence[];
