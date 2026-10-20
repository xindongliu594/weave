const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const directOrigins = new Set([
  'http://127.0.0.1:4310', 'http://localhost:4310', 'http://[::1]:4310',
  'http://127.0.0.1:4311', 'http://localhost:4311', 'http://[::1]:4311',
]);

export function isAllowedCallbackNavigation(method:string,path:string,fetchMode:string|undefined):boolean {
  return method==='GET'&&path==='/auth/callback'&&fetchMode==='navigate';
}

export function configuredOrigins(raw = process.env.ALLOWED_ORIGINS ?? ''): Set<string> {
  const origins = new Set(raw.split(',').map(value => value.trim()).filter(Boolean));
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('ALLOWED_ORIGINS 必须是完整的 HTTPS origin，不含路径或末尾斜杠');
  }
  return origins;
}

export function isAllowedRequestOrigin(origin: string, fetchSite: string | undefined, allowedOrigins: ReadonlySet<string> = new Set()): boolean {
  if (fetchSite === 'cross-site') return false;
  if (directOrigins.has(origin) || allowedOrigins.has(origin)) return true;

  // Preview/SSH forwarding may change Host's port while preserving Origin.
  // Sec-Fetch-Site is browser-controlled: accept a dynamic local port only
  // when the browser itself identifies the request as same-origin.
  // https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Sec-Fetch-Site
  if (fetchSite !== 'same-origin') return false;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && loopbackHosts.has(url.hostname) && url.origin === origin;
  } catch {
    return false;
  }
}
