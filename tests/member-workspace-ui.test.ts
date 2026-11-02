import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {IdentityGate} from '../apps/web/src/IdentityGate.tsx';
import {identitySession} from '../apps/web/src/identity-session.ts';
import {MemberWorkspaceView} from '../apps/web/src/MemberWorkspace.tsx';

test('active member mounts independent read workspace, auditor and pending remain closed',async()=>{
 const original=globalThis.fetch;
 try{for(const [role,status,label] of [['member','active','成员只读工作台'],['auditor','active','审计员工作空间尚未开放'],['member','pending','等待管理员开通']]){
  globalThis.fetch=async()=>Response.json({mode:'oidc',authenticated:status==='active',user:{id:'synthetic',displayName:'合成身份',email:null,status,orgRole:role},csrf:'fixture',loginAvailable:true});await identitySession.refresh();
  const html=renderToStaticMarkup(createElement(IdentityGate,{children:createElement('p',null,'ADMIN-ONLY')}));assert.match(html,new RegExp(label));assert.doesNotMatch(html,/ADMIN-ONLY|创建部门|保存需求|批准执行|模型网关/);
 }}finally{globalThis.fetch=original;}
});

test('resource view renders read summaries and bounded pagination without action or download links',()=>{
 const html=renderToStaticMarkup(createElement(MemberWorkspaceView,{state:{status:'ready',error:'',projectOffset:100,runOffset:0,departments:[{id:'d',name:'研发部'}],projects:[{id:'p',requirement:'项目成果',status:'draft',version:2}],runs:[{id:'r',title:'交付核对',status:'completed'}]},refresh:()=>{}}));
 for(const value of ['研发部','项目成果','交付核对','已完成','第 2 页'])assert.ok(html.includes(value));assert.doesNotMatch(html,/href=|批准执行|下载|管理人员/);
});
