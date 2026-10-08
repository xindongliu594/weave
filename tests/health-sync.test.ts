import test from 'node:test';
import assert from 'node:assert/strict';
import { createHealthSync, connectionText, HEALTH_INTERVAL_MS, type Health } from '../apps/web/src/health-sync.ts';
import { ApiError } from '../apps/web/src/api.ts';
import { createUsageSync, COSTS_CHANGED_EVENT } from '../apps/web/src/usage-sync.ts';

const health: Health = { database: 'connected', runtime: { ready: true, reason: 'local fixture ready' }, version: '0.2.0',
  workspace: { kind: 'local', workspacesPath: 'local-fixture-workspace' } };
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
function timers(interval = HEALTH_INTERVAL_MS) {
  let serial = 0;
  const queued = new Map<number, () => void>();
  return { queued, schedule: (fn: () => void, delay: number) => {
    assert.equal(delay, interval); const id = ++serial; queued.set(id, fn); return id;
  }, cancel: (id: unknown) => { queued.delete(id as number); }, tick: () => {
    const entry = queued.entries().next().value;
    assert.ok(entry, 'one poll must be scheduled'); queued.delete(entry[0]); entry[1]();
  } };
}

test('initial health reads share one in-flight request and publish connection independently', async () => {
  let loads = 0, finish!: (value: Health) => void;
  const clock = timers(), statuses: string[] = [];
  const sync = createHealthSync(() => { loads++; return new Promise(resolve => { finish = resolve; }); }, { ...clock, now: () => 'checked-1' });
  const stop = sync.subscribe(() => statuses.push(sync.getSnapshot().status));
  assert.equal(sync.getSnapshot().status, 'connecting'); assert.equal(sync.getSnapshot().health, null);
  const first = sync.refresh(), second = sync.refresh();
  assert.equal(first, second); assert.equal(clock.queued.size, 0);
  await flush(); assert.equal(loads, 1); assert.equal(sync.getSnapshot().checking, true);
  finish(health); await first;
  assert.equal(sync.getSnapshot().status, 'connected'); assert.equal(sync.getSnapshot().health, health);
  assert.equal(sync.getSnapshot().checkedAt, 'checked-1'); assert.equal(sync.getSnapshot().connectedAt, 'checked-1');
  assert.equal(sync.getSnapshot().checking, false); assert.equal(clock.queued.size, 1);
  assert.ok(statuses.includes('connecting') && statuses.includes('connected'));
  stop(); assert.equal(clock.queued.size, 0);
});

test('transport failure and reconnection retain confirmed workspace configuration until new health succeeds', async () => {
  let loads = 0, finish!: (value: Health) => void;
  const sync = createHealthSync(async () => {
    loads++;
    if (loads === 2) throw new Error('无法连接本机工作台服务。');
    if (loads === 3) return new Promise<Health>(resolve => { finish = resolve; });
    return health;
  }, { now: () => 'checked-' + loads });
  await sync.refresh(); const previous = sync.getSnapshot();
  await assert.rejects(sync.refresh(), /无法连接本机/);
  assert.equal(sync.getSnapshot().status, 'disconnected');
  assert.equal(connectionText(sync.getSnapshot().status), '后端服务已断开');
  assert.equal(sync.getSnapshot().health, previous.health);
  assert.equal(sync.getSnapshot().health?.workspace, previous.health?.workspace);
  assert.equal(sync.getSnapshot().health?.demo, undefined);
  assert.equal(sync.getSnapshot().connectedAt, previous.connectedAt);
  assert.equal(sync.getSnapshot().checkedAt, 'checked-2');
  const retry = sync.refresh();
  assert.equal(sync.getSnapshot().status, 'reconnecting');
  assert.match(connectionText(sync.getSnapshot().status), /重新连接/);
  assert.equal(sync.getSnapshot().health, health);
  await flush();
  const recovered = { ...health, runtime: { ready: false, reason: 'fixture executor unavailable' } };
  finish(recovered); await retry;
  assert.equal(sync.getSnapshot().status, 'connected'); assert.equal(sync.getSnapshot().health, recovered);
  assert.equal(sync.getSnapshot().error, ''); assert.equal(sync.getSnapshot().connectedAt, 'checked-3');
});

