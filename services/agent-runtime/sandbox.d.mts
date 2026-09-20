export const SANDBOX_IMAGE: string;
export function validArtifactPath(value:string):string;
export function artifactFile(root:string,path:string):string;
export function listArtifacts(root:string):{path:string;size:number;sha256:string}[];
export function command(args:string[],options?:any):Promise<string>;
