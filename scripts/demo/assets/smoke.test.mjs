import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createTodoServer } from './todo.mjs';

let server, url;
before(async () => { server = createTodoServer().listen(0, '127.0.0.1'); await once(server, 'listening'); url = `http://127.0.0.1:${server.address().port}`; });
after(async () => { await new Promise(resolve => server.close(resolve)); });
test('health endpoint', async () => { const response = await fetch(url + '/health'); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: 'ok' }); });
test('create and read a todo', async () => {
  const response = await fetch(url + '/todos', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'First task' }) });
  assert.equal(response.status, 201);
  const todo = await response.json(); assert.equal(todo.title, 'First task'); assert.equal(todo.completed, false);
  const read = await fetch(url + '/todos/' + todo.id); assert.deepEqual(await read.json(), todo);
});
