import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { childOf, newDirectory, inventory, content, copyTree, assertClosed, worker, networkGuardCode, executionEnv } from '../scripts/verify-mvp-full-offline-backup.mjs';

const root = resolve(import.meta.dirname, '..');
const data = join(root, '.data');
const group = join(data, 'full-offline-backup-safety-tests', randomUUID());
await mkdir(group, { recursive: true });
// Local synthetic files only. Leave each fresh directory for review; never delete
// or touch source production data, stored real credentials or employee artifacts.

test('destinations reject the workspace root, parents, siblings and source data', () => {
  for (const target of [data, root, `${data}-escape`, 'C:/Users/JJ/Desktop/la/agent_department/.data/local'])
    assert.throws(() => childOf(data, target), /must stay/);
  assert.doesNotThrow(() => childOf(data, join(group, 'valid')));
});

test('new destination refuses overwrites, preserving existing files', async () => {
  const existing = join(group, 'existing'); await mkdir(existing); await writeFile(join(existing, 'keep.txt'), 'unchanged');
  await assert.rejects(newDirectory(existing), /refusing overwrite/);
  assert.equal(await readFile(join(existing, 'keep.txt'), 'utf8'), 'unchanged');
});

test('launcher and database startup markers refuse offline copying', async () => {
  const launcher = join(group, 'launcher-active'); await mkdir(launcher); await writeFile(join(launcher, 'launcher.lock'), 'fixture-only');
  assert.throws(() => assertClosed(launcher), /launcher lock/);
  const database = join(group, 'database-active'); await mkdir(join(database, 'database'), { recursive: true });
  await writeFile(join(database, 'database', 'postmaster.pid'), 'fixture-only');
  assert.throws(() => assertClosed(database), /process marker/);
});

test('CLI requires explicit shutdown confirmation before accessing a real source', () => {
  const child = spawnSync(process.execPath, ['scripts/verify-mvp-full-offline-backup.mjs'], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 1); assert.match(child.stderr, /shutdown confirmation is required/);
});

test('transparent copying excludes startup state, preserves business history and leaves credentials opaque', async () => {
  const source = join(group, 'synthetic-source'), target = join(group, 'synthetic-target');
  await mkdir(join(source, 'credentials'), { recursive: true });
  await mkdir(join(source, 'runs', 'fixture'), { recursive: true });
  await writeFile(join(source, 'credentials', 'credential.master'), 'SYNTHETIC_FIXTURE_ONLY');
  await writeFile(join(source, 'device.credential'), 'SYNTHETIC_FIXTURE_ONLY');
  await writeFile(join(source, 'runs', 'fixture', 'events.jsonl'), '{"type":"billing/unconfirmed","status":"uncertain"}\n');
  await writeFile(join(source, 'session.json'), '{"fixture":true}');
  const original = await inventory(source, true);
  const hidden = original.rows.filter(row => row.opaque);
  assert.equal(hidden.length, 2); assert.ok(hidden.every(row => !Object.hasOwn(row, 'sha256')));
  await copyTree(source, target);
  assert.deepEqual(content(await inventory(target, true)), content(original));
  assert.equal(existsSync(join(target, 'session.json')), false);
  assert.ok((await inventory(target, true)).rows.some(row => row.path === 'runs/fixture/events.jsonl' && row.sha256));
});

