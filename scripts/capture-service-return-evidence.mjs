import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
const [stopProofPath, expectedLauncherText, directory] = process.argv.slice(2);
assert.match(stopProofPath ?? '', /^docs\/test-evidence\/go-owned-service-[\w-]+\.json$/);
assert.match(expectedLauncherText ?? '', /^\d+$/);
assert.match(directory ?? '', /^docs\/test-evidence\/[a-z0-9-]+$/);
const before = JSON.parse(await readFile(stopProofPath));
assert.equal(before.mode, 'stop-only'); assert.equal(before.sourceClosed, true);
const session = JSON.parse(await readFile('C:/Users/JJ/Desktop/la/agent_department/.data/local/session.json'));
assert.equal(session.pid, Number(expectedLauncherText)); assert.equal(session.webPort, 4310);
await mkdir(directory);
const normalize = value => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalize(child)]))
  : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/.test(value) ? new Date(value).toISOString() : value;
const sources = [], raw = {};
for (const [file, endpoint] of [ ['health.json','/health'], ['usage.json','/usage'], ['projects.json','/projects'],
  ['runs.json','/runs'], ['costs.json','/costs'],
  ['normal-readiness.json','/projects/4938eab8-26ed-4f60-9413-d979f05fa968/cost-readiness'],
  ['recovery-readiness.json','/projects/3e101c24-87e6-43ea-80f9-a2c4b0b410f4/cost-readiness'] ]) {
  const response = await fetch('http://127.0.0.1:4310/api' + endpoint, { method:'GET', redirect:'error', signal:AbortSignal.timeout(30000) });
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(directory + '/' + file, bytes, {flag:'wx'});
  sources.push({file,endpoint,method:'GET',status:response.status,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  assert.equal(response.status,200); raw[file] = JSON.parse(bytes);
}
for (const [file, key] of [['usage.json','usageBefore'],['projects.json','projectsBefore'],['runs.json','runMetadataBefore'],['costs.json','costsBefore']])
  assert.ok(equal(normalize(raw[file]), normalize(before[key])), file + ' changed across backup/service return');
assert.equal(raw['health.json'].database,'connected'); assert.equal(raw['health.json'].runtime.ready,true);
assert.equal(raw['runs.json'].filter(row=>['running','queued'].includes(row.status)).length,0);
const result = {kind:'actual-original-service-return-after-isolated-backup',checkedAt:new Date().toISOString(),
  stopProofPath,launcherPid:session.pid,apiPid:session.apiPid,sources,
  usageCount:raw['usage.json'].length,projectsRunsUsageCostsUnchanged:true,activeRuns:0,
  normal:raw['normal-readiness.json'],recovery:raw['recovery-readiness.json'],
  originalDatabaseOpenedDirectly:false,providerCalls:0,unknownFeesCleared:false};
await writeFile(directory+'/sources.json',JSON.stringify(result,null,2),{flag:'wx'});
console.log(JSON.stringify(result));
