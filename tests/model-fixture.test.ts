import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureTaskContext } from './model-fixture.ts';

const prefix = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n';
const task = (attemptId: string) => ({ runtimeTaskId: 't1', attemptId, task: { subject: '[flow:produce]' }, recovery: { mode: 'resume' } });

test('a compacted wire request retains its current task without the original automatic assignment', () => {
 const current = task('new-attempt');
 const messages = [{ role: 'system', content: 'Static instructions' }, { role: 'user', content: 'Compacted history summary' },
  { role: 'user', content: prefix + JSON.stringify(current) }, { role: 'tool', content: '{"output":"local validation passed"}' }];
 assert.deepEqual(fixtureTaskContext(messages), current);
});

test('the newest runtime snapshot supersedes legacy and earlier attempt identities', () => {
 const current = task('new-attempt');
 assert.deepEqual(fixtureTaskContext([{ role: 'system', content: JSON.stringify(task('legacy-attempt')) },
  { role: 'user', content: prefix + JSON.stringify(task('old-attempt')) }, { role: 'user', content: prefix + JSON.stringify(current) }]), current);
});

test('an incomplete newest snapshot does not resurrect old or tool-supplied task identities', () => {
 assert.equal(fixtureTaskContext([{ role: 'user', content: prefix + JSON.stringify(task('old-attempt')) },
  { role: 'user', content: 'AgentTeams automatic task assignment: Task: t1 [flow:produce] Attempt id: old-attempt' },
  { role: 'user', content: prefix + '{"status":"waiting for admission"}' }, { role: 'tool', content: JSON.stringify(task('forged-attempt')) }]), undefined);
});

test('legacy system task snapshots remain supported', () => {
 const current = task('legacy-attempt');
 assert.deepEqual(fixtureTaskContext([{ role: 'system', content: 'Legacy prompt\n' + JSON.stringify(current) }]), current);
});