test('junctions cannot escape the snapshot, including during the copy filter', async () => {
  const source = join(group, 'link-source'), outside = join(group, 'link-outside');
  await mkdir(source); await mkdir(outside); await writeFile(join(outside, 'keep.txt'), 'outside-fixture');
  await symlink(outside, join(source, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(inventory(source, true), /links\/junctions/);
  await assert.rejects(copyTree(source, join(group, 'link-target')), /links\/junctions/);
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'outside-fixture');
});

test('isolated worker rejects an active model reservation without any business mutation', async () => {
  const directory = join(group, 'pending-restore'); await mkdir(directory);
  const db = await PGlite.create({ dataDir: join(directory, 'database') });
  await db.exec("CREATE TABLE model_reservations(id text,status text);INSERT INTO model_reservations VALUES ('local-fixture','pending');");
  await db.close();
  await assert.rejects(worker(directory, ''), /active model_reservations/);
  const reopened = await PGlite.create({ dataDir: join(directory, 'database') });
  assert.deepEqual((await reopened.query('SELECT id,status FROM model_reservations')).rows, [{ id: 'local-fixture', status: 'pending' }]);
  await reopened.close();
});

test('validation network guard refuses external and loopback model calls before dispatch', async () => {
  const preload = join(group, 'offline-network-guard.cjs');
  await writeFile(preload, networkGuardCode());
  childOf(data, preload);
  const child = spawnSync(process.execPath, ['--require', preload, '--input-type=module', '-e', `
    import assert from 'node:assert/strict'; import http from 'node:http'; import net from 'node:net';
    assert.throws(()=>http.request('https://example.invalid/v1/chat/completions'),/OFFLINE_PROVIDER_REQUEST_BLOCKED/);
    assert.throws(()=>http.get({hostname:'127.0.0.1',port:1,path:'/v1/chat/completions'}),/OFFLINE_PROVIDER_REQUEST_BLOCKED/);
    assert.throws(()=>net.connect({host:'example.invalid',port:443}),/OFFLINE_EXTERNAL_NETWORK_BLOCKED/);
    await assert.rejects(fetch('http://127.0.0.1:1/v1/responses'),/OFFLINE_PROVIDER_FETCH_BLOCKED/);
    await assert.rejects(fetch('http://127.0.0.1:1/todos'),/OFFLINE_PROVIDER_FETCH_BLOCKED/);
    console.log('NETWORK_DISPATCH_BLOCKED');
  `], { cwd: group, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /NETWORK_DISPATCH_BLOCKED/);
});

// Synthetic loopback services and fresh native children only. These never read
// or run employee artifacts and are not real-model or employee acceptance.
async function fixtureServer(handler, host = '127.0.0.1') {
  const server = http.createServer(handler); server.listen(0, host); await once(server, 'listening');
  return { server, base: `http://${host === '::1' ? '[::1]' : host}:${server.address().port}` };
}
async function closeServer(server) {
  await new Promise(done => { server.closeAllConnections(); server.close(done); });
}
async function loopbackPreload(name) {
  const preload = join(group, name + '.cjs'); await writeFile(preload, networkGuardCode({ allowLoopbackFetch: true })); return preload;
}
async function guardedChild(preload, code, args = []) {
  // Only known OS execution variables come from this process. All credential,
  // proxy and prior NODE_OPTIONS entries here are explicit synthetic sentinels.
  const source = Object.fromEntries(['SystemRoot', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'TEMP', 'TMP'].filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
  Object.assign(source, { OPENAI_API_KEY: 'SYNTHETIC_NOT_A_KEY', GATEWAY_TOKEN: 'SYNTHETIC_NOT_A_KEY', HTTP_PROXY: 'http://example.invalid:1', NODE_OPTIONS: '--require=synthetic-forbidden-preload.cjs' });
  return await new Promise((accept, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, ...args], { cwd: group, env: executionEnv(preload, source), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
    const timer = setTimeout(() => child.kill(), 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); accept({ code, output }); });
  });
}

test('explicit loopback fetch performs real CRUD and passes the guard and clean environment to a native child', async () => {
  const preload = await loopbackPreload('loopback-positive'); const requests = [], rows = new Map();
  const local = await fixtureServer(async (request, response) => {
    requests.push({ method: request.method, url: request.url }); let bytes = ''; for await (const part of request) bytes += part;
    response.setHeader('content-type', 'application/json');
    if (request.method === 'POST' && request.url === '/todos') { const value = JSON.parse(bytes); rows.set('1', { id: '1', title: value.title }); response.writeHead(201); response.end(JSON.stringify(rows.get('1'))); }
    else if (request.method === 'PUT' && request.url === '/todos/1') { rows.set('1', { id: '1', ...JSON.parse(bytes) }); response.end(JSON.stringify(rows.get('1'))); }
    else if (request.method === 'DELETE' && request.url === '/todos/1') { rows.delete('1'); response.writeHead(204); response.end(); }
    else if (request.method === 'GET' && request.url === '/todos') response.end(JSON.stringify([...rows.values()]));
    else if (request.method === 'GET' && request.url === '/todos/1') response.end(JSON.stringify(rows.get('1')));
    else { response.writeHead(404); response.end('{}'); }
  });
  const ipv6 = await fixtureServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end('{"ipv6":true}'); }, '::1');
  try {
    const child = await guardedChild(preload, `
      import assert from 'node:assert/strict'; import {spawnSync} from 'node:child_process';
      const base=process.argv[1],v6=process.argv[2];
      assert.equal(process.env.OPENAI_API_KEY,undefined);assert.equal(process.env.GATEWAY_TOKEN,undefined);assert.equal(process.env.HTTP_PROXY,undefined);
      const made=await fetch(base+'/todos',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'fixture'})});assert.equal(made.status,201);assert.deepEqual(await made.json(),{id:'1',title:'fixture'});
      assert.deepEqual(await (await fetch(new URL(base+'/todos/1'))).json(),{id:'1',title:'fixture'});
      assert.deepEqual(await (await fetch(new Request(base+'/todos/1',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({title:'updated'})}))).json(),{id:'1',title:'updated'});
      assert.equal((await fetch(base+'/todos/1',{method:'DELETE'})).status,204);assert.deepEqual(await (await fetch(base+'/todos')).json(),[]);
      assert.deepEqual(await (await fetch(base.replace('127.0.0.1','localhost')+'/todos')).json(),[]);
      assert.deepEqual(await (await fetch(v6+'/todos')).json(),{ipv6:true});
      const inherited=spawnSync(process.execPath,['--input-type=module','-e',"import assert from 'node:assert/strict';assert.equal(process.env.OPENAI_API_KEY,undefined);assert.equal(process.env.GATEWAY_TOKEN,undefined);assert.equal(process.env.HTTP_PROXY,undefined);assert.deepEqual(await(await fetch(process.argv[1]+'/todos')).json(),[]);await assert.rejects(fetch('http://example.invalid/todos'),/OFFLINE_PROVIDER_FETCH_BLOCKED/);console.log('INHERITED_LOOPBACK_GUARD');",base],{encoding:'utf8',windowsHide:true,timeout:5000});
      assert.equal(inherited.status,0,inherited.stderr);assert.match(inherited.stdout,/INHERITED_LOOPBACK_GUARD/);console.log('REAL_CRUD_AND_CHILD_INHERITANCE');
    `, [local.base, ipv6.base]);
    assert.equal(child.code, 0, child.output); assert.match(child.output, /REAL_CRUD_AND_CHILD_INHERITANCE/);
    assert.equal(requests.length, 7); assert.equal(rows.size, 0);
  } finally { await closeServer(local.server); await closeServer(ipv6.server); }
});

