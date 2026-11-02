import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { identitySession } from '../apps/web/src/identity-session.ts';

const componentPath = '../apps/web/src/IdentityManagement.tsx';
const { IdentityManagement } = await import(componentPath).catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return { IdentityManagement: () => null };
});
test('local-owner personnel page requests enterprise login without showing mutation controls', async () => {
  const original = globalThis.fetch; let businessCalls = 0;
  try {
    globalThis.fetch = async input => {
      if (String(input).includes('/api/')) businessCalls++;
      return Response.json({ mode: 'legacy-local', authenticated: true, user: null, csrf: null, loginAvailable: false });
    };
    await identitySession.refresh();
    const html = renderToStaticMarkup(createElement(IdentityManagement, { departments: [{ id: 'd', name: '研发部' }] }));
    assert.match(html, /需要企业管理员登录/); assert.doesNotMatch(html, /保存账号|撤销全部会话|授予部门权限/); assert.equal(businessCalls, 0);
  } finally { globalThis.fetch = original; }
});
test('active enterprise administrator sees human permission scope and the remaining member boundary', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ mode: 'oidc', authenticated: true, user: { id: 'admin', displayName: '管理员', email: null, status: 'active', orgRole: 'admin' }, csrf: 'fixture', loginAvailable: true });
    await identitySession.refresh();
    const html = renderToStaticMarkup(createElement(IdentityManagement, { departments: [] }));
    assert.match(html, /真人账号/); assert.match(html, /AI 员工/); assert.match(html, /成员只读入口已开放/);
    assert.match(html, /账号状态筛选/); assert.match(html, /刷新人员资料/);
  } finally { globalThis.fetch = original; }
});
test('member and disabled sessions never render human administration controls', async () => {
  const original = globalThis.fetch;
  try {
    for (const status of ['active', 'disabled'] as const) {
      globalThis.fetch = async () => Response.json({ mode: 'oidc', authenticated: status === 'active', user: { id: 'member', displayName: '成员', email: null, status, orgRole: 'member' }, csrf: 'fixture', loginAvailable: true });
      await identitySession.refresh();
      const html = renderToStaticMarkup(createElement(IdentityManagement, { departments: [] }));
      assert.match(html, /需要企业管理员登录/); assert.doesNotMatch(html, /账号状态筛选|保存账号|撤销全部会话/);
    }
  } finally { globalThis.fetch = original; }
});
