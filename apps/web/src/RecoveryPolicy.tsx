import type {Policy} from '../../../packages/contracts/index.ts';
export function RecoveryPolicy({policy,onChange}:{policy:Policy;onChange?:(value:Policy)=>void}){
 const fields=[['progressTimeoutSeconds','持续工作但无进展时限（秒）',60,3600,300],['repeatActionLimit','相同动作和结果重复上限',3,20,8],['repeatErrorLimit','同类错误连续上限',2,10,3],['maxReadRetries','短暂失败的只读操作重试次数',0,2,2]] as const;
 return <details className="lower-small"><summary>异常检测与恢复</summary><p className="subcopy">等待模型、执行名额或你的审批时，暂停无进展计时。文件变化、新验证证据和任务验收作为进展；结果未知的修改需要先核对。</p>{onChange?<div className="form-grid">{fields.map(([key,label,min,max,fallback])=><label className="field" key={key}>{label}<input type="number" required min={min} max={max} value={policy[key]??fallback} onChange={e=>onChange({...policy,[key]:e.target.valueAsNumber})}/></label>)}</div>:fields.map(([key,label,,,fallback])=><p key={key}>{label}：{policy[key]??fallback}</p>)}</details>;
}
