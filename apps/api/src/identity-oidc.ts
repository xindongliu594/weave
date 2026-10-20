import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import * as oidc from 'openid-client';
import type { OidcIdentityConfig } from './identity-types.ts';

export const identityHash = (value: string) => createHash('sha256').update(value).digest('hex');

export function identityReturnTo(value: unknown): string {
  if (value === undefined) return '/';
  if (typeof value !== 'string' || value.length > 2048) throw Error('Invalid return target');
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { throw Error('Invalid return target'); }
  if (![value,decoded].every(target => target.startsWith('/') && !target.startsWith('//') && !/[\\\u0000-\u001f\u007f]/u.test(target))) throw Error('Invalid return target');
  return value;
}

type LoginRow = { id:string; session_binding_hash:string; state_hash:string; nonce:string; verifier:string;
  issuer:string; client_id:string; redirect_uri:string; return_to:string };

export function createIdentityOidc({ pool, config, transport, now = () => new Date() }: {
  pool:pg.Pool; config:OidcIdentityConfig; transport?:oidc.CustomFetch; now?:()=>Date;
}) {
  const redirectUri = `${config.publicOrigin}/auth/callback`;
  let client: Promise<oidc.Configuration> | undefined;
  let available = false;
  async function getClient() {
    client ??= oidc.discovery(new URL(config.issuer),config.clientId,{client_secret:config.clientSecret},oidc.ClientSecretPost(config.clientSecret),{
      [oidc.customFetch]:transport,execute:[oidc.enableNonRepudiationChecks],timeout:10,
    }).then(result=>{available=true;return result;}).catch(error=>{available=false;client=undefined;throw error;});
    return client;
  }
  return {
    async initialize() { try { await getClient(); } catch { /* An unavailable IdP cannot disable existing sessions. */ } },
    available:()=>available,
    async begin(sid:string, returnTo:unknown):Promise<URL> {
      const target=identityReturnTo(returnTo);const clientConfig=await getClient();
      const state=oidc.randomState(), nonce=oidc.randomNonce(), verifier=oidc.randomPKCECodeVerifier();
      const challenge=await oidc.calculatePKCECodeChallenge(verifier);
      const db=await pool.connect();
      try {
        await db.query('BEGIN');
        // Serialize the per-session cap across every API instance, using the durable initiating SID.
        const owner=await db.query('SELECT sid FROM human_sessions WHERE sid=$1 FOR UPDATE',[sid]);
        if(!owner.rows.length) throw Error('Initiating session is missing');
        const count=await db.query('SELECT count(*) AS count FROM oidc_login_transactions WHERE session_binding_hash=$1 AND consumed_at IS NULL AND expires_at>$2',[identityHash(sid),now()]);
        if(Number(count.rows[0].count)>=3) throw Object.assign(Error('Too many login transactions'),{status:429});
        await db.query(`INSERT INTO oidc_login_transactions(id,session_binding_hash,state_hash,nonce,verifier,issuer,client_id,redirect_uri,return_to,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[randomUUID(),identityHash(sid),identityHash(state),nonce,verifier,config.issuer,config.clientId,redirectUri,target,new Date(now().getTime()+300_000)]);
        await db.query('COMMIT');
      } catch(error) {await db.query('ROLLBACK');throw error;} finally {db.release();}
      return oidc.buildAuthorizationUrl(clientConfig,{redirect_uri:redirectUri,scope:'openid profile email',state,nonce,code_challenge:challenge,code_challenge_method:'S256'});
    },
    async complete(sid:string, query:string) {
      const callback = new URL(`${redirectUri}${query}`);
      const states=callback.searchParams.getAll('state');
      if(states.length!==1 || states[0].length>1024 || !states[0]) throw Error('Invalid callback state');
      const result=await pool.query<LoginRow>(`UPDATE oidc_login_transactions SET consumed_at=$3
        WHERE state_hash=$1 AND session_binding_hash=$2 AND consumed_at IS NULL AND expires_at>$3 RETURNING *`,[identityHash(states[0]),identityHash(sid),now()]);
      const row=result.rows[0];
      if(!row || row.issuer!==config.issuer || row.client_id!==config.clientId || row.redirect_uri!==redirectUri) throw Error('Invalid login transaction');
      // Consume before discovery/exchange: every failure permanently burns this transaction.
      const tokens=await oidc.authorizationCodeGrant(await getClient(),callback,{
        expectedState:states[0],expectedNonce:row.nonce,pkceCodeVerifier:row.verifier,idTokenExpected:true,
      });
      const claims=tokens.claims();
      if(!claims || claims.iss!==config.issuer || typeof claims.sub!=='string' || !claims.sub) throw Error('Missing verified identity');
      return {claims:{issuer:claims.iss,subject:claims.sub,
        ...(typeof claims.name==='string'?{displayName:claims.name}:{}),...(typeof claims.email==='string'?{email:claims.email}:{})},returnTo:identityReturnTo(row.return_to)};
    },
  };
}
