export type GoalContract = { format: 'approved-goal-v1'; sha256: string };
export function createGoalContract(snapshot: any): GoalContract;
export function assertGoalContract(snapshot: any, expected?: GoalContract): boolean;
export function goalTaskContext(snapshot: any, taskId?: string): any;