test('loopback fetch rejects external, unknown, relative, credentials and encoded provider URLs before socket dispatch', async () => {
  const preload = await loopbackPreload('loopback-negative'); let requests = 0;
  const local = await fixtureServer((_request, response) => { requests++; response.end('unexpected dispatch'); });
  try {
    const child = await guardedChild(preload, `
      import assert from 'node:assert/strict'; import net from 'node:net'; import http from 'node:http';
      const base=process.argv[1],old=net.Socket.prototype.connect;let externalAttempts=0;
      net.Socket.prototype.connect=function(...args){let a=args[0];if(Array.isArray(a))a=a[0];const host=typeof a==='object'?a?.host:typeof args[1]==='string'?args[1]:'localhost';if(!['127.0.0.1','localhost','::1'].includes(host||'localhost'))externalAttempts++;return old.apply(this,args);};
      const targets=['http://example.invalid/todos','http://192.0.2.1/todos','//127.0.0.1/todos','/todos','',null,{}, {toString:()=>base+'/todos'},new Request('http://example.invalid/todos'),base.replace('http://','ftp://')+'/todos',base.replace('http://','http://fixture:password@')+'/todos'];
      for(const path of ['/v1/chat/completions','/v1/responses','/responses','/chat/completions','/api/usage','/api/billing','/api/log','/api/models/test','/api/providers/test','/api/projects/fixture/generate','/%76%31/responses','/%2576%2531/responses'])targets.push(base+path);
      for(const target of targets)await assert.rejects(fetch(target),/OFFLINE_PROVIDER_FETCH_BLOCKED/);
      assert.equal(externalAttempts,0,'blocked fetch must not reach any outside socket');
      assert.throws(()=>http.get(base+'/v1/responses'),/OFFLINE_PROVIDER_REQUEST_BLOCKED/);
      assert.throws(()=>net.connect({host:'example.invalid',port:443}),/OFFLINE_EXTERNAL_NETWORK_BLOCKED/);
      console.log('FETCH_REJECTED_BEFORE_DISPATCH');
    `, [local.base]);
    assert.equal(child.code, 0, child.output); assert.match(child.output, /FETCH_REJECTED_BEFORE_DISPATCH/); assert.equal(requests, 0);
    assert.throws(() => networkGuardCode({ allowLoopbackFetch: 'true' }), /explicit boolean/);
  } finally { await closeServer(local.server); }
});