test('first failed connection becomes disconnected and retries show reconnecting before any health exists', async () => {
  const sync = createHealthSync(async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(sync.refresh());
  assert.equal(sync.getSnapshot().status, 'disconnected'); assert.equal(sync.getSnapshot().health, null);
  const retry = sync.refresh();
  assert.equal(sync.getSnapshot().status, 'reconnecting');
  await assert.rejects(retry); assert.equal(sync.getSnapshot().status, 'disconnected');
});

test('received HTTP failures are distinct from disconnection but synthetic GET timeouts are not', async () => {
  for (const error of [new ApiError('requires sign in', 401), new ApiError('business validation', 422), new ApiError('server error', 503), new ApiError('received timeout response', 408)]) {
    let fail = false;
    const sync = createHealthSync(async () => { if (fail) throw error; return health; });
    await sync.refresh(); fail = true; await assert.rejects(sync.refresh());
    assert.equal(sync.getSnapshot().status, 'reachable');
    assert.match(connectionText(sync.getSnapshot().status), /已响应/);
    assert.equal(sync.getSnapshot().health, health);
  }
  const sync = createHealthSync(async () => { throw new ApiError('read timed out', 408, 'READ_TIMEOUT'); });
  await assert.rejects(sync.refresh()); assert.equal(sync.getSnapshot().status, 'disconnected');
});

test('hidden pages have no periodic checks and becoming visible or focused shares a slow request', async () => {
  const activity = new EventTarget(), visibility = new EventTarget(), clock = timers();
  let visible = false, loads = 0, finish!: (value: Health) => void;
  const sync = createHealthSync(() => { loads++; return new Promise(resolve => { finish = resolve; }); }, { ...clock, activity, visibility, visible: () => visible });
  const stop = sync.subscribe(() => {});
  assert.equal(clock.queued.size, 0);
  activity.dispatchEvent(new Event('focus')); visibility.dispatchEvent(new Event('visibilitychange')); await flush();
  assert.equal(loads, 0);
  visible = true; visibility.dispatchEvent(new Event('visibilitychange')); activity.dispatchEvent(new Event('focus')); await flush();
  assert.equal(loads, 1); assert.equal(clock.queued.size, 0);
  visible = false; visibility.dispatchEvent(new Event('visibilitychange')); finish(health); await flush();
  assert.equal(clock.queued.size, 0, 'an in-flight result cannot restart a hidden-page timer');
  visible = true; visibility.dispatchEvent(new Event('visibilitychange')); await flush();
  assert.equal(loads, 2); finish(health); await flush(); assert.equal(clock.queued.size, 1);
  clock.tick(); await flush();
  activity.dispatchEvent(new Event('focus')); await flush(); assert.equal(loads, 3);
  stop(); finish(health); await flush(); assert.equal(clock.queued.size, 0);
  activity.dispatchEvent(new Event('focus')); visibility.dispatchEvent(new Event('visibilitychange')); await flush(); assert.equal(loads, 3);
});

test('visible polling detects a dropped service and later restores connection without a page reset', async () => {
  const clock = timers(); let available = true, loads = 0;
  const sync = createHealthSync(async () => { loads++; if (!available) throw new TypeError('Failed to fetch'); return health; }, clock);
  const stop = sync.subscribe(() => {});
  await sync.refresh(); assert.equal(loads, 1); assert.equal(clock.queued.size, 1);
  available = false; clock.tick(); await flush();
  assert.equal(loads, 2); assert.equal(sync.getSnapshot().status, 'disconnected');
  assert.equal(sync.getSnapshot().health, health); assert.equal(clock.queued.size, 1);
  available = true; clock.tick();
  assert.equal(sync.getSnapshot().status, 'reconnecting'); await flush();
  assert.equal(loads, 3); assert.equal(sync.getSnapshot().status, 'connected');
  assert.equal(sync.getSnapshot().health?.workspace?.kind, 'local'); stop();
});

test('manual refresh cancels an old poll and only the last subscriber removes wake listeners', async () => {
  const activity = new EventTarget(), clock = timers(); let loads = 0;
  const sync = createHealthSync(async () => { loads++; return health; }, { ...clock, activity });
  const stopFirst = sync.subscribe(() => {}), stopSecond = sync.subscribe(() => {});
  assert.equal(clock.queued.size, 1); await sync.refresh(); assert.equal(clock.queued.size, 1);
  stopFirst(); activity.dispatchEvent(new Event('focus')); await flush(); assert.equal(loads, 2);
  stopSecond(); assert.equal(clock.queued.size, 0);
  activity.dispatchEvent(new Event('focus')); await flush(); assert.equal(loads, 2);
  await sync.refresh(); assert.equal(loads, 3); assert.equal(clock.queued.size, 0, 'explicit reads without subscribers do not create background polling');
});

test('health and usage refreshes deduplicate independently and cost notifications do not add health calls', async () => {
  const activity = new EventTarget(), healthClock = timers(), usageClock = timers(15000);
  let healthLoads = 0, usageLoads = 0;
  const connection = createHealthSync(async () => { healthLoads++; return health; }, { ...healthClock, activity });
  const usage = createUsageSync(async () => { usageLoads++; return []; }, { ...usageClock, activity });
  const stopHealth = connection.subscribe(() => {}), stopUsage = usage.subscribe(() => {});
  await Promise.all([connection.refresh(), connection.refresh(), usage.refresh(), usage.refresh()]);
  assert.equal(healthLoads, 1); assert.equal(usageLoads, 1);
  activity.dispatchEvent(new Event(COSTS_CHANGED_EVENT)); await flush();
  assert.equal(healthLoads, 1); assert.equal(usageLoads, 2);
  activity.dispatchEvent(new Event('focus')); activity.dispatchEvent(new Event('focus')); await flush();
  assert.equal(healthLoads, 2); assert.equal(usageLoads, 3);
  assert.equal(healthClock.queued.size, 1); assert.equal(usageClock.queued.size, 1);
  stopHealth(); stopUsage(); assert.equal(healthClock.queued.size, 0); assert.equal(usageClock.queued.size, 0);
});
