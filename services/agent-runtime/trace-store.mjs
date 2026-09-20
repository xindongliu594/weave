import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
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
  const existing = readRun(root, id);
  if (!existing) throw new Error('Run not found');
  if (existing.integrity !== 'ok') throw new Error('Run journal is incomplete; repair is required before appending');
  let seq = existing.events.length;
  const keys = new Set(existing.events.map(e => e.sourceKey).filter(Boolean));
  return {
    id, dir,
    append(type, data = {}, links = {}) {
      if (links.sourceKey && keys.has(links.sourceKey)) return;
      const event = redact({ ...links, seq: seq + 1, at: new Date().toISOString(), type, data });
      durableWrite(join(dir, 'events.jsonl'), JSON.stringify(event) + '\n', 'a');
      seq++;
      if (links.sourceKey) keys.add(links.sourceKey);
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
export function listRuns(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root).filter(id => validId.test(id)).map(id => {
    try {
      const run = readRun(root, id);
      if (!run) return null;
      return { id, createdAt: run.createdAt, title: run.title, mode: run.mode, status: run.status, integrity: run.integrity, eventCount: run.eventCount };
    } catch { return { id, title: '无法读取的运行记录', mode: 'unknown', status: 'incomplete', integrity: 'incomplete', eventCount: 0, createdAt: '' }; }
  }).filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
