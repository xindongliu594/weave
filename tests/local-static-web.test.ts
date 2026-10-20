import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http, { type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { assertLocalStaticBuild, createLocalStaticWeb } from '../scripts/local-static-web.mjs';

let directory: string, buildRoot: string, upstream: Server, apiPort: number, web: Awaited<ReturnType<typeof createLocalStaticWeb>>, port: number;
let calls = 0, mutations = 0, continueStream: (() => void) | undefined;
const received: Array<{ method?: string; path?: string; headers: IncomingHttpHeaders; body: Buffer; socket: IncomingMessage['socket'] }> = [];
const replies = new Map<string, string>();
const unknownWrites = new Map<string, number>();
const html = '<!doctype html><html><body>为伍静态宿主协议回归</body></html>';
const js = 'document.title="静态构建";';

const closeServer = (server: Server) => new Promise<void>((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeAllConnections(); });
function request(path: string, { method = 'GET', headers = {}, body = Buffer.alloc(0), target = port }: { method?: string; headers?: IncomingHttpHeaders; body?: Buffer; target?: number } = {}) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((done, reject) => {
    const outgoing = http.request({ hostname: '127.0.0.1', port: target, path, method, headers }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk)); response.once('error', reject);
      response.once('end', () => done({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }));
    }); outgoing.once('error', reject); outgoing.end(body);
  });
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'weiwu-static-host-')); buildRoot = join(directory, 'web');
  await mkdir(join(buildRoot, 'assets'), { recursive: true });
  await writeFile(join(buildRoot, 'index.html'), html); await writeFile(join(buildRoot, 'assets/app.js'), js); await writeFile(join(buildRoot, 'assets/app.css'), 'body{color:#111}');
  upstream = http.createServer(async (incoming, response) => {
    calls++; const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(chunk);
    const body = Buffer.concat(chunks); received.push({ method: incoming.method, path: incoming.url, headers: incoming.headers, body, socket: incoming.socket });
    if (incoming.url?.startsWith('/api/socket-failure?')) {
      const key = incoming.headers['idempotency-key'];
      if (incoming.method !== 'GET' && typeof key === 'string') unknownWrites.set(key, (unknownWrites.get(key) ?? 0) + 1);
      // The fixture consumed the body and may have committed a mutation. An
      // interrupted response must never cause the proxy to replay the request.
      incoming.socket.destroy(); return;
    }
    if (incoming.url === '/api/stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'x-stream-marker': 'streamed' }); response.write('data: first\n\n');
      await new Promise<void>(done => { continueStream = done; }); response.end('data: last\n\n'); return;
    }
    if (incoming.url === '/api/wait') { response.writeHead(200); response.write('pending'); return; }
    if (incoming.url === '/api/rejected') { response.writeHead(403, { 'content-type': 'application/json', 'x-refusal': 'upstream' }); response.end('{"code":"DEVICE_DISABLED"}'); return; }
    if (incoming.url === '/api/missing') { response.writeHead(404, { 'content-type': 'application/json' }); response.end('{"message":"接口不存在"}'); return; }
    const key = incoming.headers['idempotency-key'];
    if (typeof key === 'string' && !replies.has(key)) { mutations++; replies.set(key, JSON.stringify({ id: 'one-creation', input: body.toString('utf8') })); }
    response.writeHead(201, { 'content-type': 'application/json; charset=utf-8', 'x-request-id': 'upstream-id', 'set-cookie': ['a=1', 'b=2'] });
    response.end(typeof key === 'string' ? replies.get(key)! : body);
  }); upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening'); apiPort = (upstream.address() as import('node:net').AddressInfo).port;
  web = await createLocalStaticWeb({ buildRoot, apiPort, webPort: 0 }); await web.listen(); port = (web.server.address() as import('node:net').AddressInfo).port;
});

after(async () => {
  continueStream?.(); await web?.close(); if (upstream?.listening) await closeServer(upstream);
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep), 'Only the owned OS temporary directory is removed');
  await rm(directory, { recursive: true, force: true });
});

test('static page, assets and HEAD use correct MIME without a development server', async () => {
  assert.equal((web.server.address() as import('node:net').AddressInfo).address, '127.0.0.1');
  const page = await request('/?version=1'); assert.equal(page.status, 200); assert.equal(page.body.toString(), html); assert.match(String(page.headers['content-type']), /^text\/html/);
  assert.equal(page.headers['x-content-type-options'], 'nosniff'); assert.equal(page.headers['cache-control'], 'no-store');
  const asset = await request('/assets/app.js'); assert.equal(asset.status, 200); assert.equal(asset.body.toString(), js); assert.match(String(asset.headers['content-type']), /^application\/javascript/);
  const css = await request('/assets/app.css'); assert.equal(css.status, 200); assert.match(String(css.headers['content-type']), /^text\/css/);
  const head = await request('/assets/app.js', { method: 'HEAD' }); assert.equal(head.body.length, 0); assert.equal(Number(head.headers['content-length']), Buffer.byteLength(js));
});

