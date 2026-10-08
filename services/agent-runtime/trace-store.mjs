import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const validId = /^[a-f0-9-]{36}$/;
function location(root, id) {
  if (!validId.test(id)) throw new Error('Invalid run id');
  return join(root, id);
}
// Defense in depth for the product archive. This is not a universal secret detector.
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) =>
    [k, /^(authorization|api[_-]?key|credential|password|secret|access[_-]?token)$/i.test(k) ? '[REDACTED]' : redact(v)]));
  if (typeof value === 'string') return value.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]').replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[REDACTED]');
  return value;
}
function durableWrite(file, text, flags) {
  const fd = openSync(file, flags, 0o600);
  try { const bytes = Buffer.from(text); let offset = 0; while (offset < bytes.length) offset += writeSync(fd, bytes, offset); fsyncSync(fd); }
  finally { closeSync(fd); }
}
export function createRunArchive(root, snapshot, options = {}) {
  const id = options.id ?? randomUUID();
  const dir = location(root, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const record = redact({ id, createdAt: new Date().toISOString(), formatVersion: 1, ...snapshot });
  record.id = id;
  const json = JSON.stringify(record);
  durableWrite(join(dir, 'snapshot.json'), json, 'wx');
  durableWrite(join(dir, 'events.jsonl'), '', 'wx');
  const archive = openRunArchive(root, id);
  archive.append('run/created', { snapshotSha256: createHash('sha256').update(json).digest('hex') });
  return archive;
}
export function openRunArchive(root, id) {
  const dir = location(root, id);
  verifiedAppendCursor(root, id);
  return {
    id, dir,
    append(type, data = {}, links = {}) {
      // Approval and runtime handles append to the same journal. A handle's
      // cursor is shared by absolute archive path and only reused while both
      // files retain their verified content metadata. Validation, fsync and
      // cursor advancement remain synchronous across all handles.
      const current = verifiedAppendCursor(root, id);
      if (links.sourceKey && (current.fullRun
        ? current.fullRun.events.some(event => event.sourceKey === links.sourceKey)
        : current.sourceKeys.has(links.sourceKey))) return;
      const event = redact({ ...links, seq: current.seq + 1, at: new Date().toISOString(), type, data });
      const text = JSON.stringify(event) + '\n', key = location(resolve(root), id);
      try { durableWrite(join(dir, 'events.jsonl'), text, 'a'); }
      catch (error) { discardAppendCursor(key); throw error; }
      advanceAppendCursor(key, current, event, Buffer.byteLength(text));
      return event;
    },
  };
}
export function readRun(root, id) {
  const dir = location(root, id);
  if (!existsSync(join(dir, 'snapshot.json'))) return null;
  const rawSnapshot = readFileSync(join(dir, 'snapshot.json'), 'utf8');
  const snapshot = JSON.parse(rawSnapshot);
  const text = readFileSync(join(dir, 'events.jsonl'), 'utf8');
  const lines = text.split('\n');
  let integrity = lines.pop() === '' ? 'ok' : 'incomplete';
  const events = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.seq !== events.length + 1) { integrity = 'incomplete'; break; }
      events.push(event);
    } catch { integrity = 'incomplete'; break; }
  }
  const hash = events.find(e => e.type === 'run/created')?.data.snapshotSha256;
  if (hash && hash !== createHash('sha256').update(rawSnapshot).digest('hex')) integrity = 'incomplete';
  const finished = [...events].reverse().find(e => e.type === 'run/finished');
  return { ...snapshot, snapshot, events, eventCount: events.length, integrity,
    status: integrity !== 'ok' ? 'incomplete' : finished?.data.status ?? 'unfinished' };
}
// Full reads, export and recovery always parse the complete journal. Append
// cursors retain only a verified count, source-key set and file identities;
// external changes force another strict read before writing.
const appendCursors = new Map(), appendCursorLimit = 256, appendKeysLimit = 4096,
  appendEntryByteLimit = 512 * 1024, appendTotalByteLimit = 8 * 1024 * 1024;
let appendCursorBytes = 0;
function discardAppendCursor(key) {
  const entry = appendCursors.get(key);
  if (entry) appendCursorBytes -= entry.bytes;
  appendCursors.delete(key);
}
function retainAppendCursor(key, entry) {
  discardAppendCursor(key);
  if (entry.sourceKeys.size > appendKeysLimit || entry.bytes > appendEntryByteLimit) return;
  appendCursors.set(key, entry); appendCursorBytes += entry.bytes;
  while (appendCursors.size > appendCursorLimit || appendCursorBytes > appendTotalByteLimit)
    discardAppendCursor(appendCursors.keys().next().value);
}
const sourceKeyBytes = key => Buffer.byteLength(JSON.stringify(key)) + 32;
const supportedSourceKey = key => Boolean(key) && ['string','number','boolean'].includes(typeof key) &&
  (typeof key !== 'number' || Number.isFinite(key));
