export function checkpointDigest(value:any):string;
export function checkpointFiles(workspace:string):Array<{path:string;size:number;sha256:string;content:Buffer}>;
export function commitStepCheckpoint(options:any):any;
export function readStepCheckpoint(options:{root:string;runId:string;checkpointId:string}):any;
