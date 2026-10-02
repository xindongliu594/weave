import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
// Narrow host-only seam into the pinned AgentTeams persistence layer. Use its
// queue and atomic writer; never mutate a running team or expose this to tools.
const stateApi = import(pathToFileURL(join(dirname(require.resolve('@nanmicoder/dsh-agent-teams/package.json')), 'lib/state.js')).href);

export async function restoreStagedCheckpoints(stateRoot, teamId, mapping, recovery) {
  const { withTeamLock, readTeam, writeTeam } = await stateApi;
  return withTeamLock(`team:${stateRoot}:${teamId}`, async () => {
    const team = await readTeam(stateRoot, teamId);
    if (!team || team.phase !== 'staged' || team.tasks.some(task => task.status !== 'pending') || team.members.some(member => member.id)) throw Error('CHECKPOINT_RESTORE_NOT_STAGED');
    const ids = new Map(mapping.map(item => [item.seed_id, item.task_id]));
    const completed = new Map(recovery.completed.map(task => [task.taskId, task]));
    for (const item of mapping) {
      const task = team.tasks.find(task => task.id === item.task_id), prior = completed.get(item.seed_id);
      if (!task) throw Error('CHECKPOINT_TASK_MISSING: ' + item.seed_id);
      task.profileSeedId = item.seed_id;
      if (!prior) continue;
      if (!prior.attemptId) throw Error('CHECKPOINT_ATTEMPT_MISSING: ' + item.seed_id);
      for (const dep of task.dependencies) if (![...completed.keys()].some(id => ids.get(id) === dep)) throw Error('CHECKPOINT_DEPENDENCY_INCOMPLETE');
      for (const key of ['attemptId','attempt','round','output','verdict','findings','changedPaths','acceptanceResults','commandsRun','reviewedAttempt']) if (prior[key] !== undefined) task[key] = structuredClone(prior[key]);
      task.attempt ??= 1;
      task.status = 'completed'; task.updatedAt = Date.now();
    }
    await writeTeam(stateRoot, team);
    return team;
  });
}
