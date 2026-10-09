import test from 'node:test';
import assert from 'node:assert/strict';
import { runExtrasErrorReducer, type RunExtrasErrors } from '../apps/web/src/RunExtras.tsx';

const initial = (): RunExtrasErrors => ({ id: 'recovered-run', operation: '', refresh: '' });
test('a temporary missing recovered run clears after a successful poll', () => {
 const failed = runExtrasErrorReducer(initial(), { id: 'recovered-run', type: 'refresh-failed', message: '运行不存在' });
 assert.equal(failed.refresh, '运行不存在');
 const healthy = runExtrasErrorReducer(failed, { id: 'recovered-run', type: 'refresh-succeeded' });
 assert.deepEqual(healthy, initial());
});

test('successful background refresh cannot erase an approval or recovery operation failure', () => {
 const failed = runExtrasErrorReducer(initial(), { id: 'recovered-run', type: 'operation', message: '审批未成功，原请求结果仍需核对' });
 const polling = runExtrasErrorReducer(failed, { id: 'recovered-run', type: 'refresh-failed', message: '运行不存在' });
 const healthy = runExtrasErrorReducer(polling, { id: 'recovered-run', type: 'refresh-succeeded' });
 assert.equal(healthy.operation, failed.operation); assert.equal(healthy.refresh, '');
});

test('a new run clears old errors and ignores delayed old-run failures or refresh success', () => {
 const failed = runExtrasErrorReducer(initial(), { id: 'recovered-run', type: 'operation', message: 'old operation failure' });
 const changed = runExtrasErrorReducer(failed, { id: 'next-run', type: 'reset' });
 assert.deepEqual(changed, { id: 'next-run', operation: '', refresh: '' });
 const newFailure = runExtrasErrorReducer(changed, { id: 'next-run', type: 'refresh-failed', message: 'new refresh failure' });
 for(const type of ['operation', 'refresh-failed', 'refresh-succeeded'] as const)
  assert.deepEqual(runExtrasErrorReducer(newFailure, { id: 'recovered-run', type, message: 'late result' }), newFailure);
});