test('API proxy retains bytes, query, status, end-to-end headers and original idempotency key', async () => {
  const body = Buffer.from('{"需求":"多轮对话","value":1}'), key = 'owned-static-proxy-original-key';
  const headers = { 'content-type': 'application/json', 'idempotency-key': key, 'x-caller-marker': 'preserved', 'content-length': String(body.length) };
  const first = await request('/api/echo?query=%E4%B8%AD', { method: 'POST', headers, body });
  const second = await request('/api/echo?query=%E4%B8%AD', { method: 'POST', headers, body });
  assert.equal(first.status, 201); assert.deepEqual(first.body, second.body); assert.equal(mutations, 1);
  assert.equal(first.headers['x-request-id'], 'upstream-id'); assert.deepEqual(first.headers['set-cookie'], ['a=1', 'b=2']);
  const packet = received.at(-1)!; assert.equal(packet.method, 'POST'); assert.equal(packet.path, '/api/echo?query=%E4%B8%AD');
  assert.deepEqual(packet.body, body); assert.equal(packet.headers['idempotency-key'], key); assert.equal(packet.headers['x-caller-marker'], 'preserved');
});

test('liveness probe reaches the API instead of the SPA',async()=>{
  const response=await request('/healthz');
  assert.equal(response.status,201);
  assert.equal(received.at(-1)?.path,'/healthz');
  assert.notEqual(response.body.toString(),html);
});

test('upstream permission failure and API 404 remain API responses', async () => {
  const denied = await request('/api/rejected'); assert.equal(denied.status, 403); assert.equal(denied.headers['x-refusal'], 'upstream'); assert.equal(denied.body.toString(), '{"code":"DEVICE_DISABLED"}');
  const missing = await request('/api/missing'); assert.equal(missing.status, 404); assert.equal(missing.body.toString(), '{"message":"接口不存在"}');
});

test('successive API reads use a fresh upstream socket for every request', async () => {
  const start = received.length;
  for (let index = 0; index < 8; index++) {
    const result = await request('/api/fresh-socket?index=' + index);
    assert.equal(result.status, 201);
  }
  const packets = received.slice(start);
  assert.equal(packets.length, 8); assert.equal(new Set(packets.map(packet => packet.socket)).size, 8);
  assert.deepEqual(packets.map(packet => packet.path), Array.from({ length: 8 }, (_, index) => '/api/fresh-socket?index=' + index));
});

test('upstream disconnect after receiving a GET or mutation dispatches once and never replays an unknown result', async () => {
  for (const method of ['GET', 'POST', 'PUT']) {
    const key = 'owned-disconnect-original-' + method, path = '/api/socket-failure?method=' + method;
    const body = method === 'GET' ? Buffer.alloc(0) : Buffer.from('{"需求":"原始唯一请求","method":"' + method + '"}');
    const beforeCalls = calls, start = received.length;
    const result = await request(path, { method, headers: { 'content-type': 'application/json', 'content-length': String(body.length), 'idempotency-key': key }, body });
    assert.equal(result.status, 502); assert.equal(JSON.parse(result.body.toString()).code, 'LOCAL_API_UNAVAILABLE');
    await new Promise(done => setTimeout(done, 50));
    assert.equal(calls, beforeCalls + 1); assert.equal(received.length, start + 1);
    const packet = received[start]; assert.equal(packet.path, path); assert.equal(packet.method, method);
    assert.equal(packet.headers['idempotency-key'], key); assert.deepEqual(packet.body, body);
    if (method !== 'GET') assert.equal(unknownWrites.get(key), 1);
  }
  const healthy = await request('/api/echo'); assert.equal(healthy.status, 201);
});

test('Host and browser Origin guards reject both HTML and API before upstream operations', async () => {
  const beforeCalls = calls;
  for (const path of ['/', '/api/echo']) {
    for (const headers of [{ host: 'evil.invalid' }, { host: 'user@localhost' }, { origin: 'https://evil.invalid' },
      { origin: 'http://127.0.0.1:4310', 'sec-fetch-site': 'cross-site' }, { origin: 'null' }]) {
      assert.equal((await request(path, { headers })).status, 403);
    }
  }
  assert.equal(calls, beforeCalls);
  assert.equal((await request('/', { headers: { origin: 'http://127.0.0.1:' + port, 'sec-fetch-site': 'same-origin' } })).status, 200);
  assert.equal((await request('/api/echo', { headers: { origin: 'http://127.0.0.1:' + port, 'sec-fetch-site': 'same-origin' } })).status, 201);
});

