export const taskKinds: readonly string[];
export function isArtifactPath(value: unknown): boolean;
export function taskContractErrors(tasks: any[], agents?: any[], checkpoints?: any[], options?: { allowHistoricalPinnedProducerInputs?: boolean }): string[];
