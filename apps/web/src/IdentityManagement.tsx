import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api, ApiError } from './api.ts';
import { identitySession } from './identity-session.ts';

type Department = { id: string; name: string };
type User = { id: string; displayName: string | null; email: string | null; status: 'pending' | 'active' | 'disabled'; orgRole: 'member' | 'admin' | 'auditor'; version: number };
type Membership = { userId: string; role: 'viewer' | 'operator' | 'manager'; canApprove: boolean; version: number };
type Page<T> = { items: T[]; nextCursor: string | null };
type Mutation = (path: string, method: string, body: unknown, message: string, targetId: string) => Promise<void>;
const statusNames = { pending: '待开通', active: '已开通', disabled: '已停用' };
const roleNames = { member: '普通成员', admin: '组织管理员', auditor: '审计员' };
const displayName = (user: User) => user.displayName || user.email || user.id;
const part = encodeURIComponent;
const messageOf = (error: unknown) => error instanceof ApiError && error.status === 409
  ? '资料已变化，请点击“刷新人员资料”核对最新状态后再操作。'
  : error instanceof Error ? error.message : '操作未完成，请刷新并核对当前状态。';

export function IdentityManagement({ departments }: { departments: Department[] }) {
  const identity = useSyncExternalStore(identitySession.subscribe, identitySession.getSnapshot, identitySession.getSnapshot);
  if (identity.status !== 'authenticated' || identity.session?.user?.orgRole !== 'admin') return <section className="panel padded">
    <h1>人员与部门权限</h1><h2>需要企业管理员登录</h2>
    <p>{identity.status === 'local-owner' ? '当前为本机单人模式。企业登录配置完成后，使用企业管理员账号管理真人账号与部门成员。' : '请先确认当前登录状态，使用有效的企业管理员账号进入人员管理。'}</p>
    <p className="subcopy">这里管理真人权限；AI 员工仍在部门配置中管理。</p>
  </section>;
  return <Personnel key={identity.generation} departments={departments} actorId={identity.session.user.id}/>;
}

