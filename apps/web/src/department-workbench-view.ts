export type WorkbenchRun = {
  id: string; status: string; projectVersion: number; createdAt: string; finishedAt: string | null;
  error?: string | null; pendingApprovalCount?: number;
};
export type WorkbenchItem = {
  id: string; requirement: string; version: number; status: string; createdAt: string;
  bucket: 'backlog' | 'running' | 'attention' | 'completed';
  latestRun: WorkbenchRun | null; completedRun: WorkbenchRun | null;
};
export type DepartmentWorkbenchData = {
  departmentId: string;
  summary: { total: number; backlog: number; running: number; attention: number; completed: number; pendingApprovals: number; recordedCost: number };
  items: WorkbenchItem[]; limit: number; offset: number; hasMore: boolean; refreshedAt: string;
};

export function workbenchItemLabel(item: WorkbenchItem) {
  if ((item.latestRun?.pendingApprovalCount ?? 0) > 0) return `${item.latestRun!.pendingApprovalCount} 项工具操作待审批`;
  if (item.status === 'COMPLETED' && item.latestRun?.status !== 'completed') return '完成状态需要核对';
  const labels: Record<string, string> = {
    DRAFT: '待确认方案', QUEUED: '排队中', RUNNING: '正在执行', COMPLETED: '执行已完成',
    FAILED: '执行失败 · 查看原因', INTERRUPTED: '执行中断 · 检查恢复条件', CANCELLED: '已停止 · 由你决定后续',
  };
  return labels[item.status] ?? '状态需要确认';
}

export function groupWorkbenchItems(items: WorkbenchItem[]) {
  return {
    attention: items.filter(item => item.bucket === 'attention'),
    running: items.filter(item => item.bucket === 'running'),
    backlog: items.filter(item => item.bucket === 'backlog'),
    // An old completed run remains a historical record when a later run fails.
    // A project's COMPLETED label alone is insufficient evidence for this list.
    completed: items.filter(item => item.completedRun?.status === 'completed')
      .sort((a, b) => (b.completedRun!.finishedAt ?? b.completedRun!.createdAt).localeCompare(a.completedRun!.finishedAt ?? a.completedRun!.createdAt)),
  };
}
