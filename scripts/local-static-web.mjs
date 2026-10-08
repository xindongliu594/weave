import http from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isAllowedRequestOrigin } from '../apps/api/src/request-origin.ts';

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm',
};

function inside(root, file) {
  const path = relative(root, file);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep));
}

export async function assertLocalStaticBuild(buildRoot) {
  try {
    const root = await realpath(resolve(buildRoot)), index = await realpath(join(root, 'index.html'));
    if (!inside(root, index) || !(await stat(index)).isFile()) throw Error('Missing index');
    return root;
  } catch {
    throw Error('未找到可读取的已构建网页。请先运行 npm run build，再运行 npm run local -- --production。');
  }
}

function reply(response, status, code, message) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ code, message }));
}

function localRequest(request, response, allowedOrigins) {
  const host = request.headers.host;
  try {
    if (typeof host !== 'string' || /[\s/\\#?@]/.test(host) || !loopbackHosts.has(new URL('http://' + host).hostname)) throw Error('Host');
  } catch { reply(response, 403, 'LOCAL_ACCESS_ONLY', '仅允许本机访问'); return false; }
  const origin = request.headers.origin, fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite === 'cross-site' || (origin && (typeof origin !== 'string' || !isAllowedRequestOrigin(origin, fetchSite, allowedOrigins)))) {
    reply(response, 403, 'REQUEST_ORIGIN_DENIED', '不允许跨站请求，请从当前工作台页面操作。'); return false;
  }
  return true;
}

function endToEndHeaders(headers) {
  const excluded = new Set(hopHeaders);
  for (const token of String(headers.connection ?? '').split(',')) excluded.add(token.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name.toLowerCase())));
}

export async function createLocalStaticWeb({ buildRoot, apiPort, webPort, allowedOrigins = new Set() }) {
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535 || !Number.isInteger(webPort) || webPort < 0 || webPort > 65535) throw Error('无效的本机 HTTP 端口');
  const root = await assertLocalStaticBuild(buildRoot), agent = new http.Agent({ keepAlive: false }), active = new Set();
  let closing = false, closed;

  function proxy(request, response) {
    const upstream = http.request({ hostname: '127.0.0.1', port: apiPort, path: request.url, method: request.method,
      headers: endToEndHeaders(request.headers), agent });
    active.add(upstream);
    const abort = () => upstream.destroy();
    request.once('aborted', abort);
    request.once('error', abort);
    response.once('close', () => { if (!response.writableFinished) abort(); });
    upstream.once('close', () => { active.delete(upstream); request.removeListener('aborted', abort); request.removeListener('error', abort); });
    upstream.once('error', () => reply(response, 502, 'LOCAL_API_UNAVAILABLE', '本机 API 暂时无法连接，请检查本地服务状态。'));
    upstream.once('response', result => {
      result.once('error', () => reply(response, 502, 'LOCAL_API_UNAVAILABLE', '本机 API 响应中断，请检查本地服务状态。'));
      if (response.destroyed) { result.destroy(); return; }
      response.writeHead(result.statusCode ?? 502, endToEndHeaders(result.headers));
      result.pipe(response);
    });
    request.pipe(upstream);
  }

  async function serve(request, response) {
    response.setHeader('cache-control', 'no-store'); response.setHeader('x-content-type-options', 'nosniff');
    if (closing) return reply(response, 503, 'WORKBENCH_STOPPING', '本机工作台正在停止。');
    if (!localRequest(request, response, allowedOrigins)) return;
    if (typeof request.url !== 'string' || !request.url.startsWith('/') || request.url.startsWith('//')) return reply(response, 400, 'INVALID_PATH', '请求路径无效');
    const rawPath = request.url.split('?')[0];
    if (/^\/api(?:\/|$)/i.test(rawPath)) { proxy(request, response); return; }
    if (!['GET', 'HEAD'].includes(request.method)) { response.setHeader('allow', 'GET, HEAD'); return reply(response, 405, 'METHOD_NOT_ALLOWED', '网页文件仅支持读取。'); }
    let pathname;
    try { pathname = decodeURIComponent(rawPath); } catch { return reply(response, 400, 'INVALID_PATH', '请求路径无效'); }
    if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some(part => part.startsWith('.'))) return reply(response, 403, 'STATIC_PATH_DENIED', '不能读取此网页路径。');
    let file = resolve(root, '.' + pathname);
    if (!inside(root, file)) return reply(response, 403, 'STATIC_PATH_DENIED', '不能读取此网页路径。');
    let metadata;
    try {
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      file = await realpath(file); if (!inside(root, file)) return reply(response, 403, 'STATIC_PATH_DENIED', '不能读取此网页路径。');
      metadata = await stat(file); if (!metadata.isFile()) return reply(response, 404, 'STATIC_NOT_FOUND', '网页文件不存在。');
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
      const accept = String(request.headers.accept ?? '*/*');
      if (extname(pathname) || /^\/assets(?:\/|$)/i.test(pathname) || !(accept.includes('text/html') || accept.includes('*/*'))) return reply(response, 404, 'STATIC_NOT_FOUND', '网页文件不存在。');
      file = await realpath(join(root, 'index.html')); if (!inside(root, file)) return reply(response, 403, 'STATIC_PATH_DENIED', '不能读取此网页路径。');
      metadata = await stat(file);
    }
    response.setHeader('content-type', mimeTypes[extname(file).toLowerCase()] ?? 'application/octet-stream');
    response.setHeader('content-length', metadata.size);
    if (request.method === 'HEAD') { response.end(); return; }
    const stream = createReadStream(file);
    stream.once('error', () => { if (response.headersSent) response.destroy(); else { response.removeHeader('content-length'); reply(response, 500, 'STATIC_READ_FAILED', '无法读取已构建网页，请检查构建文件。'); } });
    response.once('close', () => stream.destroy()); stream.pipe(response);
  }

  const server = http.createServer((request, response) => { void serve(request, response).catch(() => reply(response, 500, 'STATIC_READ_FAILED', '无法读取已构建网页，请检查构建文件。')); });
  server.on('upgrade', (_request, socket) => { socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  return {
    server,
    async listen() {
      if (closing) throw Error('本机工作台已停止');
      await new Promise((done, reject) => {
        const failed = error => { server.removeListener('listening', ready); reject(error); };
        const ready = () => { server.removeListener('error', failed); done(); };
        server.once('error', failed); server.once('listening', ready); server.listen(webPort, '127.0.0.1');
      });
    },
    close() {
      return closed ??= (async () => {
        closing = true;
        for (const upstream of active) upstream.destroy(); agent.destroy();
        if (!server.listening) return;
        await new Promise((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeAllConnections(); });
      })();
    },
  };
}
