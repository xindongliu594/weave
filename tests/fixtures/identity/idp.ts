import { createServer, request, type Server } from 'node:https';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import express from 'express';
import Provider from 'oidc-provider';
import { PGlite } from '@electric-sql/pglite';
import type pg from 'pg';
import type { CustomFetch } from 'openid-client';
import { migrateIdentity } from '../../../apps/api/src/identity-schema.ts';
import {identityPostgresPool} from './postgres.ts';

// A private fixture; real PostgreSQL requires an explicit guarded test URL.
export async function identityTestPool(): Promise<pg.Pool> {
  if(process.env.IDENTITY_TEST_POSTGRES_URL!==undefined)return identityPostgresPool(process.env.IDENTITY_TEST_POSTGRES_URL);
  const db = await PGlite.create();
  const schema = `oidc_${randomUUID().replaceAll('-', '')}`;
  await db.exec(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}; CREATE TABLE departments(id text PRIMARY KEY)`);
  let tail = Promise.resolve();
  async function lock() {
    const previous = tail; let release!: () => void;
    tail = new Promise<void>(resolve => { release = resolve; }); await previous; return release;
  }
  async function query(sql: string, values?: unknown[]) {
    const params = values?.map(value => value && typeof value === 'object' && !(value instanceof Date) ? JSON.stringify(value) : value);
    const result = params ? await db.query(sql, params) : (await db.exec(sql)).at(-1)!;
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  }
  const pool = {
    async query(sql: string, values?: unknown[]) { const release = await lock(); try { return await query(sql,values); } finally { release(); } },
    async connect() { const release = await lock(); return { query, release }; },
    async end() { await tail; await db.close(); },
  } as unknown as pg.Pool;
  await migrateIdentity(pool); return pool;
}

export async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('listen');
  return `https://127.0.0.1:${address.port}`;
}
export async function stop(server: Server) { server.closeAllConnections(); await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())); }

export async function testIdp() {
  const dir = mkdtempSync(join(tmpdir(),'weiwu-oidc-'));
  writeFileSync(join(dir,'openssl.cnf'),'');
  execFileSync('openssl', ['req','-config',join(dir,'openssl.cnf'),'-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem'),'-days','2','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio:'ignore' });
  const tls = { key: readFileSync(join(dir,'key.pem')), cert: readFileSync(join(dir,'cert.pem')) };
  const app = express(); let unavailable=false;
  app.use((_req,res,next)=>unavailable?res.sendStatus(503):next());
  const server = createServer(tls,app); const issuer = await listen(server);
  const { privateKey } = generateKeyPairSync('rsa',{ modulusLength:2048 });
  const jwk = { ...privateKey.export({format:'jwk'}), kid:'synthetic-idp', use:'sig', alg:'RS256' };
  let subject = 'owner-sub';
  const provider = new Provider(issuer, {
    clients:[{client_id:'weiwu',client_secret:'fixture-client-credential',redirect_uris:['https://weiwu.example/auth/callback'],response_types:['code'],grant_types:['authorization_code'],token_endpoint_auth_method:'client_secret_post'}],
    jwks:{keys:[jwk]}, claims:{openid:['sub'],profile:['name'],email:['email']},
    features:{devInteractions:{enabled:false}},
    interactions:{url:(_ctx,interaction) => `/interaction/${interaction.uid}`},
    findAccount:async (_ctx,id) => ({accountId:id,claims:async () => ({sub:id,name:'Synthetic Human',email:'synthetic@example.test'})}),
  });
  app.get('/interaction/:uid', async (req,res,next) => {
    try {
      await provider.interactionDetails(req,res);
      const grant = new provider.Grant({accountId:subject,clientId:'weiwu'}); grant.addOIDCScope('openid profile email');
      const grantId = await grant.save();
      await provider.interactionFinished(req,res,{login:{accountId:subject},consent:{grantId}},{mergeWithLastSubmission:false});
    } catch(error) { next(error); }
  });
  app.use(provider.callback());
  let fault: 'issuer'|'audience'|'nonce'|'key'|undefined;
  async function fetchTls(input: string | URL | Request, init?: Omit<RequestInit,'body'> & {body?:RequestInit['body']|Uint8Array}): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const headers = Object.fromEntries(new Headers(init?.headers));
    const response = await new Promise<Response>((resolve,reject) => {
      const req = request(url,{ca:tls.cert,method:init?.method ?? 'GET',headers},res => {
        const chunks:Buffer[]=[]; res.on('data',chunk=>chunks.push(chunk)); res.on('end',()=> {
          let body=Buffer.concat(chunks).toString();
          if (fault && url.pathname === '/token' && res.statusCode === 200) {
            const data=JSON.parse(body); const [head,payload] = data.id_token.split('.'); const claims=JSON.parse(Buffer.from(payload,'base64url').toString());
            if(fault==='issuer') claims.iss='https://wrong.example';
            if(fault==='audience') claims.aud='wrong-client';
            if(fault==='nonce') claims.nonce='wrong-nonce';
            const encoded=`${head}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
            const key=fault==='key' ? generateKeyPairSync('rsa',{modulusLength:2048}).privateKey : privateKey;
            data.id_token=`${encoded}.${sign('RSA-SHA256',Buffer.from(encoded),key).toString('base64url')}`; body=JSON.stringify(data);
          }
          const responseHeaders = new Headers();
          for(const [key,value] of Object.entries(res.headers)) if(value) for(const item of Array.isArray(value)?value:[value]) responseHeaders.append(key,item);
          resolve(new Response(body || null,{status:res.statusCode,headers:responseHeaders}));
        });
      }); req.on('error',reject); if(init?.body) req.write(init.body.toString()); req.end();
    }); return response;
  }
  return {issuer,tls,fetchTls,transport:fetchTls as CustomFetch,setUnavailable(value:boolean){unavailable=value;},setSubject(value:string){subject=value;},setFault(value:typeof fault){fault=value;},
    async close(){await stop(server);rmSync(dir,{recursive:true,force:true});}};
}

export function browser(fetchTls: (url:string|URL|Request, init?:RequestInit)=>Promise<Response>) {
  const cookies = new Map<string,string>();
  return { cookies, async request(url:string, init:RequestInit={}) {
    const origin=new URL(url).origin; const headers=new Headers(init.headers);
    if(cookies.has(origin)) headers.set('cookie',cookies.get(origin)!);
    const response=await fetchTls(url,{...init,headers});
    const set=response.headers.getSetCookie(); if(set.length) cookies.set(origin,set.map(value=>value.split(';')[0]).join('; '));
    return response;
  }, async authorize(url:string) {
    for(let step=0;step<10;step++) {
      if(url.startsWith('https://weiwu.example/auth/callback')) return url;
      const response=await this.request(url); const location=response.headers.get('location');
      if(!location) throw Error(`IdP did not redirect (${response.status}): ${await response.text()}`);
      url=new URL(location,url).href;
    } throw Error('IdP redirect loop');
  }};
}
