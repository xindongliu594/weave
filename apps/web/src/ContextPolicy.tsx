import type { Policy } from '../../../packages/contracts/index.ts';

export function ContextPolicy({ policy, onChange }: { policy: Policy; onChange?: (policy: Policy) => void }) {
  const mode = policy.contextManagement ?? 'summary';
  const labels = { summary: '自动摘要与工具结果缩减', prune: '仅缩减工具结果', off: '仅限制请求大小' };
  return <label className="field lower-small">员工上下文管理
    {onChange ? <select value={mode} onChange={e => onChange({ ...policy, contextManagement: e.target.value as Policy['contextManagement'] })}>
      {Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select> : <strong>{labels[mode]}</strong>}
    <small>自动摘要需要填写模型的上下文容量。摘要调用计入原有费用和调用次数上限；原始记录及任务要求保留。</small>
  </label>;
}
