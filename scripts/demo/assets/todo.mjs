import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function createTodoServer() {
  const todos = new Map();
  return http.createServer(async (req, res) => {
    const reply = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(value === undefined ? undefined : JSON.stringify(value));
    };
    const path = new URL(req.url, 'http://localhost').pathname;
    try {
      if (req.method === 'GET' && path === '/health') return reply(200, { status: 'ok' });
      if (req.method === 'GET' && path === '/todos') return reply(200, [...todos.values()]);
      const match = /^\/todos\/([^/]+)$/.exec(path);
      if (match && !todos.has(match[1])) return reply(404, { error: 'Todo not found' });
      if (match && req.method === 'GET') return reply(200, todos.get(match[1]));
      if (match && req.method === 'DELETE') { todos.delete(match[1]); return reply(204); }
      if ((path === '/todos' && req.method === 'POST') || (match && req.method === 'PATCH')) {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 16384) return reply(413, { error: 'Body too large' });
        }
        const input = JSON.parse(body);
        if (!input || Array.isArray(input) || typeof input !== 'object') return reply(400, { error: 'Expected an object' });
        if (Object.keys(input).some(key => !['title', 'completed'].includes(key))) return reply(400, { error: 'Unknown field' });
        if ((req.method === 'POST' || 'title' in input) && (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200)) return reply(400, { error: 'Invalid title' });
        if ('completed' in input && typeof input.completed !== 'boolean') return reply(400, { error: 'Invalid completed' });
        const previous = match ? todos.get(match[1]) : { id: randomUUID(), completed: false };
        const todo = { ...previous, ...input, ...('title' in input ? { title: input.title.trim() } : {}) };
        todos.set(todo.id, todo);
        return reply(req.method === 'POST' ? 201 : 200, todo);
      }
      return reply(404, { error: 'Route not found' });
    } catch (error) { return reply(error instanceof SyntaxError ? 400 : 500, { error: error instanceof SyntaxError ? 'Invalid JSON' : 'Internal error' }); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.TODO_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Invalid TODO_PORT');
  const server = createTodoServer();
  server.listen(port, '127.0.0.1', () => console.log(`Todo API http://127.0.0.1:${server.address().port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}
