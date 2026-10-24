export function plainPath(path:string):string;
export function readEvidence(path:string,maxBytes?:number):{data:unknown;sha256:string};
export function contains(parent:string,child:string):boolean;
export function saveReport(directory:string,text:string):void;
