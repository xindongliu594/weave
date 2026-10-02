import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createTodoServer } from './todo.mjs';

let server, url;
before(async () => { server = createTodoServer().listen(0, '127.0.0.1'); await once(server, 'listening'); url = `http://127.0.0.1:${server.address().port}`; });
after(async () => { await new Promise(resolve => server.close(resolve)); });
const request = (path, method = 'GET', body) => fetch(url + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });

test('health reports ready', async () => { const response = await request('/health'); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: 'ok' }); });
test('full create, list, read, update, delete lifecycle', async () => {
  const created = await request('/todos', 'POST', { title: '  Independent acceptance  ' }); assert.equal(created.status, 201);
  const todo = await created.json(); assert.equal(todo.title, 'Independent acceptance'); assert.equal(todo.completed, false); assert.ok(todo.id);
  const list = await request('/todos'); assert.equal(list.status, 200); assert.ok((await list.json()).some(item => item.id === todo.id));
  assert.deepEqual(await (await request('/todos/' + todo.id)).json(), todo);
  const patched = await request('/todos/' + todo.id, 'PATCH', { title: 'Finished', completed: true }); assert.equal(patched.status, 200);
  assert.deepEqual(await patched.json(), { id: todo.id, title: 'Finished', completed: true });
  const deleted = await request('/todos/' + todo.id, 'DELETE'); assert.equal(deleted.status, 204); assert.equal(await deleted.text(), '');
  assert.equal((await request('/todos/' + todo.id)).status, 404);
});
test('reject invalid fields and values', async () => {
  for (const body of [{ title: '' }, { title: '   ' }, { title: 42 }, { title: 'x', completed: 'yes' }, { title: 'x', id: 'forged' }, [], null]) assert.equal((await request('/todos', 'POST', body)).status, 400);
});
test('reject malformed JSON', async () => { assert.equal((await fetch(url + '/todos', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken' })).status, 400); });
test('missing todo cannot be read, updated or deleted', async () => { for (const method of ['GET', 'PATCH', 'DELETE']) assert.equal((await request('/todos/missing', method, method === 'PATCH' ? { completed: true } : undefined)).status, 404); });
test('unknown routes return 404', async () => { assert.equal((await request('/unknown')).status, 404); });