test('SPA fallback excludes API, missing assets, encoded traversal and non-read methods', async () => {
  assert.equal((await request('/projects/one', { headers: { accept: 'text/html' } })).body.toString(), html);
  assert.equal((await request('/assets/missing.js')).status, 404); assert.equal((await request('/assets/missing')).status, 404);
  for (const path of ['/%2e%2e/private.txt', '/%5c..%5cprivate.txt', '/.env', '/assets/%00app.js']) assert.equal((await request(path)).status, 403);
  assert.equal((await request('/%zz')).status, 400);
  const write = await request('/', { method: 'POST' }); assert.equal(write.status, 405); assert.equal(write.headers.allow, 'GET, HEAD');
});

test('static serving refuses a directory link outside the build root', async () => {
  const outside = join(directory, 'outside'); await mkdir(outside); await writeFile(join(outside, 'private.txt'), 'owned fixture outside static root');
  await symlink(outside, join(buildRoot, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await request('/external/private.txt')).status, 403);
});

test('streamed API response starts before the upstream completes', { timeout: 5000 }, async () => {
  const incoming = await new Promise<IncomingMessage>((done, reject) => { const outgoing = http.get({ hostname: '127.0.0.1', port, path: '/api/stream' }, done); outgoing.once('error', reject); });
  assert.equal(incoming.statusCode, 200); assert.equal(incoming.headers['x-stream-marker'], 'streamed');
  const first = await once(incoming, 'data'); assert.equal(Buffer.from(first[0]).toString(), 'data: first\n\n');
  const chunks: Buffer[] = []; incoming.on('data', chunk => chunks.push(chunk)); const finished = once(incoming, 'end');
  assert.ok(continueStream); continueStream(); await finished; assert.equal(Buffer.concat(chunks).toString(), 'data: last\n\n');
});

test('unavailable API returns an explicit 502 and never falls through to the SPA', async () => {
  const unused = http.createServer(); unused.listen(0, '127.0.0.1'); await once(unused, 'listening'); const unusedPort = (unused.address() as import('node:net').AddressInfo).port; await closeServer(unused);
  const isolated = await createLocalStaticWeb({ buildRoot, apiPort: unusedPort, webPort: 0 }); await isolated.listen();
  try { const result = await request('/api/health', { target: (isolated.server.address() as import('node:net').AddressInfo).port }); assert.equal(result.status, 502); assert.equal(JSON.parse(result.body.toString()).code, 'LOCAL_API_UNAVAILABLE'); }
  finally { await isolated.close(); }
});

test('closing static host aborts an outstanding API stream, releases the port and is idempotent', { timeout: 5000 }, async () => {
  const isolated = await createLocalStaticWeb({ buildRoot, apiPort, webPort: 0 }); await isolated.listen(); const isolatedPort = (isolated.server.address() as import('node:net').AddressInfo).port;
  const incoming = await new Promise<IncomingMessage>((done, reject) => { const outgoing = http.get({ hostname: '127.0.0.1', port: isolatedPort, path: '/api/wait' }, done); outgoing.once('error', reject); });
  const disconnected = new Promise<void>(done => { incoming.once('error', () => {}); incoming.once('close', done); });
  await Promise.all([isolated.close(), isolated.close(), disconnected]);
  const reopened = http.createServer(); reopened.listen(isolatedPort, '127.0.0.1'); await once(reopened, 'listening'); await closeServer(reopened);
});

test('missing build fails with a build instruction and does not create a data directory', async () => {
  const missing = join(directory, 'missing-web'); await assert.rejects(assertLocalStaticBuild(missing), /npm run build/);
  assert.equal(existsSync(missing), false);
  await assert.rejects(createLocalStaticWeb({ buildRoot: missing, apiPort, webPort: 0 }), /npm run build/);
});

test('existing built product index and assets are served unchanged', { skip: !existsSync(resolve('dist/web/index.html')) }, async () => {
  const built = await createLocalStaticWeb({ buildRoot: resolve('dist/web'), apiPort, webPort: 0 }); await built.listen();
  try {
    const target = (built.server.address() as import('node:net').AddressInfo).port;
    const actual = await request('/', { target }); const expected = await readFile(resolve('dist/web/index.html'));
    assert.deepEqual(actual.body, expected); const source = expected.toString('utf8'); assert.match(source, /为伍/);
    const script = /<script[^>]+src="([^"]+)"/.exec(source)?.[1]; assert.ok(script);
    const asset = await request(script, { target }); assert.equal(asset.status, 200); assert.match(String(asset.headers['content-type']), /^application\/javascript/);
    assert.deepEqual(asset.body, await readFile(join(resolve('dist/web'), script.slice(1))));
  } finally { await built.close(); }
});
