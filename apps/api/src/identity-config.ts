import { identityText, type IdentityConfig } from './identity-types.ts';
export type { IdentityConfig } from './identity-types.ts';

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!identityText(value, 16384)) throw Error(`Invalid or missing ${key}`);
  return value;
}

function httpsUrl(value: string, name: string, originOnly: boolean): string {
  let url: URL;
  try { url = new URL(value); } catch { throw Error(`Invalid ${name}`); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || /[?#\\]/u.test(value)
    || (originOnly && value !== url.origin)) throw Error(`Invalid ${name}`);
  return value; // The issuer is an exact OIDC identifier; do not normalize its trailing slash.
}

function placeholder(value: string): boolean {
  return /^(?:secret|password)$/iu.test(value) || /(?:change[\s_-]*me|replace[\s_-]*(?:me|with)|your[\s_-]*(?:secret|session)|placeholder|example[\s_-]*secret|development[\s_-]*only)/iu.test(value);
}

function repeated(value: string): boolean {
  for (let size = 1; size <= Math.floor(value.length / 2); size++) {
    if (value === value.slice(0, size).repeat(Math.ceil(value.length / size)).slice(0, value.length)) return true;
  }
  return false;
}

function strongSessionSecret(value: unknown): value is string {
  return identityText(value, 4096) && Buffer.byteLength(value, 'utf8') >= 32 && !placeholder(value)
    && new Set(value).size >= 8 && !repeated(value);
}

export function loadIdentityConfig(env: NodeJS.ProcessEnv): IdentityConfig {
  const mode = env.WEIWU_AUTH_MODE ?? 'legacy-local';
  if (mode === 'legacy-local') return { mode };
  if (mode !== 'oidc') throw Error('Invalid WEIWU_AUTH_MODE');
  const publicOrigin = httpsUrl(required(env, 'WEIWU_PUBLIC_ORIGIN'), 'WEIWU_PUBLIC_ORIGIN', true);
  const issuer = httpsUrl(required(env, 'WEIWU_OIDC_ISSUER'), 'WEIWU_OIDC_ISSUER', false);
  const bootstrapIssuer = httpsUrl(required(env, 'WEIWU_BOOTSTRAP_ISSUER'), 'WEIWU_BOOTSTRAP_ISSUER', false);
  if (issuer !== bootstrapIssuer) throw Error('Bootstrap issuer must exactly match the OIDC issuer');
  const clientId = required(env, 'WEIWU_OIDC_CLIENT_ID');
  const clientSecret = required(env, 'WEIWU_OIDC_CLIENT_SECRET');
  if (placeholder(clientSecret) || repeated(clientSecret)) throw Error('Invalid WEIWU_OIDC_CLIENT_SECRET');
  let secrets: unknown;
  try { secrets = JSON.parse(required(env, 'WEIWU_SESSION_SECRETS')); } catch { throw Error('Invalid WEIWU_SESSION_SECRETS'); }
  if (!Array.isArray(secrets) || secrets.length === 0 || !secrets.every(strongSessionSecret) || new Set(secrets).size !== secrets.length) {
    throw Error('Invalid WEIWU_SESSION_SECRETS');
  }
  return { mode, publicOrigin, issuer, clientId, clientSecret, sessionSecrets: secrets,
    bootstrapIssuer, bootstrapSubject: required(env, 'WEIWU_BOOTSTRAP_SUBJECT') };
}
