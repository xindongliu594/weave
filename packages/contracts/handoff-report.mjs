import { createHash } from 'node:crypto';
import { z } from 'zod';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const fail = message => { throw Error('HANDOFF_REPORT: ' + message); };
const reportText = max => z.string().min(1).max(max).refine(value => value.trim().length > 0);
export const employeeReportSchema = z.object({
  summary: reportText(1000),
  sections: z.record(z.string(), reportText(2000)),
  risks: z.array(reportText(1000)).max(10),
}).strict();

export function validateEmployeeReport(report, task) {
  const parsed = employeeReportSchema.safeParse(report);
  if (!parsed.success) {
    // Schema issues can contain private values/unknown keys. Publish only bounded, known paths and codes.
    const issues = parsed.error.issues.slice(0, 5).map(issue => {
      const field = ['summary', 'sections', 'risks'].includes(issue.path[0]) ? '.' + issue.path[0] : '';
      const child = field === '.sections' && issue.path.length > 1 ? '[章节]' : field === '.risks' && Number.isInteger(issue.path[1]) ? `[${issue.path[1]}]` : '';
      return `report${field}${child}: ${issue.code}`;
    });
    fail(issues.join('; ') + '。summary 为1至1000字符，sections 各项为1至2000字符，risks 为最多10项字符串数组；不增加字段。只纠正报告，不重跑已有文件或测试。');
  }
  if (Buffer.byteLength(JSON.stringify(report)) > 20000) fail('report 超过20000字节，请缩短报告，不重跑已有文件或测试');
  if (task?.handoff) {
    const keys = task.handoff.sections.map(section => section.key);
    const missing = keys.filter(key => !Object.hasOwn(report.sections, key));
    if (missing.length) fail(`report.sections 缺少经理要求的章节: ${missing.join(', ')}；只补充对应报告，不重跑已有文件或测试`);
    if (Object.keys(report.sections).some(key => !keys.includes(key))) fail('report.sections 包含经理未要求的章节，请删除额外章节');
  }
  return report;
}
export function handoffContractError(contract) {
  if (contract === undefined) return;
  const sections = contract?.sections;
  if (!object(contract) || Object.keys(contract).some(key => key !== 'sections') || !Array.isArray(sections) || sections.length < 1 || sections.length > 8 ||
    sections.some(section => !object(section) || Object.keys(section).some(key => !['key','requirement'].includes(key)) ||
      !/^[a-z][a-z0-9_]{0,39}$/.test(section.key ?? '') || !text(section.requirement, 1000)) ||
    new Set(sections.map(section => section.key)).size !== sections.length)
    return '交接要求须为 1 至 8 个不重复的章节，每项包含 key 和 requirement';
}
export function handoffContractDigest(task) {
  const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
    ? Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,canonical(value[key])])) : value;
  // Include existing evidence requirements, not just the report headings.
  return createHash('sha256').update(JSON.stringify(canonical({taskId:task.id, handoff:task.handoff,
    acceptanceCriteria:task.acceptanceCriteria ?? [], inputs:task.inputs ?? [], outputs:task.outputs ?? [],
    verify:task.verify ?? [], acceptanceChecks:task.acceptanceChecks ?? []}))).digest('hex');
}
/** Validate employee statements. This does not prove semantic correctness;
 * host file/command receipts and independent review remain separate gates. */
export function createHandoffReport(task, update) {
  if (task.handoff === undefined) return;
  const invalid = handoffContractError(task.handoff); if (invalid) fail(invalid);
  if (typeof update.output !== 'string' || Buffer.byteLength(update.output) > 20000) fail('output 必须是最多 20000 字节的 JSON 报告');
  let report;
  try { report = JSON.parse(update.output); } catch { fail('output 必须填写 JSON 字符串 {summary,sections,risks}'); }
  validateEmployeeReport(report, task);
  const keys = task.handoff.sections.map(section => section.key);
  if (Object.keys(report.sections).length !== keys.length || keys.some(key => !Object.hasOwn(report.sections,key) || !text(report.sections[key],2000)))
    fail('sections 必须逐项填写经理要求的章节，不得增删；每项最多 2000 字符');
  const criteria = task.acceptanceCriteria ?? [], results = update.acceptanceResults;
  if (!Array.isArray(results) || results.length !== criteria.length || results.some((result,index) => !object(result) ||
      result.criterion !== criteria[index] || result.status !== 'passed' || !text(result.evidence,2000)))
    fail('完成时 acceptanceResults 必须逐项覆盖验收标准并提供依据；未通过请提交 failed 和实际问题');
  return { version:1, contractSha256:handoffContractDigest(task), summary:report.summary,
    sections:Object.fromEntries(keys.map(key => [key,report.sections[key]])), risks:[...report.risks],
    acceptanceResults:results.map(result => ({criterion:result.criterion,status:'passed',evidence:result.evidence})) };
}
/** A recovery admission may retain an independently accepted repair contract.
 * Its original approval binding prevents later drafts from reusing that seal. */
export function reportTaskFor(task, record) {
  if (!record.reportContract) return task;
  if (record.reportContract.approvedSha256 !== handoffContractDigest(task) || record.reportContract.task?.id !== task.id)
    fail('返工报告与原批准合同不匹配');
  return record.reportContract.task;
}
export function assertHandoffReport(task, report) {
  if (task.handoff === undefined) return;
  if (!report || report.version !== 1 || report.contractSha256 !== handoffContractDigest(task)) fail('缺少匹配当前合同的封存报告');
  return createHandoffReport(task,{output:JSON.stringify({summary:report.summary,sections:report.sections,risks:report.risks}),acceptanceResults:report.acceptanceResults});
}
export function handoffReportGuidance(task) {
  if (!task?.handoff) return undefined;
  return '经理已在任务 handoff.sections 中定义交接必答项。使用 agent_teams_update_task 的 report 对象提交：{"summary":"简短结论","sections":{"章节key":"对应内容"},"risks":[]}，不要转成字符串、不要加 Markdown 围栏，不同时填写 output。宿主负责序列化为原生 output。逐项回答全部章节，合计最多20000字节；summary最多1000字符，章节各最多2000字符。验收结果另填原生 acceptanceResults（criterion逐字对应acceptanceCriteria、status、evidence）。文件和真实测试由宿主独立核验，不能以报告代替；仅全部满足才completed。未完成用failed并如实说明问题，不伪造通过。仅共享派工所需结论，不复制私有资料或完整日志；下游按原权限读取证据。';
}