function Personnel({ departments, actorId }: { departments: Department[]; actorId: string }) {
  const [status, setStatus] = useState(''), [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [users, setUsers] = useState<Page<User>>({ items: [], nextCursor: null }), [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [needsRefresh, setNeedsRefresh] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [revision, setRevision] = useState(0);
  const mutationInFlight = useRef(false), cursor = cursors.at(-1), user = users.items.find(item => item.id === selectedId);
  useEffect(() => {
    const controller = new AbortController(); let current = true;
    setLoading(true);
    const query = new URLSearchParams({ limit: '20', ...(status ? { status } : {}), ...(cursor ? { cursor } : {}) });
    api<Page<User>>(`/identity/users?${query}`, 'GET', undefined, undefined, controller.signal).then(data => {
      if (!current) return;
      setUsers(data); setSelectedId(id => data.items.some(item => item.id === id) ? id : null); setNeedsRefresh(false); setError('');
    }).catch(reason => { if (current) { setError(messageOf(reason)); setNeedsRefresh(true); } })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; controller.abort(); };
  }, [status, cursor, revision]);
  const refresh = () => { setLoading(true); setRevision(value => value + 1); };
  const mutate: Mutation = async (path, method, body, message, targetId) => {
    if (mutationInFlight.current || loading || needsRefresh) return;
    mutationInFlight.current = true; setBusy(true); setError(''); setNotice('');
    try {
      await api(path, method, body);
      setNotice(message);
      if (targetId === actorId) {
        await identitySession.refresh();
        if (identitySession.getSnapshot().status !== 'authenticated') return;
      }
      // Membership changes advance the user's CAS version too; fetch it before allowing another edit.
      refresh();
    } catch (reason) { setError(messageOf(reason)); setNeedsRefresh(true); }
    finally { mutationInFlight.current = false; setBusy(false); }
  };
  const disabled = busy || loading || needsRefresh;
  return <>
    <div className="page-head"><div><div className="eyebrow">PEOPLE & ACCESS</div><h1>人员与部门权限</h1><p>开通真人账号，分配组织角色与部门权限。</p></div>
      <button disabled={busy || loading} onClick={refresh}>刷新人员资料</button></div>
    <div className="notice-box"><p>这里管理真人账号，与部门中的 AI 员工分别授权。成员只读入口已开放部门、项目和运行概要；资源读取由后端逐次校验，执行、审批与管理入口仍在接入。</p></div>
    {error && <div className="banner error lower" role="alert">{error} 未自动重试，请先刷新核对。</div>}
    {notice && <div className="banner lower" role="status">{notice}</div>}
    <div className="product-columns lower">
      <section className="panel padded" aria-label="真人账号列表"><h2>真人账号</h2>
        <label className="field">账号状态筛选<select value={status} disabled={busy || loading} onChange={event => { setStatus(event.target.value); setCursors([null]); setSelectedId(null); }}>
          <option value="">全部状态</option><option value="pending">待开通</option><option value="active">已开通</option><option value="disabled">已停用</option>
        </select></label>
        {loading ? <p role="status">正在读取人员资料…</p> : users.items.length ? users.items.map(item => <div className="document-row" key={item.id}>
          <div><strong>{displayName(item)}</strong><small>{item.email || item.id}</small><small>{statusNames[item.status]} · {roleNames[item.orgRole]}{item.id === actorId ? ' · 当前账号' : ''}</small></div>
          <button aria-label={`管理 ${displayName(item)}`} aria-pressed={selectedId === item.id} disabled={busy || needsRefresh} onClick={() => setSelectedId(item.id)}>管理</button>
        </div>) : <p>此状态下没有账号。新用户首次企业登录后会进入待开通列表。</p>}
        <div className="row lower" aria-label="人员列表分页"><button disabled={busy || loading || cursors.length === 1} onClick={() => { setCursors(values => values.slice(0, -1)); setSelectedId(null); }}>上一页</button>
          <span>第 {cursors.length} 页</span><button disabled={busy || loading || !users.nextCursor} onClick={() => { setCursors(values => [...values, users.nextCursor]); setSelectedId(null); }}>下一页</button></div>
      </section>
      <section className="panel padded" aria-label="账号与部门授权">
        {user ? <><h2>{displayName(user)}</h2><p className="subcopy">{user.email || user.id} · {statusNames[user.status]}</p>
          <UserEditor key={`${user.id}:${user.version}`} user={user} disabled={disabled} mutate={mutate}/>
          <DepartmentGrant key={user.id} user={user} departments={departments} disabled={disabled} revision={revision} mutate={mutate}/>
        </> : <><h2>选择一个真人账号</h2><p>从左侧选择账号，核对组织角色和部门授权。员工提示词、模型及工具配置仍在部门页面管理。</p></>}
      </section>
    </div>
  </>;
}

function UserEditor({ user, disabled, mutate }: { user: User; disabled: boolean; mutate: Mutation }) {
  const [role, setRole] = useState(user.orgRole), path = `/identity/users/${part(user.id)}`;
  return <div>
    <form onSubmit={event => { event.preventDefault(); void mutate(path, 'PATCH', { version: user.version, orgRole: role }, '组织角色已保存。', user.id); }}>
      <label className="field">组织角色<select disabled={disabled} value={role} onChange={event => setRole(event.target.value as User['orgRole'])}>
        <option value="member">普通成员</option><option value="admin">组织管理员</option><option value="auditor">审计员</option>
      </select><small>组织管理员可管理全组织。普通成员与审计员的业务视图仍在接入。</small></label>
      <button disabled={disabled || role === user.orgRole}>保存账号角色</button>
    </form>
    <div className="row lower" style={{ flexWrap: 'wrap' }}>
      {user.status !== 'active' ? <button className="primary" disabled={disabled} onClick={() => void mutate(path, 'PATCH', { version: user.version, status: 'active' }, '账号已开通。', user.id)}>{user.status === 'pending' ? '开通账号' : '重新开通账号'}</button>
        : <button disabled={disabled} onClick={() => void mutate(path, 'PATCH', { version: user.version, status: 'disabled' }, '账号已停用，原会话失效。', user.id)}>停用账号</button>}
      <button disabled={disabled} onClick={() => void mutate(`${path}/revoke-sessions`, 'POST', { version: user.version }, '该账号的全部旧会话已撤销。', user.id)}>撤销全部会话</button>
    </div>
  </div>;
}

function DepartmentGrant({ user, departments, disabled, revision, mutate }: { user: User; departments: Department[]; disabled: boolean; revision: number; mutate: Mutation }) {
  const [departmentId, setDepartmentId] = useState(''), [grant, setGrant] = useState<Membership | null>(null), [ready, setReady] = useState(false);
  const [role, setRole] = useState<Membership['role']>('viewer'), [canApprove, setCanApprove] = useState(false), [error, setError] = useState('');
  const exists = departments.some(department => department.id === departmentId);
  useEffect(() => {
    const controller = new AbortController(); let current = true;
    setReady(false); setGrant(null); setError(''); setRole('viewer'); setCanApprove(false);
    if (departmentId && exists) void (async () => {
      let cursor: string | null = null, found: Membership | undefined;
      const visited = new Set<string>();
      do {
        const query = new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) });
        const page: Page<Membership> = await api(`/identity/departments/${part(departmentId)}/members?${query}`, 'GET', undefined, undefined, controller.signal);
        found = page.items.find(item => item.userId === user.id); cursor = page.nextCursor;
        if (cursor && visited.has(cursor)) throw Error('部门成员分页未推进，请刷新后核对。');
        if (cursor) visited.add(cursor);
      } while (!found && cursor && current);
      if (current) { setGrant(found ?? null); setRole(found?.role ?? 'viewer'); setCanApprove(found?.canApprove ?? false); setReady(true); }
    })().catch(reason => { if (current) setError(messageOf(reason)); });
    return () => { current = false; controller.abort(); };
  }, [departmentId, exists, user.id, user.version, revision]);
  const path = `/identity/departments/${part(departmentId)}/members/${part(user.id)}`;
  const locked = disabled || !ready || !exists || user.status !== 'active';
  return <div className="lower"><h3>部门成员权限</h3>
    <label className="field">授权部门<select value={exists ? departmentId : ''} disabled={disabled} onChange={event => setDepartmentId(event.target.value)}>
      <option value="">选择部门</option>{departments.map(department => <option value={department.id} key={department.id}>{department.name}</option>)}
    </select></label>
    {!departments.length && <p>尚无部门，请先在部门页面建立部门。</p>}
    {user.status !== 'active' && <p className="subcopy">先开通账号，再分配部门权限。</p>}
    {error && <p className="banner error" role="alert">{error} 请使用页面顶部的刷新按钮。</p>}
    {departmentId && exists && <>
      <p className="subcopy" role="status">{!ready ? '正在核对当前部门授权…' : grant ? '已授予本部门权限。' : '尚未授予本部门权限。'}</p>
      <form onSubmit={event => { event.preventDefault(); if (!locked) void mutate(path, 'PUT', { version: grant?.version ?? 0, role, canApprove }, '部门权限已保存；成员可刷新只读工作台核对可见资源。', user.id); }}>
        <label className="field">部门角色<select value={role} disabled={locked} onChange={event => { const next = event.target.value as Membership['role']; setRole(next); if (next === 'viewer') setCanApprove(false); }}>
          <option value="viewer">查看者</option><option value="operator">操作员</option><option value="manager">部门经理</option>
        </select></label>
        <label className="inline-check"><input type="checkbox" checked={canApprove} disabled={locked || role === 'viewer'} onChange={event => setCanApprove(event.target.checked)}/>允许工具审批</label>
        <p className="subcopy">查看者不能审批。审批标记不包含预算授权，也不改变 AI 员工的工具范围。</p>
        <button className="primary" disabled={locked || !!grant && role === grant.role && canApprove === grant.canApprove}>{grant ? '保存部门权限' : '授予部门权限'}</button>
        {grant && <button type="button" disabled={disabled || !ready} onClick={() => void mutate(path, 'DELETE', { version: grant.version }, '部门权限已撤销。', user.id)}>撤销部门权限</button>}
      </form>
    </>}
  </div>;
}
