import {createHash} from 'node:crypto';

export const PLANNING_OUTPUT_MAX_BYTES=256*1024;
export const PLANNING_OUTPUT_MAX_DEPTH=64;
export const PLANNING_OUTPUT_MAX_OUTSIDE_CHARS=512;
const finishReasons=['stop','length','content_filter','tool_calls','function_call','incomplete','unknown'] as const;
export type OutputFinishReason=typeof finishReasons[number];
export function safeFinishReason(value:unknown):OutputFinishReason|undefined{
 if(value===undefined||value===null)return undefined;
 return typeof value==='string'&&(finishReasons as readonly string[]).includes(value)?value as OutputFinishReason:'unknown';
}
export const PLANNING_SCHEMA_ISSUE_LIMIT=12;
const schemaFields=new Set('rationale agents tasks knowledgeDocumentIds runInputs workFileSelections id name role title instructions modelId tools browserOrigins mcpConnections connectionId version roleVersion templateId systemConstraints outputFormat reasoningEffort knowledgeSpaceIds fallbackModelId sourceDepartmentId sourceAgentId subject objective assigneeId dependencies acceptanceCriteria estimatedInputTokens estimatedOutputTokens maxOutputTokens maxBudget maxModelCalls kind inputs outputs inScope outOfScope verify reviewedTaskId sourceTaskId sourceFindingIds maxReworkRounds path producerTaskId sha256 format requiredKeys expectedValues content agentIds snapshotId paths mode'.split(' '));
const arrayFields=new Set('agents tasks knowledgeDocumentIds runInputs workFileSelections tools browserOrigins mcpConnections knowledgeSpaceIds dependencies acceptanceCriteria inputs outputs inScope outOfScope verify sourceFindingIds requiredKeys agentIds paths'.split(' '));
for(const field of ['taskCallLimits','taskBudgetLimits','taskOutputLimits'])schemaFields.add(field);
for(const field of ['handoff','sections','key','requirement'])schemaFields.add(field);
arrayFields.add('sections');
const issueCodes=new Set('invalid_type too_big too_small invalid_format invalid_value invalid_union invalid_key invalid_element unrecognized_keys not_multiple_of custom'.split(' '));
const schemaTypes=new Set('string number int boolean array object null undefined record'.split(' '));
const schemaFormats=new Set('regex url uuid email datetime date time duration'.split(' '));
const enumValues=new Set('manager member low medium high artifact_write filesystem terminal_test terminal knowledge_search knowledge_read browser_read mcp_call_readonly work requirements implementation verification review repair integration text json reference workspace'.split(' '));
const customRules:Record<string,string>={
 '输入必须绑定来源任务或固定 SHA256':'input-source-required',
 '字段检查需要 JSON 格式':'field-checks-require-json',
 '需要工作区相对路径，不能包含越界或团队状态目录':'workspace-relative-path',
 '请填写精确网站来源，如 https://example.com':'exact-http-origin',
 '本次资料 ID 不能重复':'unique-run-input-ids',
 '本次资料正文合计不能超过 250,000 字符':'run-input-total-max-250000',
 '不支持二进制资料':'no-nul-characters',
};
export type PlanningSchemaIssue={path:(string|number)[];code:string;expected:{type?:string;minimum?:number;maximum?:number;inclusive?:boolean;values?:string[];format?:string;multipleOf?:number;rule?:string}};
export type PlanningSchemaSummary={schemaIssues:PlanningSchemaIssue[];schemaIssueCount:number;schemaIssuesTruncated:boolean};
/** Never copy Zod.message, input, received, key, keys, pattern or nested union
 * errors. Record keys and unknown field names are not public schema paths. */
