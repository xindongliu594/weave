export type OfficeInput = {format:'csv'|'docx'|'xlsx';title?:string;text?:string;rows?:(string|number|boolean|null)[][]};
export function readOfficeFile(path:string,buffer:Buffer):{kind:string;text:string;warnings:string[]};
export function createOfficeFile(input:OfficeInput):{buffer:Buffer;mimeType:string;extension:string};
