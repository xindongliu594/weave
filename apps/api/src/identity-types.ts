export type OrgRole = 'member' | 'admin' | 'auditor';
export type HumanStatus = 'pending' | 'active' | 'disabled';
export type HumanPrincipal = {
  kind: 'human'; userId: string; sessionId: string; issuer: string; subject: string;
  orgRole: OrgRole; sessionEpoch: number; authenticatedAt: string;
};
export type Principal = HumanPrincipal | { kind: 'local-owner' } | { kind: 'device'; deviceId: string }
  | { kind: 'system'; service: string };
export type HumanUser = {
  id: string; issuer: string; subject: string; displayName: string | null; email: string | null;
  status: HumanStatus; orgRole: OrgRole; sessionEpoch: number; version: number;
};
export type IdentityConfig = { mode: 'legacy-local' } | {
  mode: 'oidc'; publicOrigin: string; issuer: string; clientId: string; clientSecret: string;
  sessionSecrets: string[]; bootstrapIssuer: string; bootstrapSubject: string;
};
export type OidcIdentityConfig = Extract<IdentityConfig, { mode: 'oidc' }>;
export const orgRoles: readonly OrgRole[] = ['member', 'admin', 'auditor'];
export const humanStatuses: readonly HumanStatus[] = ['pending', 'active', 'disabled'];

export function identityText(value: unknown, max = 2048): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function principalKey(principal: Principal): string {
  if (!principal || typeof principal !== 'object' || Array.isArray(principal)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(principal))) throw Error('Invalid principal');
  const p = principal as unknown as Record<string, unknown>;
  const keys = (allowed: string[]) => Reflect.ownKeys(p).every(key => typeof key === 'string' && allowed.includes(key));
  switch (p.kind) {
    case 'local-owner':
      if (keys(['kind'])) return 'legacy-local';
      break;
    case 'device':
      if (keys(['kind', 'deviceId']) && identityText(p.deviceId)) return `device:${p.deviceId}`;
      break;
    case 'system':
      if (keys(['kind', 'service']) && identityText(p.service)) return `system:${p.service}`;
      break;
    case 'human':
      if (keys(['kind', 'userId', 'sessionId', 'issuer', 'subject', 'orgRole', 'sessionEpoch', 'authenticatedAt'])
        && identityText(p.userId) && identityText(p.sessionId) && identityText(p.issuer) && identityText(p.subject)
        && orgRoles.includes(p.orgRole as OrgRole) && Number.isSafeInteger(p.sessionEpoch) && (p.sessionEpoch as number) >= 0
        && identityText(p.authenticatedAt) && Number.isFinite(Date.parse(p.authenticatedAt))) return `human:${p.userId}`;
      break;
  }
  throw Error('Invalid principal');
}
