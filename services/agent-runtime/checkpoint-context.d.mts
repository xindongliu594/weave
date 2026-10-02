export function buildCheckpointContext(snapshot:any,events:any[],states:Map<string,any>,completed:Map<string,any>,root:string,sourceRunId:string):any;
export function recoveryContext(snapshot:any,taskId:string):any;
export function readRecoveryContext(snapshot:any,archiveDir:string,currentTaskId:string,args?:any):any;
export function taskHistory(events:any[],taskId:string):any[];
export function ancestors(tasks:any[],id:string):Set<string>;
