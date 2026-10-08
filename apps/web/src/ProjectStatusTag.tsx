type ProjectState = { status: string; validation?: { valid: boolean } };

/** Validation describes permission for a future execution, not whether the
 * saved project already completed, failed or is currently running. */
export function projectStatusLabel(project: ProjectState): { label: string; tone: string } {
  const lifecycle: Record<string, string> = { QUEUED: '等待执行', RUNNING: '执行中', COMPLETED: '已完成',
    FAILED: '执行失败', CANCELLED: '已取消', INTERRUPTED: '执行中断' };
  if (lifecycle[project.status]) return { label: lifecycle[project.status], tone: project.status === 'COMPLETED' ? 'green' : 'amber' };
  if (project.status === 'DRAFT') return project.validation?.valid === true
    ? { label: '基础校验通过', tone: 'green' } : { label: '待完善方案', tone: 'amber' };
  return { label: project.status || '状态未记录', tone: 'amber' };
}

export function ProjectStatusTag({ project }: { project: ProjectState }) {
  const { label, tone } = projectStatusLabel(project);
  return <span className={'tag ' + tone}>{label}</span>;
}
