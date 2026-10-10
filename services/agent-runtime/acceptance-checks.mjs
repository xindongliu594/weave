import { createHash } from 'node:crypto';
import { nodeTestCounts } from './run-evidence.mjs';

export function acceptanceRuleHash(task, check) {
  return createHash('sha256').update(JSON.stringify([task.id, check.criterionIndex,
    task.acceptanceCriteria?.[check.criterionIndex], check.command, check.expectedExitCode ?? 0,
    check.expectedOutput ?? null, check.minimumTests ?? null])).digest('hex');
}

/** Compute from the executor result, before any model report or redaction. */
export function observeAcceptanceChecks(task, command, result) {
  return (task.acceptanceChecks ?? []).filter(check => check.command === command).map(check => {
    let status = 'passed', reason = '';
    if (!Number.isInteger(result?.exitCode)) [status, reason] = ['unverified', '执行退出码缺失'];
    else if (result.exitCode !== (check.expectedExitCode ?? 0)) [status, reason] = ['failed', '实际退出码与预期不符'];
    if (check.expectedOutput !== undefined || check.minimumTests !== undefined) {
      if (typeof result?.output !== 'string' || result.outputTruncated === true || result.truncated === true)
        [status, reason] = ['unverified', '执行输出缺失或被截断'];
      else if (check.expectedOutput !== undefined && result.output.replace(/\r\n/g, '\n') !== check.expectedOutput.replace(/\r\n/g, '\n'))
        [status, reason] = ['failed', '实际完整输出与预期不符'];
      else if (check.minimumTests !== undefined) {
        const counts = nodeTestCounts(command, result.output);
        if (counts.status !== 'available') [status, reason] = ['unverified', '完整 Node 测试统计无法核对'];
        else if (counts.tests < check.minimumTests || counts.pass !== counts.tests || counts.fail || counts.cancelled || counts.skipped || counts.todo)
          [status, reason] = ['failed', '有效测试数量不足，或存在失败、取消、跳过或待办'];
      }
    }
    return { criterionIndex: check.criterionIndex, ruleSha256: acceptanceRuleHash(task, check), status, reason };
  });
}

/** Never infer new mappings for historical plans or accept model-supplied verdicts. */
export function collectAcceptanceChecks(task, commands, revision) {
  return (task.acceptanceChecks ?? []).map(check => {
    const ruleSha256 = acceptanceRuleHash(task, check), observation = commands.findLast(item => item.command === check.command);
    const results = observation?.acceptanceChecks?.filter(item => item.criterionIndex === check.criterionIndex && item.ruleSha256 === ruleSha256) ?? [];
    const result = !observation ? { status: 'unverified', reason: '尚无真实执行记录' } :
      observation.workspaceRevision !== revision ? { status: 'unverified', reason: '执行后文件版本已变化' } :
      observation.exitCode !== (check.expectedExitCode ?? 0) ? { status: 'failed', reason: '实际退出码与预期不符' } :
      results.length !== 1 ? { status: 'unverified', reason: '宿主逐项检查记录缺失或不匹配' } : results[0];
    return { ...result, criterionIndex: check.criterionIndex, ruleSha256, command: check.command };
  });
}

export function assertAcceptanceChecks(task, commands, revision) {
  const checks = collectAcceptanceChecks(task, commands, revision);
  const rejected = checks.find(check => check.status !== 'passed');
  if (rejected) throw Error(`ACCEPTANCE_CHECK_FAILED: 验收项 ${rejected.criterionIndex + 1}：${rejected.reason}`);
  return checks;
}
