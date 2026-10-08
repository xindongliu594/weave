import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRunArchive, openRunArchive, readRun } from './trace-store.mjs';

function fixture(work) {
  const root = fs.mkdtempSync(join(tmpdir(), 'trace-append-cursor-'));
  try { return work(root); }
  finally {
    const within = relative(resolve(tmpdir()), resolve(root));
    assert.ok(within.startsWith('trace-append-cursor-') && !within.startsWith('..') && !isAbsolute(within));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
function instrument(work) {
  const read = fs.readFileSync, sync = fs.fsyncSync, counts = { journals: 0, snapshots: 0, syncs: 0 };
  fs.readFileSync = function(file, ...args) {
    if (String(file).endsWith('events.jsonl')) counts.journals++;
    if (String(file).endsWith('snapshot.json')) counts.snapshots++;
    return read.call(this, file, ...args);
  };
  fs.fsyncSync = function(...args) { counts.syncs++; return sync.apply(this, args); };
  syncBuiltinESMExports();
  try { return work(counts); }
  finally { fs.readFileSync = read; fs.fsyncSync = sync; syncBuiltinESMExports(); }
}
function appendExternal(archive, event) {
  fs.appendFileSync(join(archive.dir, 'events.jsonl'), JSON.stringify(event) + '\n');
}
function restoreMtime(file, content) {
  const before = fs.statSync(file);
  fs.writeFileSync(file, content);
  fs.utimesSync(file, before.atime, before.mtime);
}

test('large journal appends stay durable and sequential across independent handles without reparsing every prefix', () => fixture(root => {
  const archive = createRunArchive(root, { mode: 'fixture', title: 'Large journal' });
  appendExternal(archive, { seq: 2, type: 'fixture/large', data: { text: 'x'.repeat(10 * 1024 * 1024) } });
  instrument(counts => {
    const left = openRunArchive(root, archive.id), right = openRunArchive(root, archive.id);
    assert.equal(counts.journals, 1, 'changed external journal is fully verified once');
    for (let index = 0; index < 120; index++) {
      const event = (index % 2 ? left : right).append('fixture/append', { index }, { sourceKey: 'event-' + index });
      assert.equal(event.seq, index + 3);
    }
    assert.equal(counts.journals, 1, 'verified unchanged prefixes do not grow quadratic read work');
    assert.equal(counts.syncs, 120, 'every committed event still fsyncs');
    const full = readRun(root, archive.id);
    assert.equal(counts.journals, 2, 'full export/recovery reads continue strict parsing');
    assert.equal(full.integrity, 'ok'); assert.equal(full.eventCount, 122);
    assert.equal(full.events[1].data.text.length, 10 * 1024 * 1024);
    assert.deepEqual(full.events.slice(2).map(event => event.data.index), Array.from({ length: 120 }, (_, index) => index));
  });
}));

test('external valid appends refresh the shared cursor and source-key deduplication', () => fixture(root => {
  const archive = createRunArchive(root, { title: 'External writer' }), other = openRunArchive(root, archive.id);
  archive.append('fixture/one', {}, { sourceKey: 'own' });
  appendExternal(archive, { seq: 3, type: 'fixture/external', sourceKey: 'foreign', data: {} });
  assert.equal(other.append('fixture/repeat', {}, { sourceKey: 'foreign' }), undefined);
  assert.equal(archive.append('fixture/repeat', {}, { sourceKey: 'own' }), undefined);
  assert.equal(other.append('fixture/next').seq, 4);
  assert.equal(readRun(root, archive.id).eventCount, 4);
}));

test('same-size corruption with restored mtime rejects append before writing, and repaired bytes are revalidated', () => fixture(root => {
  const archive = createRunArchive(root, { title: 'Corruption' }), file = join(archive.dir, 'events.jsonl');
  archive.append('fixture/data', { value: 'abc' });
  const original = fs.readFileSync(file), broken = Buffer.from(original);
  broken[broken.indexOf(Buffer.from('"seq":2')) + 5] = 59;
  restoreMtime(file, broken);
  assert.throws(() => archive.append('fixture/rejected'), /journal is incomplete/);
  assert.deepEqual(fs.readFileSync(file), broken);
  restoreMtime(file, original);
  assert.equal(archive.append('fixture/repaired').seq, 3);
  assert.equal(readRun(root, archive.id).integrity, 'ok');
}));

test('truncation and equal-size file replacement cannot reuse an old valid cursor', () => fixture(root => {
  const archive = createRunArchive(root, { title: 'Replacement' }), file = join(archive.dir, 'events.jsonl');
  archive.append('fixture/data'); const original = fs.readFileSync(file), time = fs.statSync(file).mtime;
  fs.unlinkSync(file); fs.writeFileSync(file, original.subarray(0, original.length - 1)); fs.utimesSync(file, time, time);
  assert.throws(() => archive.append('fixture/rejected'), /journal is incomplete/);
  fs.writeFileSync(file, original); assert.equal(archive.append('fixture/restored').seq, 3);
  const replacement = fs.readFileSync(file);
  fs.unlinkSync(file); fs.writeFileSync(file, replacement); fs.utimesSync(file, time, time);
  instrument(counts => { assert.equal(archive.append('fixture/valid-replacement').seq, 4); assert.equal(counts.journals, 1); });
}));

test('snapshot SHA validation is retained after same-size mutation and restored mtime', () => fixture(root => {
  const archive = createRunArchive(root, { title: 'Original' }), file = join(archive.dir, 'snapshot.json');
  archive.append('fixture/warm'); const original = fs.readFileSync(file);
  const changed = original.toString().replace('Original', 'Modified'); assert.equal(Buffer.byteLength(changed), original.length);
  restoreMtime(file, changed);
  assert.throws(() => archive.append('fixture/rejected'), /journal is incomplete/);
  restoreMtime(file, original); assert.equal(archive.append('fixture/restored').seq, 3);
}));

test('partial write failure invalidates the cursor and cannot hide a damaged tail', () => fixture(root => {
  const archive = createRunArchive(root, { title: 'Write failure' }), write = fs.writeSync;
  fs.writeSync = function(fd, buffer, offset) { write.call(this, fd, buffer, offset, 4); throw Error('injected partial write'); };
  syncBuiltinESMExports();
  try { assert.throws(() => archive.append('fixture/broken'), /injected partial write/); }
  finally { fs.writeSync = write; syncBuiltinESMExports(); }
  assert.equal(readRun(root, archive.id).integrity, 'incomplete');
  assert.throws(() => archive.append('fixture/rejected'), /journal is incomplete/);
}));

test('fsync failure revalidates the actual written event and does not replay its source key', () => fixture(root => {
  const archive = createRunArchive(root, { title: 'Sync failure' }), sync = fs.fsyncSync;
  fs.fsyncSync = () => { throw Error('injected fsync failure'); }; syncBuiltinESMExports();
  try { assert.throws(() => archive.append('fixture/maybe-written', {}, { sourceKey: 'uncertain-write' }), /injected fsync failure/); }
  finally { fs.fsyncSync = sync; syncBuiltinESMExports(); }
  assert.equal(archive.append('fixture/no-replay', {}, { sourceKey: 'uncertain-write' }), undefined);
  assert.equal(archive.append('fixture/next').seq, 3);
  assert.equal(readRun(root, archive.id).eventCount, 3);
}));

test('same ID in different roots and returned-event mutation cannot poison a cursor', () => fixture(root => {
  const id = randomUUID(), left = join(root, 'left'), right = join(root, 'right');
  const a = createRunArchive(left, { title: 'Left' }, { id }), b = createRunArchive(right, { title: 'Right' }, { id });
  const event = a.append('fixture/a', {}, { sourceKey: 'same-key' }); event.seq = 999; event.sourceKey = 'changed';
  assert.equal(a.append('fixture/no-replay', {}, { sourceKey: 'same-key' }), undefined);
  assert.equal(b.append('fixture/b', {}, { sourceKey: 'same-key' }).seq, 2);
  assert.equal(a.append('fixture/next').seq, 3);
  assert.equal(readRun(left, id).events[1].sourceKey, 'same-key');
  assert.equal(readRun(right, id).eventCount, 2);
}));

test('nonfinite source keys retain JSON journal semantics across hot and cold handles', () => fixture(root => {
  const archive = createRunArchive(root, { title: 'Serialized source identities' });
  for (const key of [Infinity, -Infinity]) {
    const first = archive.append('fixture/nonfinite', {}, { sourceKey: key });
    const second = archive.append('fixture/nonfinite', {}, { sourceKey: key });
    assert.equal(second.seq, first.seq + 1, 'serialized null never equals the original nonfinite number');
  }
  const file = join(archive.dir, 'events.jsonl'), bytes = fs.readFileSync(file);
  fs.unlinkSync(file); fs.writeFileSync(file, bytes);
  const cold = openRunArchive(root, archive.id);
  assert.equal(cold.append('fixture/nonfinite', {}, { sourceKey: Infinity }).seq, 6);
  const read = readRun(root, archive.id);
  assert.equal(read.integrity, 'ok');
  assert.ok(read.events.slice(1).every(event => event.sourceKey === null));
  const legacy = createRunArchive(join(root, 'legacy'), { title: 'Legacy JSON exponent' });
  fs.appendFileSync(join(legacy.dir, 'events.jsonl'), '{"seq":2,"type":"fixture/legacy","sourceKey":1e400,"data":{}}\n');
  assert.equal(legacy.append('fixture/no-replay', {}, { sourceKey: Infinity }), undefined);
  assert.equal(legacy.append('fixture/next').seq, 3);
  assert.equal(readRun(join(root, 'legacy'), legacy.id).eventCount, 3);
}));

test('bounded cursor eviction preserves sequence and oversized source-key sets use strict reads', () => fixture(root => {
  const first = createRunArchive(root, { title: 'Old cursor' });
  for (let index = 0; index < 256; index++) createRunArchive(root, { title: 'Eviction ' + index });
  instrument(counts => { assert.equal(first.append('fixture/evicted').seq, 2); assert.equal(counts.journals, 1); });
  const large = createRunArchive(join(root, 'large'), { title: 'Many deduplication keys' });
  const records = Array.from({ length: 4100 }, (_, index) => JSON.stringify({ seq: index + 2, type: 'fixture/key', sourceKey: 'key-' + index, data: {} }) + '\n').join('');
  fs.appendFileSync(join(large.dir, 'events.jsonl'), records);
  instrument(counts => {
    assert.equal(large.append('fixture/duplicate', {}, { sourceKey: 'key-4099' }), undefined);
    assert.equal(large.append('fixture/next').seq, 4102);
    assert.equal(large.append('fixture/again').seq, 4103);
    assert.equal(counts.journals, 3, 'unbounded deduplication state is never retained');
  });
  assert.equal(readRun(join(root, 'large'), large.id).integrity, 'ok');
}));
