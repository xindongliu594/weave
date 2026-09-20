import { createHash } from 'node:crypto';
export function tokenize(text) {
  const normalized = text.toLowerCase().normalize('NFKC');
  const tokens = normalized.match(/[a-z0-9_]{2,}|[\p{Script=Han}]/gu) ?? [];
  const han = normalized.match(/[\p{Script=Han}]{2,}/gu) ?? [];
  for (const word of han) for (let i = 0; i < word.length - 1; i++) tokens.push(word.slice(i, i + 2));
  return [...new Set(tokens)];
}
export function chunkDocument(id, version, content) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const result = []; let start = 0, text = '';
  const push = end => { if (text.trim()) result.push({ id: createHash('sha256').update(`${id}:${version}:${start}:${text}`).digest('hex'), documentId: id, version, lineStart: start + 1, lineEnd: end, content: text, tokens: tokenize(text) }); };
  for (let i = 0; i < lines.length; i++) {
    if (text && text.length + lines[i].length > 1800) { push(i); start = i; text = ''; }
    if (lines[i].length > 4000) {
      if (text) { push(i); text = ''; }
      for (let at = 0; at < lines[i].length; at += 1800) { start = i; text = lines[i].slice(at, at + 1800); push(i + 1); }
      text = ''; start = i + 1;
    } else text += lines[i] + '\n';
  }
  push(lines.length); return result;
}
export function searchKnowledge(chunks, query, limit = 6) {
  const terms = tokenize(query);
  if (!terms.length) return [];
  return chunks.map(chunk => {
    const tokens = new Set(chunk.tokens ?? tokenize(chunk.content));
    const matches = terms.reduce((n, term) => n + (tokens.has(term) ? 1 : 0), 0);
    const score = matches / Math.sqrt(Math.max(1, tokens.size) * terms.length) + (chunk.content.toLowerCase().includes(query.toLowerCase()) ? 1 : 0);
    const { tokens: _indexTokens, ...source } = chunk;
    return { ...source, score };
  }).filter(c => c.score > 0).sort((a,b) => b.score - a.score).slice(0, Math.min(20, Math.max(1,limit)));
}
