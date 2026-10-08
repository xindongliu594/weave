import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
const [directory] = process.argv.slice(2);
assert.match(directory ?? '', /^docs\/test-evidence\/[a-z0-9-]+$/);
await mkdir(directory);
const documents = ['74bcc49b-db5d-4729-9e5d-c430f10d6d5d', '9ae89b98-2eb2-4302-b79b-ea12ae9a2be7'];
const sources = [], summary = {};
for (const [file, endpoint] of [
  ['spaces.json', '/knowledge/spaces'], ['documents.json', '/knowledge/documents'],
  ...documents.map(id => [id + '-versions.json', '/knowledge/documents/' + id + '/versions']),
  ['projects.json', '/projects'], ['usage.json', '/usage'], ['runs.json', '/runs'],
  ['readiness.json', '/projects/3e101c24-87e6-43ea-80f9-a2c4b0b410f4/cost-readiness'],
]) {
  const response = await fetch('http://127.0.0.1:4310/api' + endpoint, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(directory + '/' + file, bytes, { flag: 'wx' });
  sources.push({ file, endpoint, method: 'GET', status: response.status,
    bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), observedAt: new Date().toISOString() });
  await writeFile(directory + '/sources-progress.json', JSON.stringify(sources, null, 2));
  assert.equal(response.status, 200);
  const value = JSON.parse(bytes);
  if (file === 'documents.json') summary.documents = value.filter(row => documents.includes(row.id));
  if (file === 'readiness.json') summary.readiness = value;
  if (file === 'usage.json') summary.usageCount = value.length;
  if (file === 'runs.json') summary.active = value.filter(row => ['running', 'queued', 'stopping'].includes(row.status)).map(row => ({ id: row.id, status: row.status }));
}
await writeFile(directory + '/sources.json', JSON.stringify(sources, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ directory, ...summary }));