function verifiedAppendCursor(root, id) {
  const key = location(resolve(root), id), before = archiveIdentity(key), cached = appendCursors.get(key);
  if (before && cached && contentIdentityKey(before) === contentIdentityKey(cached.identity)) {
    appendCursors.delete(key); appendCursors.set(key, cached);
    return cached;
  }
  discardAppendCursor(key);
  const run = readRun(root, id);
  if (!run) throw new Error('Run not found');
  if (run.integrity !== 'ok') throw new Error('Run journal is incomplete; repair is required before appending');
  const after = archiveIdentity(key);
  if (!before || !after || contentIdentityKey(before) !== contentIdentityKey(after))
    throw new Error('Run journal changed during validation; inspect it before appending');
  const sourceKeys = new Set(), entry = { seq: run.events.length, sourceKeys, identity: after, bytes: 1024 };
  for (const event of run.events) {
    // JSON written by this module normalizes nonfinite numbers to null. A
    // foreign legacy literal such as 1e400 can nevertheless parse as Infinity;
    // preserve strict equality semantics by using the full parsed record.
    if (typeof event.sourceKey === 'number' && !Number.isFinite(event.sourceKey))
      return { ...entry, fullRun: run };
    if (supportedSourceKey(event.sourceKey) && !sourceKeys.has(event.sourceKey)) {
      sourceKeys.add(event.sourceKey); entry.bytes += sourceKeyBytes(event.sourceKey);
      if (sourceKeys.size > appendKeysLimit || entry.bytes > appendEntryByteLimit)
        return { ...entry, fullRun: run };
    }
  }
  retainAppendCursor(key, entry);
  return entry;
}
function advanceAppendCursor(key, entry, event, writtenBytes) {
  // A failed/short write or replacement cannot establish the next verified
  // cursor. Full validation on the next append still catches corruption.
  const after = archiveIdentity(key), before = entry.identity;
  const journalFixedFields = fields => JSON.stringify(fields.filter(([name]) =>
    !['size','blocks','atimeMs','atimeNs','mtimeMs','mtimeNs','ctimeMs','ctimeNs'].includes(name)));
  if (!after || contentIdentityKey([before[0]]) !== contentIdentityKey([after[0]]) ||
    journalFixedFields(before[1]) !== journalFixedFields(after[1]) ||
    BigInt(after[1].find(([name]) => name === 'size')[1]) !==
      BigInt(before[1].find(([name]) => name === 'size')[1]) + BigInt(writtenBytes)) {
    discardAppendCursor(key); return;
  }
  if (entry.fullRun) { discardAppendCursor(key); return; }
  // Drop the old accounting before changing the shared entry in place.
  discardAppendCursor(key);
  entry.seq = event.seq; entry.identity = after;
  if (supportedSourceKey(event.sourceKey) && !entry.sourceKeys.has(event.sourceKey)) {
    entry.sourceKeys.add(event.sourceKey); entry.bytes += sourceKeyBytes(event.sourceKey);
  }
  retainAppendCursor(key, entry);
}
// List summaries retain only their separate bounded projection.
const summaryCache = new Map(), summaryCacheLimit = 256, summaryByteLimit = 64 * 1024;
function archiveIdentity(dir) {
  try {
    return ['snapshot.json', 'events.jsonl'].map(name => {
      const stat = statSync(join(dir, name), { bigint: true });
      return Object.keys(stat).sort().map(key => [key, String(stat[key])]);
    });
  } catch { return null; }
}
const identityKey = identity => JSON.stringify(identity);
// Reading may update access time. All other before/after fields must remain
// identical before retaining the post-read identity, including nanosecond ctime.
const contentIdentityKey = identity => JSON.stringify(identity?.map(fields => fields.filter(([key]) => key !== 'atimeMs' && key !== 'atimeNs')));
function runSummary(root, id) {
  const key = location(resolve(root), id), before = archiveIdentity(key), cached = summaryCache.get(key);
  if (before && cached?.identity === identityKey(before)) {
    summaryCache.delete(key); summaryCache.set(key, cached);
    return structuredClone(cached.summary);
  }
  summaryCache.delete(key);
  let summary, cacheable = true;
  try {
    const run = readRun(root, id);
    if (!run) return null;
    summary = { id, createdAt: run.createdAt, title: run.title, mode: run.mode, status: run.status, integrity: run.integrity, eventCount: run.eventCount };
  } catch { cacheable = false; summary = { id, title: '无法读取的运行记录', mode: 'unknown', status: 'incomplete', integrity: 'incomplete', eventCount: 0, createdAt: '' }; }
  const after = archiveIdentity(key);
  if (cacheable && before && after && contentIdentityKey(before) === contentIdentityKey(after) && Buffer.byteLength(JSON.stringify(summary)) <= summaryByteLimit) {
    summaryCache.set(key, { identity: identityKey(after), summary: structuredClone(summary) });
    while (summaryCache.size > summaryCacheLimit) summaryCache.delete(summaryCache.keys().next().value);
  }
  return summary;
}
export function listRuns(root) {
  if (!existsSync(root)) return [];
  const ids = readdirSync(root).filter(id => validId.test(id)), rootKey = resolve(root), present = new Set(ids.map(id => location(rootKey, id)));
  for (const key of summaryCache.keys()) if (key.startsWith(rootKey + (process.platform === 'win32' ? '\\' : '/')) && !present.has(key)) summaryCache.delete(key);
  return ids.map(id => runSummary(root, id)).filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
