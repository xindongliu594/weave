import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const directory = resolve(process.env.DATA_DIR ?? '.data');
let key: Buffer | undefined;
export function resetVaultCache() { key = undefined; }
function masterKey() {
  if (key) return key;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, 'credential.key');
  try { key = readFileSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const candidate = randomBytes(32);
    try { writeFileSync(path, candidate, { flag: 'wx', mode: 0o600 }); key = candidate; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      key = readFileSync(path);
    }
  }
  if (key.length !== 32) throw new Error('Invalid credential master key');
  return key;
}
export function seal(secret: string) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  const content = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), content]).toString('base64');
}
export function unseal(value: string) {
  const buffer = Buffer.from(value, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', masterKey(), buffer.subarray(0, 12));
  cipher.setAuthTag(buffer.subarray(12, 28));
  return Buffer.concat([cipher.update(buffer.subarray(28)), cipher.final()]).toString('utf8');
}