export function safePlanningSchemaIssues(issues:readonly unknown[]):PlanningSchemaSummary{
 const schemaIssues=issues.slice(0,PLANNING_SCHEMA_ISSUE_LIMIT).map(value=>{
  const issue=value&&typeof value==='object'?value as Record<string,unknown>:{},sourcePath=Array.isArray(issue.path)?issue.path:[],path=sourcePath.slice(0,16).map((part,index)=>{
   if(sourcePath[index-1]==='expectedValues')return '<field>';
   if(typeof part==='number')return Number.isSafeInteger(part)&&part>=0&&part<=9999&&arrayFields.has(String(sourcePath[index-1]))?part:'<field>';
   return typeof part==='string'&&schemaFields.has(part)?part:'<field>';
  });
  const code=typeof issue.code==='string'&&issueCodes.has(issue.code)?issue.code:'schema_constraint',expected:PlanningSchemaIssue['expected']={};
  const type=issue.expected??issue.origin;if(typeof type==='string'&&schemaTypes.has(type))expected.type=type;
  for(const name of ['minimum','maximum','multipleOf'] as const){const bound=issue[name];if(typeof bound==='number'&&Number.isFinite(bound)&&Math.abs(bound)<=1e12)expected[name]=bound;}
  if(typeof issue.inclusive==='boolean')expected.inclusive=issue.inclusive;
  if(typeof issue.format==='string'&&schemaFormats.has(issue.format))expected.format=issue.format;
  if(code==='invalid_value'&&Array.isArray(issue.values)){const values=issue.values.filter((item):item is string=>typeof item==='string'&&enumValues.has(item)).slice(0,20);if(values.length)expected.values=values;}
  if(code==='custom')expected.rule=typeof issue.message==='string'&&Object.hasOwn(customRules,issue.message)?customRules[issue.message]:'plan-schema-refinement';
  else if(code==='unrecognized_keys')expected.rule='unknown-fields-not-allowed';
  else if(code==='invalid_union')expected.rule='one-schema-alternative-required';
  else if(code==='invalid_key')expected.rule='record-key-constraint';
  if(!Object.keys(expected).length)expected.rule='plan-schema-constraint';
  return {path,code,expected};
 });
 return {schemaIssues,schemaIssueCount:Math.min(issues.length,100000),schemaIssuesTruncated:issues.length>schemaIssues.length};
}
export function planningSchemaMessage(summary?:PlanningSchemaSummary){
 if(!summary?.schemaIssues.length)return '';
 const fields=summary.schemaIssues.slice(0,3).map(issue=>{
  const path=issue.path.reduce<string>((text,part)=>typeof part==='number'?text+'['+part+']':text+(text?'.':'')+part,'')||'$';
  const constraint=issue.expected.maximum!==undefined?(issue.expected.inclusive===false?'小于 ':'最大 ')+issue.expected.maximum:issue.expected.minimum!==undefined?(issue.expected.inclusive===false?'大于 ':'最小 ')+issue.expected.minimum:issue.expected.values?'允许 '+issue.expected.values.join('/') :issue.expected.type?'需要 '+issue.expected.type:issue.expected.format?'格式 '+issue.expected.format:issue.expected.rule??'结构约束';
  return path+'：'+constraint+'（'+issue.code+'）';
 });
 return '字段问题：'+fields.join('；')+(summary.schemaIssueCount>3?'；其它问题见诊断清单':'')+'。';
}
export type PlanningOutputDiagnostic={reason:string;position:number|null;finishReason?:OutputFinishReason;originalOutputSHA:string;outputBytes:number}&Partial<PlanningSchemaSummary>;
export class PlanningOutputError extends Error{
 schema?:PlanningSchemaSummary;
 constructor(public reason:string,public position:number|null=null,issues?:readonly unknown[]){super(reason);if(issues)this.schema=safePlanningSchemaIssues(issues);}
}
export function planningOutputMetadata(raw:unknown,finishReason?:unknown){
 const text=typeof raw==='string'?raw:'';
 return {finishReason:safeFinishReason(finishReason),originalOutputSHA:createHash('sha256').update(text).digest('hex'),outputBytes:Buffer.byteLength(text)};
}
export function planningOutputDiagnostic(raw:unknown,finishReason:unknown,error:PlanningOutputError):PlanningOutputDiagnostic{
 return {...planningOutputMetadata(raw,finishReason),reason:error.reason,position:error.position,...error.schema};
}

/** Extract one complete object without editing a byte of the JSON candidate.
 * Structural scanning is bounded, honors strings/escapes, and uses JSON.parse
 * for syntax. Outside material is short prose, never another value or fence. */
export function extractPlanningObject(raw:unknown):Record<string,unknown>{
 if(typeof raw!=='string'||!raw.trim())throw new PlanningOutputError('EMPTY_OUTPUT');
 if(Buffer.byteLength(raw)>PLANNING_OUTPUT_MAX_BYTES)throw new PlanningOutputError('OUTPUT_TOO_LARGE');
 const start=raw.search(/[\[{]/);
 if(start<0)throw new PlanningOutputError('OBJECT_REQUIRED');
 if(raw[start]!=='{')throw new PlanningOutputError('OBJECT_REQUIRED',start);
 const stack:string[]=[];let quoted=false,escaped=false,end=-1;
 for(let at=start;at<raw.length;at++){
  const char=raw[at];
  if(quoted){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;continue;}
  if(char==='"'){quoted=true;continue;}
  if(char==='{'||char==='['){stack.push(char);if(stack.length>PLANNING_OUTPUT_MAX_DEPTH)throw new PlanningOutputError('NESTING_TOO_DEEP',at);}
  else if(char==='}'||char===']'){
   if(stack.pop()!==(char==='}'?'{':'['))throw new PlanningOutputError('INVALID_JSON',at);
   if(!stack.length){end=at+1;break;}
  }
 }
 if(end<0)throw new PlanningOutputError('TRUNCATED_JSON',raw.length);
 let prefix=raw.slice(0,start),suffix=raw.slice(end);
 const opening=/```(?:json)?[ \t]*(?:\r?\n)?\s*$/i.exec(prefix);
 if(opening){
  prefix=prefix.slice(0,opening.index);
  const closing=/^\s*```(?:[ \t]*\r?\n|[ \t]*$)/.exec(suffix);
  if(!closing)throw new PlanningOutputError('INVALID_FENCE',end);
  suffix=suffix.slice(closing[0].length);
 }
 if(prefix.includes('```')||suffix.includes('```'))throw new PlanningOutputError('AMBIGUOUS_JSON',end);
 if(/[\[\]{}]/.test(prefix)||/[\[\]{}]/.test(suffix))throw new PlanningOutputError('AMBIGUOUS_JSON',end);
 if(prefix.trim().length>PLANNING_OUTPUT_MAX_OUTSIDE_CHARS||suffix.trim().length>PLANNING_OUTPUT_MAX_OUTSIDE_CHARS)throw new PlanningOutputError('OUTSIDE_TEXT_TOO_LONG',end);
 // An additional scalar JSON value is ambiguous even without another brace.
 if([prefix,suffix].some(part=>/^(?:"|null(?:\s|$)|true(?:\s|$)|false(?:\s|$)|-?\d)/.test(part.trim())))throw new PlanningOutputError('AMBIGUOUS_JSON',end);
 let value:unknown;
 try{value=JSON.parse(raw.slice(start,end));}
 catch(error){
  const offset=/\bposition (\d+)\b/.exec((error as Error).message)?.[1];
  throw new PlanningOutputError('INVALID_JSON',offset===undefined?start:start+Number(offset));
 }
 if(!value||typeof value!=='object'||Array.isArray(value))throw new PlanningOutputError('OBJECT_REQUIRED',start);
 return value as Record<string,unknown>;
}
