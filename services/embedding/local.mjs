import { readFileSync,existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve,join } from 'node:path';
const lock=JSON.parse(readFileSync(new URL('./model-lock.json',import.meta.url),'utf8'));
export const embeddingVersion=`${lock.repository}@${lock.revision}:transformers-4.3.0:q8:mean:normalized:windows-v1`;
export const embeddingDimensions=lock.dimensions;
export const modelDirectory=()=>resolve(process.env.EMBEDDING_MODEL_DIR??join(process.env.DATA_DIR??'.data','embedding-models'));
let extractorPromise,checkedPath;
let chain=Promise.resolve();
export function embeddingStatus(){const directory=modelDirectory();return {installed:Object.keys(lock.files).every(name=>existsSync(join(directory,lock.repository,name))),model:lock.repository,embeddingVersion,dimensions:embeddingDimensions};}
function verifyFiles(){const directory=modelDirectory();if(checkedPath===directory)return;
 for(const [name,hash]of Object.entries(lock.files)){const file=join(directory,lock.repository,name);if(!existsSync(file)||createHash('sha256').update(readFileSync(file)).digest('hex')!==hash)throw Error('本地嵌入模型缺失或校验失败，请运行安装脚本');}checkedPath=directory;
}
async function extractor(){verifyFiles();return extractorPromise??=import('@huggingface/transformers').then(async({pipeline,env})=>{
 env.allowRemoteModels=false;env.allowLocalModels=true;env.localModelPath=modelDirectory()+'/';
 return pipeline('feature-extraction',lock.repository,{dtype:'q8',device:'cpu',local_files_only:true,session_options:{intraOpNumThreads:2,interOpNumThreads:1}});
}).catch(error=>{extractorPromise=undefined;throw error;});}
/** Bound tokenizer windows so long Chinese or code chunks cannot silently lose their suffix. */
export async function embedTexts(texts,kind='passage'){
 if(!['query','passage'].includes(kind)||!Array.isArray(texts)||texts.length>32||texts.some(t=>typeof t!=='string'||t.length>100000))throw Error('Invalid embedding input');
 const job=chain.then(async()=>{
  const pipe=await extractor(),result=[];
  for(const text of texts){
   const points=Array.from(text),windows=[];
   // 240 Unicode characters is conservative for this multilingual tokenizer; overlapping windows cover all text.
   for(let start=0;start<Math.max(1,points.length);start+=200)windows.push(points.slice(start,start+240).join(''));
   const sum=new Array(embeddingDimensions).fill(0);
   for(let i=0;i<windows.length;i++){
    const window=windows[i],encoded=pipe.tokenizer(kind+': '+window,{truncation:false});
    if(encoded.input_ids.data.length>512){const chars=Array.from(window),middle=Math.ceil(chars.length/2);windows.splice(i,1,chars.slice(0,middle).join(''),chars.slice(middle).join(''));i--;continue;}
    const output=await pipe(kind+': '+window,{pooling:'mean',normalize:true});
    const vector=output.tolist()[0];if(vector.length!==embeddingDimensions||vector.some(v=>!Number.isFinite(v)))throw Error('Invalid embedding dimensions');
    vector.forEach((value,i)=>sum[i]+=value);
   }
   const norm=Math.hypot(...sum);if(!norm)throw Error('Empty embedding');result.push(sum.map(value=>value/norm));
  }
  return result;
 });
 chain=job.catch(()=>{});return job;
}
export async function closeEmbedding(){await chain;if(extractorPromise){const pipe=await extractorPromise;await pipe.dispose();extractorPromise=undefined;}checkedPath=undefined;}