test('loopback fetch never follows an external or provider redirect even when the caller requests follow or manual', async () => {
  const preload = await loopbackPreload('loopback-redirect'); const requests = [];
  const local = await fixtureServer((request, response) => {
    requests.push(request.url);
    if (request.url === '/external') { response.writeHead(302, { location: 'http://example.invalid/todos' }); response.end(); }
    else if (request.url === '/provider') { response.writeHead(307, { location: '/v1/chat/completions' }); response.end(); }
    else if (request.url === '/safe-local') { response.writeHead(302, { location: '/todos' }); response.end(); }
    else response.end('unexpected redirect destination');
  });
  try {
    const child = await guardedChild(preload, `
      import assert from 'node:assert/strict';import net from 'node:net';
      const base=process.argv[1],old=net.Socket.prototype.connect;let externalAttempts=0;
      net.Socket.prototype.connect=function(...args){let a=args[0];if(Array.isArray(a))a=a[0];const host=typeof a==='object'?a?.host:typeof args[1]==='string'?args[1]:'localhost';if(!['127.0.0.1','localhost','::1'].includes(host||'localhost'))externalAttempts++;return old.apply(this,args);};
      for(const [path,redirect] of [['/external','follow'],['/provider','follow'],['/safe-local','manual']])await assert.rejects(fetch(new Request(base+path,{redirect})),error=>{assert.match(String(error.cause?.message??error.message),/redirect/i);return true;});
      assert.equal(externalAttempts,0);console.log('REDIRECTS_CANNOT_ESCAPE');
    `, [local.base]);
    assert.equal(child.code, 0, child.output); assert.match(child.output, /REDIRECTS_CANNOT_ESCAPE/);
    assert.deepEqual(requests, ['/external', '/provider', '/safe-local']);
  } finally { await closeServer(local.server); }
});

test('the restore worker overrides the explicit loopback test mode and still rejects every fetch', async () => {
  const directory = join(group, 'worker-with-loopback-preload'); await mkdir(directory);
  const db = await PGlite.create({ dataDir: join(directory, 'database') }); await db.exec("CREATE TABLE fixture_business(id text);INSERT INTO fixture_business VALUES('synthetic');"); await db.close();
  const preload = await loopbackPreload('worker-loopback');
  const child = await guardedChild(preload, `
    import assert from 'node:assert/strict';
    const {worker}=await import(process.argv[1]);await worker(process.argv[2],'');
    await assert.rejects(fetch('http://127.0.0.1:1/todos'),/OFFLINE_RESTORE_PROVIDER_BLOCKED/);
    await assert.rejects(fetch('http://example.invalid/todos'),/OFFLINE_RESTORE_PROVIDER_BLOCKED/);console.log('RESTORE_FETCH_REMAINS_BLOCKED');
  `, [new URL('../scripts/verify-mvp-full-offline-backup.mjs', import.meta.url).href, directory]);
  assert.equal(child.code, 0, child.output); assert.match(child.output, /RESTORE_FETCH_REMAINS_BLOCKED/);
});
