import { z } from 'zod';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { employeeReportSchema, validateEmployeeReport } from '../../packages/contracts/handoff-report.mjs';

// Adapt only the employee-facing schema. Native task storage and gates keep output:string.
export function employeeHandoffDefinition(definition) {
  const report = z.toJSONSchema(employeeReportSchema, { unrepresentable: 'any' });
  delete report.$schema;
  return { ...definition, parameters: { ...definition.parameters,
    properties: { ...definition.parameters.properties, report: { ...report,
      description: '经理交接报告对象 {summary, sections, risks}。直接填写对象，不要转义为字符串；不要同时填写 output。旧任务或失败说明仍可使用 output 文本。' } } } };
}

export function nativeHandoffArguments(args, task) {
  if (!Object.hasOwn(args, 'report')) return args;
  if (Object.hasOwn(args, 'output')) throw new HarnessError('HANDOFF_REPORT_FIELDS: report 与 output 只能填写一个；请直接提交 report 对象。', 'INVALID_ARGS');
  try {
    validateEmployeeReport(args.report, args.status === 'completed' ? task : undefined);
  } catch (error) {
    throw new HarnessError(error.message.replace(/^HANDOFF_REPORT:/, 'HANDOFF_REPORT_FIELDS:'), 'INVALID_ARGS');
  }
  const { report, ...native } = args;
  return { ...native, output: JSON.stringify(report) };
}
