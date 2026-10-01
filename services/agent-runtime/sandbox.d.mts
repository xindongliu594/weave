export const SANDBOX_IMAGE: string;
export function validArtifactPath(value:string):string;
export function artifactFile(root:string,path:string):string;
export function listArtifacts(root:string):{path:string;size:number;sha256:string}[];
export function command(args:string[],options?:any):Promise<string>;
export class RunSandbox {
  static assertReady(signal?:AbortSignal):Promise<void>;
  constructor(id:string,root:string);
  root:string;
  revision():string;
  execute(name:string,args:any,signal?:AbortSignal):Promise<any>;
  close():Promise<void>;
}
