exports.normalizeServer = value => {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error('服务器地址不能包含账号、查询参数或片段');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('远程连接必须使用 HTTPS');
  url.pathname = url.pathname.replace(/\/*$/, '/');
  return url.href;
};
exports.isWorkspaceURL = (value, server) => {
  try { const url = new URL(value), base = new URL(server); return url.origin === base.origin && url.pathname.startsWith(base.pathname); } catch { return false; }
};
