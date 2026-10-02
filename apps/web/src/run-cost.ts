export function runCostSummary(snapshot: any, events: any[]) {
  const current = events.filter(event => event.type === 'billing/usage').reduce((total, event) => {
    const cost = Number(event.data?.cost);
    return total + (Number.isFinite(cost) && cost >= 0 ? cost : 0);
  }, 0);
  const limit = Number(snapshot.policy?.maxBudget), executionBudget = Number(snapshot.executionBudget);
  const inherited = snapshot.budgetVersion === 1 && Number.isFinite(limit) && limit > 0 && snapshot.executionBudget != null && Number.isFinite(executionBudget)
    ? Math.max(0, limit - executionBudget) : undefined;
  const total = inherited === undefined ? undefined : inherited + current;
  return { current, inherited, total, limit: Number.isFinite(limit) && limit > 0 ? limit : undefined };
}
