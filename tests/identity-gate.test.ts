import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {IdentityGate} from '../apps/web/src/IdentityGate.tsx';
import {identitySession} from '../apps/web/src/identity-session.ts';

test('business subtree mounts only for local owner and active administrator',async()=>{
 const original=globalThis.fetch;
 try{for(const [value,allowed,text] of [
  [{mode:'legacy-local',authenticated:true,user:null,csrf:null,loginAvailable:false},true,'本机单人模式'],
  [{mode:'oidc',authenticated:false,user:null,csrf:'fixture',loginAvailable:true},false,'登录'],
  [{mode:'oidc',authenticated:true,user:{id:'admin',displayName:'Test admin',email:null,status:'active',orgRole:'admin'},csrf:'fixture',loginAvailable:true},true,'Test admin'],
  ...(['pending','disabled','active'] as const).map((status):[unknown,boolean,string]=>[{mode:'oidc',authenticated:status==='active',user:{id:'fixture',displayName:'Test member',email:null,status,orgRole:'member'},csrf:'fixture',loginAvailable:true},false,status==='pending'?'等待管理员开通':status==='disabled'?'账号已停用':'成员工作空间尚未开放']),
 ] as const){globalThis.fetch=async()=>Response.json(value);await identitySession.refresh();const html=renderToStaticMarkup(createElement(IdentityGate,{children:createElement('p',null,'private-business')}));assert.equal(html.includes('private-business'),allowed);assert.ok(html.includes(text),text);}
 globalThis.fetch=async()=>{throw Error('offline');};await identitySession.refresh();assert.doesNotMatch(renderToStaticMarkup(createElement(IdentityGate,{children:'private-business'})),/private-business/);
 }finally{globalThis.fetch=original;}
});
