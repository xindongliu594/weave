export const embeddingVersion:string;
export const embeddingDimensions:number;
export function modelDirectory():string;
export function embeddingStatus():{installed:boolean;model:string;embeddingVersion:string;dimensions:number};
export function embedTexts(texts:string[],kind?:'passage'|'query'):Promise<number[][]>;
export function closeEmbedding():Promise<void>;
