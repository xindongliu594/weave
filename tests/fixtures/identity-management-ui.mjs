// UI-only fixture: synthetic people, no database, model calls, production sessions or credentials.
import express from 'express';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const app = express(); app.use(express.json());
const users = [{ id: 'admin', displayName: '测试管理员', email: 'admin@example.test', status: 'active', orgRole: 'admin', version: 1 },
  ...Array.from({ length: 22 }, (_, index) => ({ id: `u${String(index + 1).padStart(3, '0')}`, displayName: index === 0 ? '待开通甲' : index === 1 ? '部门成员乙' : `测试成员${index + 1}`,
    email: `person${index + 1}@example.test`, status: index === 0 ? 'pending' : 'active', orgRole: 'member', version: 1 }))];
const grants = new Map(), calls = []; let mode = 'local', failNext = null;
app.post('/fixture/control', (req, res) => { if (req.body.mode) mode = req.body.mode; failNext = req.body.failNext ?? null; res.json({ mode }); });
app.get('/fixture/state', (_req, res) => res.json({ mode, users, grants: [...grants.entries()], calls }));
app.get('/auth/session', (_req, res) => res.json(mode === 'local'
  ? { mode: 'legacy-local', authenticated: true, user: null, csrf: null, loginAvailable: false }
  : { mode: 'oidc', authenticated: true, user: users[0], csrf: 'synthetic-ui-csrf', loginAvailable: true }));
app.use('/api', (req, res, next) => {
  calls.push({ method: req.method, path: req.originalUrl, body: req.body ?? null, csrf: req.get('x-csrf-token') === 'synthetic-ui-csrf', key: !!req.get('idempotency-key') });
  if (mode !== 'admin') return res.status(403).json({ message: 'Synthetic administrator required' });
  if (req.method !== 'GET') {
    if (req.get('x-csrf-token') !== 'synthetic-ui-csrf' || !req.get('idempotency-key')) return res.status(403).json({ message: 'Missing CSRF or request key' });
    if (failNext) { const failure = failNext; failNext = null; if (failure === 'disconnect') return req.socket.destroy(); return res.status(409).json({ message: 'fixture version conflict' }); }
  }
  next();
});
const paginate = (rows, query) => {
  const all = rows.filter(row => !query.cursor || (row.id ?? row.userId) > query.cursor), limit = Number(query.limit ?? 50), items = all.slice(0, limit);
  return { items, nextCursor: all.length > limit ? (items.at(-1).id ?? items.at(-1).userId) : null };
};
app.get('/api/identity/users', (req, res) => res.json(paginate(users.filter(user => !req.query.status || user.status === req.query.status), req.query)));
app.patch('/api/identity/users/:id', (req, res) => {
  const user = users.find(item => item.id === req.params.id);
  if (!user) return res.sendStatus(404);
  if (user.version !== req.body.version) return res.status(409).json({ message: 'fixture stale user version' });
  if (req.body.status) user.status = req.body.status;
  if (req.body.orgRole) user.orgRole = req.body.orgRole;
  user.version++; res.json(user);
});
app.post('/api/identity/users/:id/revoke-sessions', (req, res) => {
  const user = users.find(item => item.id === req.params.id);
  if (!user) return res.sendStatus(404);
  if (user.version !== req.body.version) return res.status(409).json({ message: 'fixture stale user version' });
  user.version++; res.json(user);
});
app.get('/api/identity/departments/:id/members', (req, res) => res.json(paginate([...grants.values()].filter(grant => grant.departmentId === req.params.id).sort((a, b) => a.userId.localeCompare(b.userId)), req.query)));
app.put('/api/identity/departments/:id/members/:userId', (req, res) => {
  const user = users.find(item => item.id === req.params.userId), key = `${req.params.id}:${req.params.userId}`, previous = grants.get(key);
  if (!user || user.status !== 'active') return res.status(422).json({ message: 'fixture inactive user' });
  if ((previous?.version ?? 0) !== req.body.version) return res.status(409).json({ message: 'fixture stale membership version' });
  const version = Math.max(user.version, (previous?.version ?? 0) + 1); user.version = version + 1;
  const grant = { userId: user.id, departmentId: req.params.id, role: req.body.role, canApprove: req.body.canApprove, version };
  grants.set(key, grant); res.json(grant);
});
app.delete('/api/identity/departments/:id/members/:userId', (req, res) => {
  const user = users.find(item => item.id === req.params.userId), key = `${req.params.id}:${req.params.userId}`, previous = grants.get(key);
  if (!previous || previous.version !== req.body.version) return res.status(409).json({ message: 'fixture stale membership version' });
  user.version = Math.max(user.version, previous.version) + 1; grants.delete(key); res.json({ ok: true });
});
const fixtureCache = await mkdtemp(join(tmpdir(), 'weiwu-identity-ui-'));
const vite = await createServer({ configFile: false, cacheDir: fixtureCache, root: fileURLToPath(new URL('../../', import.meta.url)), plugins: [react()], server: { middlewareMode: true, host: '127.0.0.1' }, appType: 'custom' });
app.get('/', async (_req, res) => res.type('html').send(await vite.transformIndexHtml('/', '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>人员管理隔离验证</title></head><body><div id="root"></div><script type="module" src="/tests/fixtures/identity-management-ui.tsx"></script></body></html>')));
app.use(vite.middlewares);
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
console.log(`Identity UI fixture: http://127.0.0.1:${server.address().port}`);
let closing = false;
async function close() { if (closing) return; closing = true; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await vite.close(); await rm(fixtureCache, { recursive: true, force: true }); }
process.once('SIGINT', () => void close()); process.once('SIGTERM', () => void close());
setTimeout(() => void close(), 20 * 60_000).unref();
