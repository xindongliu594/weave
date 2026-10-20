import { createHash } from 'node:crypto';
import { openSync, fstatSync, readSync, closeSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const toolRoot = fileURLToPath(new URL('.', import.meta.url));
export const datasetRoot = resolve(toolRoot, 'datasets');
export const hash = value => createHash('sha256').update(value).digest('hex');
export function readBounded(path, limit = 4 * 1024 * 1024) {
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error('file-size-limit');
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, null);
      if (!read) break;
      count += read;
    }
    if (count !== stat.size || fstatSync(fd).size !== stat.size) throw new Error('file-changed-during-read');
    return bytes.subarray(0, count);
  } finally { closeSync(fd); }
}
export function fixtureFile(path) {
  if (typeof path !== 'string' || isAbsolute(path) || /[:\\]/.test(path)) throw new Error('unsafe-fixture-path');
  const root = realpathSync(datasetRoot);
  const target = realpathSync(resolve(root, path));
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error('unsafe-fixture-path');
  return target;
}
export const readJson = path => JSON.parse(readBounded(path).toString('utf8'));
