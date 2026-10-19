import {createHash} from 'node:crypto';
const hash=text=>createHash('sha256').update(text).digest('hex');
const inputs=[{path:'a.txt',text:'10,8\n'},{path:'b.txt',text:'20,17\n'}].map(i=>({...i,sha256:hash(i.text)}));
export const cases=[
 {id:'sequential-report',prompt:'整理三条虚构记录（首页通过、登录通过、备份失败）：作者先形成原始事实表，下一位依据该表编写短总结，独立核对者检查事实和3/2/1统计，经理最后验收。后续步骤依赖前一步，文件各有唯一作者。'},
 {id:'independent-statistics',prompt:'甲组虚构工单10件解决8件，乙组20件解决17件。由两位员工各自独立整理本组统计到不同文件，全部结束后汇总总计30、解决25、未解决5，并由未参与原始产出的人员独立核对和经理验收。'},
 {id:'domain-routing',prompt:'请求属于办公资料汇总：把虚构会议记录“周一讨论排期，周二确认负责人”整理为待办表。先判断应走办公资料流程还是软件研发流程，说明选择理由，只保留选中的完整流程。独立核对来源，经理验收；不安排开发或终端。'},
 {id:'goal-decomposition',prompt:'为一个虚构读书社群拟定一次活动方案。请你依据目标自行拆分所需独立工作项、决定角色与人数，分工研究活动内容和组织事项，再汇总为短方案，独立检查是否覆盖目标，经理验收。无需外部检索，假设须明确标出；批准前固定全部工作项。'},
 {id:'bounded-code-review',prompt:'实现一个极小的 Node.js 摄氏转华氏函数，0对应32、100对应212，非法输入抛出错误。开发写函数，另一位独立QA写并运行测试，独立审查者据具体问题允许最多一次有范围的修复再审，最后经理验收。只规划文件合同、真实验证命令和明确验收，不实际调用终端。'},
 {id:'fixed-shards',inputs,prompt:'对两个固定的虚构输入文件分别统计工单总数和解决数，采用同一方法，每片恰好一个任务且只绑定本片不可变输入；完成后汇总，独立核对不漏片不重片及总计30、解决25、未解决5，经理验收。输入清单：'+JSON.stringify(inputs)},
 {id:'two-proposals',prompt:'为虚构内部周会提出两个不同方案：两位作者先各自独立提出，互不读取对方初始上下文；两份都完成后互相阅读并各做一次对方方案的质疑，保留依据和分歧；经理读取两个方案及两份质疑，独立检查事实后裁定或声明不足以决策。只一轮，不无限讨论。'},
];
export const trialLimits=Object.freeze({maxCalls:7,maxCallCost:.02,maxTrialCost:.14,maxCumulative:3.41,maxTokens:8192});
export function getTrial(profile='original'){
 if(profile==='original')return {cases,limits:trialLimits,sourceCommit:'580aafb',stopOnInvalid:false};
 if(profile==='repair-smoke')return {cases:[cases[0],cases[4]],limits:{...trialLimits,maxCalls:2,maxTrialCost:.04,maxTokens:4000},sourceCommit:'4283f2b',stopOnInvalid:true};
 if(profile==='feedback-correction')return {cases:[cases[4]],limits:{...trialLimits,maxCalls:1,maxTrialCost:.02,maxTokens:4000},sourceCommit:'5055aab',stopOnInvalid:true};
 if(profile==='delivery-binding')return {cases:[cases[4]],limits:{...trialLimits,maxCalls:1,maxTrialCost:.02,maxTokens:4000},sourceCommit:'a05f034',stopOnInvalid:true};
 throw Error('Unknown fixed trial profile');
}
export function stopAfterResult(trial,mode,result){return mode==='approved-real'&&trial.stopOnInvalid&&!result.preview;}
export function checkQuote({used,calls,quote,occupied,unknownChanged=false},limits=trialLimits){
 if(unknownChanged)throw Error('New or changed unknown receipt; stop without replay');
 if(![used,calls,quote,occupied].every(Number.isFinite)||!Number.isSafeInteger(calls)||calls<0||used<0||quote<=0||occupied<0)throw Error('Invalid quote');
 if(calls>=limits.maxCalls||quote>limits.maxCallCost+1e-10||used+quote>limits.maxTrialCost+1e-10||occupied+quote>limits.maxCumulative+1e-10)throw Error('Trial budget/call boundary: no dispatch');
}
