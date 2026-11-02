export function checkpointDigest(value:any):string;
export function checkpointFiles(workspace:string):Array<{path:string;size:number;sha256:string;content:Buffer}>;
export function commitStepCheckpoint(options:any):any;
export function readStepCheckpoint(options:{root:string;runId:string;checkpointId:string}):any;
export function readStepCheckpoints(options:{root:string;runId:string}):Map<string,any>;
export function validateCheckpointReceipts(runs:Map<string,any>,checkpoint:any):void;
export function checkpointContract(snapshot:any,task:any,taskRefs?:import('../../packages/contracts/task-execution.ts').TaskCheckpointRefs):string;
export function checkpointLineage(root:string,source:any):Map<string,any>;
export function checkpointEnvironment(snapshot:any,proof:any,taskRefs?:import('../../packages/contracts/task-execution.ts').TaskCheckpointRefs):string|null;
export function validateInheritedEvidence(options:any):{reusable:boolean;reasons:string[];evidenceRefs:any[]};

export function validateTaskCheckpointRefs(refs:any,options?:{runId?:string;taskId?:string;attemptId?:string;generation?:number;archiveDir?:string;checkedObjects?:Set<string>}):import('../../packages/contracts/task-execution.ts').TaskCheckpointRefs;
