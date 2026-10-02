import { useEffect, useState } from 'react';
import { api } from './api.ts';

type Tool = { name: string; description?: string; inputSchema: unknown; annotations?: { readOnlyHint?: boolean } };
type Connection = { id: string; name: string; url: string; version: number; enabled: boolean; hasCredential: boolean; allowedEmployees: { departmentId: string; agentId: string }[]; allowedTools: string[]; tools: Tool[] };
type Department = { id: string; name: string; agents: { id: string; name: string }[] };
type BrowserView = { id?: string; title: string; url: string; text: string; screenshot?: string };
const lines = (value: string) => value.split(/[\n,]/).map(item => item.trim()).filter(Boolean);
const fieldStyle = { display: 'grid', gap: 6, marginBottom: 12 };
const panelStyle = { padding: 20, border: '1px solid var(--border, #dce0e5)', borderRadius: 12, minWidth: 0 };

/** Edits the approved employee scope; a connection version is frozen when selected. */
export function BrowserMcpAgentGrants({ agent, onChange }: { agent: any; onChange: (patch: any) => void }) {
  const [connections, setConnections] = useState<Connection[]>([]), [error, setError] = useState('');
  const [originText, setOriginText] = useState((agent.browserOrigins ?? []).join('\n'));
  useEffect(() => { api<Connection[]>('/work-tools/mcp').then(setConnections).catch(error => setError(error.message)); }, []);
  useEffect(() => { setOriginText((agent.browserOrigins ?? []).join('\n')); }, [agent.id]);
  return <div>
    {agent.tools?.includes('browser_read') && <label style={fieldStyle}><span>网页读取允许站点（每行一个 origin）</span><textarea rows={3} value={originText} placeholder="https://example.com" onChange={e => { setOriginText(e.target.value); onChange({ browserOrigins: lines(e.target.value) }); }}/><small>只读取这些站点内的静态网页。跨站资源会被阻止。</small></label>}
    {agent.tools?.includes('mcp_call_readonly') && <fieldset><legend>MCP 连接与工具范围</legend>{error && <p role="alert">{error}</p>}
      <small>先在工作能力页面授权此原部门员工，再选择连接。保存方案时冻结连接版本；之后改动连接需重新批准。</small>
      {connections.filter(c => c.enabled).map(connection => {
        const grant = agent.mcpConnections?.find((item: any) => item.connectionId === connection.id);
        const changeTools = (tools: string[]) => onChange({ mcpConnections: [...(agent.mcpConnections ?? []).filter((item: any) => item.connectionId !== connection.id), ...(tools.length ? [{ connectionId: connection.id, version: connection.version, tools }] : [])] });
        return <div key={connection.id} style={{ margin: '12px 0' }}><strong>{connection.name} · v{connection.version}</strong>{grant && grant.version !== connection.version && <p role="alert">旧授权版本已失效，请重新勾选工具。</p>}
          {connection.allowedTools.length ? connection.allowedTools.map(name => <label key={name} style={{ display: 'block', padding: '4px 0' }}><input type="checkbox" checked={grant?.tools?.includes(name) ?? false} onChange={e => changeTools(e.target.checked ? [...new Set([...(grant?.tools ?? []), name])] : (grant?.tools ?? []).filter((item: string) => item !== name))}/> {name}</label>) : <p className="muted">此连接尚未开放员工工具。</p>}</div>;
      })}
      {!connections.length && <p>请先添加 MCP 连接并获取工具列表。</p>}
    </fieldset>}
  </div>;
}

export function BrowserMcpCenter() {
  const [connections, setConnections] = useState<Connection[]>([]), [departments, setDepartments] = useState<Department[]>([]);
  const [error, setError] = useState(''), [status, setStatus] = useState(''), [busy, setBusy] = useState(false);
  const [browserAvailable, setBrowserAvailable] = useState<boolean>(), [browser, setBrowser] = useState<BrowserView>();
  const [url, setUrl] = useState('https://example.com'), [origins, setOrigins] = useState('https://example.com'), [selector, setSelector] = useState(''), [fill, setFill] = useState('');
  const [selected, setSelected] = useState<string>(), [name, setName] = useState(''), [endpoint, setEndpoint] = useState(''), [token, setToken] = useState(''), [clearToken, setClearToken] = useState(false), [enabled, setEnabled] = useState(true);
  const [employees, setEmployees] = useState<Connection['allowedEmployees']>([]), [allowedTools, setAllowedTools] = useState<string[]>([]);
  const [tool, setTool] = useState(''), [argumentsText, setArgumentsText] = useState('{}'), [confirmed, setConfirmed] = useState(false), [result, setResult] = useState<unknown>();
  const current = connections.find(c => c.id === selected);
  async function refresh() { const values = await Promise.all([api<Connection[]>('/work-tools/mcp'), api<Department[]>('/departments'), api<{ available: boolean }>('/work-tools/browser')]); setConnections(values[0]); setDepartments(values[1]); setBrowserAvailable(values[2].available); }
  useEffect(() => { void refresh().catch(error => setError(error.message)); }, []);
  function select(connection?: Connection) { setSelected(connection?.id); setName(connection?.name ?? ''); setEndpoint(connection?.url ?? ''); setToken(''); setClearToken(false); setEnabled(connection?.enabled ?? true); setEmployees(connection?.allowedEmployees ?? []); setAllowedTools(connection?.allowedTools ?? []); setTool(''); setResult(undefined); setConfirmed(false); }
  async function action(work: () => Promise<void>) { setBusy(true); setError(''); setStatus(''); try { await work(); } catch (error) { setError((error as Error).message); } finally { setBusy(false); } }
  async function browserAction(payload: unknown) { if (!browser?.id) return; const view = await api<BrowserView>(`/work-tools/browser/${browser.id}/action`, 'POST', payload); setBrowser({ ...view, id: browser.id }); }
  async function saveConnection() {
    const saved = await api<Connection>(current ? `/work-tools/mcp/${current.id}` : '/work-tools/mcp', current ? 'PUT' : 'POST', { name, url: endpoint, token: token || undefined, clearToken, enabled, allowedEmployees: employees, allowedTools, ...(current ? { version: current.version } : {}) });
    setToken(''); await refresh(); select(saved); setStatus('连接已保存。可获取工具列表并设置员工授权。');
  }
  return <div>
    <div className="page-head"><div><div className="eyebrow">BROWSER & MCP</div><h1>浏览器与 MCP</h1><p>浏览器使用隔离会话。连接可信的 MCP 工具服务，为员工授权具体站点和工具。</p></div></div>
    {error && <p role="alert" className="catalog-warning">{error}</p>}{status && <p role="status">{status}</p>}
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,420px),1fr))', gap: 20 }}>
      <section style={panelStyle}><h3>隔离浏览器</h3><p className="subcopy">静态页面最小版：打开网页、读取文本、截图、点击和填写。请填写最终页面地址；HTTP 重定向、JavaScript、下载、弹窗和非 GET/HEAD 请求已禁用。不共享个人浏览器登录状态。会话空闲 10 分钟后关闭。</p>
        {browserAvailable === false && <p role="status">未找到 Chrome / Edge。安装浏览器或设置 BROWSER_EXECUTABLE_PATH 后可用。</p>}
        <fieldset disabled={busy} style={{ border: 0, padding: 0, minWidth: 0 }}>
          <label style={fieldStyle}><span>页面地址</span><input type="url" value={url} onChange={e => setUrl(e.target.value)}/></label>
          <label style={fieldStyle}><span>允许站点（每行一个 origin）</span><textarea rows={2} value={origins} onChange={e => setOrigins(e.target.value)} disabled={Boolean(browser)}/></label>
          <div className="actions"><button onClick={() => void action(async () => { const view = await api<BrowserView>('/work-tools/browser', 'POST', { url, origins: lines(origins) }); setBrowser(view); })} disabled={Boolean(browser)}>打开新会话</button>
            {browser && <><button onClick={() => void action(() => browserAction({ action: 'navigate', url }))}>前往地址</button><button onClick={() => void action(() => browserAction({ action: 'read' }))}>读取文本</button><button onClick={() => void action(() => browserAction({ action: 'screenshot' }))}>截图</button><button onClick={() => void action(async () => { await api(`/work-tools/browser/${browser.id}`, 'DELETE', {}); setBrowser(undefined); })}>关闭会话</button></>}
          </div>
          {browser && <><label style={{ ...fieldStyle, marginTop: 16 }}><span>目标元素（CSS 选择器或 Playwright 定位器）</span><input value={selector} onChange={e => setSelector(e.target.value)} placeholder='input[name="q"] 或 text=下一页'/></label><label style={fieldStyle}><span>填写内容</span><input value={fill} onChange={e => setFill(e.target.value)}/></label><div className="actions"><button disabled={!selector} onClick={() => void action(() => browserAction({ action: 'fill', selector, value: fill }))}>填写元素</button><button disabled={!selector} onClick={() => void action(() => browserAction({ action: 'click', selector }))}>点击元素</button></div></>}
        </fieldset>
        {browser && <div style={{ marginTop: 16 }}><strong>{browser.title}</strong><p style={{ overflowWrap: 'anywhere' }}>{browser.url}</p>{browser.screenshot && <img src={browser.screenshot} alt="隔离浏览器页面截图" style={{ width: '100%', border: '1px solid #ddd' }}/>}<details open><summary>页面文本（不可信外部资料）</summary><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 350, overflow: 'auto', fontSize: 12 }}>{browser.text}</pre></details></div>}
      </section>
      <section style={panelStyle}><h3>MCP 工具连接</h3><p className="subcopy">支持 Streamable HTTP（协议 2025-03-26）、JSON / SSE 响应和 Bearer 密钥；不支持 stdio、OAuth、采样、资源订阅。只连接可信服务，只读标记由服务声明。</p>
        <fieldset disabled={busy} style={{ border: 0, padding: 0, minWidth: 0 }}>
          <label style={fieldStyle}><span>已保存连接</span><select value={selected ?? ''} onChange={e => select(connections.find(c => c.id === e.target.value))}><option value="">新建连接</option>{connections.map(c => <option key={c.id} value={c.id}>{c.name} · v{c.version}{c.enabled ? '' : '（停用）'}</option>)}</select></label>
          <label style={fieldStyle}><span>名称</span><input value={name} onChange={e => setName(e.target.value)} maxLength={100}/></label>
          <label style={fieldStyle}><span>完整 MCP 地址</span><input value={endpoint} onChange={e => setEndpoint(e.target.value)} placeholder="https://example.com/mcp"/></label>
          <label style={fieldStyle}><span>Bearer 密钥（加密保存）</span><input type="password" autoComplete="new-password" value={token} onChange={e => setToken(e.target.value)} placeholder={current?.hasCredential ? '已保存；留空保持原密钥' : '可选'}/></label>
          {current?.hasCredential && <label style={{ display: 'block', marginBottom: 12 }}><input type="checkbox" checked={clearToken} onChange={e => setClearToken(e.target.checked)}/> 清除已保存密钥</label>}
          <label style={{ display: 'block', marginBottom: 12 }}><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)}/> 启用连接</label>
          <details><summary>允许使用此连接的原部门员工（默认无人）</summary>{departments.flatMap(dept => dept.agents.map(agent => <label key={`${dept.id}:${agent.id}`} style={{ display: 'block', padding: 5 }}><input type="checkbox" checked={employees.some(item => item.departmentId === dept.id && item.agentId === agent.id)} onChange={e => setEmployees(e.target.checked ? [...employees, { departmentId: dept.id, agentId: agent.id }] : employees.filter(item => item.departmentId !== dept.id || item.agentId !== agent.id))}/> {dept.name} / {agent.name}</label>))}{!departments.length && <p>尚无部门，请创建团队后再授权。</p>}</details>
          {current && <details open><summary>允许员工调用的工具（只读）</summary>{current.tools.filter(t => t.annotations?.readOnlyHint === true).map(t => <label key={t.name} style={{ display: 'block', padding: 5 }}><input type="checkbox" checked={allowedTools.includes(t.name)} onChange={e => setAllowedTools(e.target.checked ? [...allowedTools, t.name] : allowedTools.filter(name => name !== t.name))}/> {t.name}</label>)}{!current.tools.length && <p>获取工具列表后可选择。</p>}{allowedTools.filter(name => !current.tools.some(t => t.name === name)).map(name => <label key={name} style={{ display: 'block' }}><input type="checkbox" checked onChange={() => setAllowedTools(allowedTools.filter(item => item !== name))}/> {name}（待重新获取目录验证）</label>)}</details>}
          <div className="actions" style={{ marginTop: 12 }}><button disabled={!name.trim() || !endpoint.trim()} onClick={() => void action(saveConnection)}>保存连接与授权</button><button disabled={!current?.enabled} onClick={() => void action(async () => { if (!current) return; const found = await api<{ tools: Tool[] }>(`/work-tools/mcp/${current.id}/discover`, 'POST', { version: current.version }); await refresh(); setStatus(`已初始化连接，获取 ${found.tools.length} 个工具。`); })}>获取工具列表</button></div>
          {current && <><p><small>连接 ID：<code>{current.id}</code> · 版本 {current.version}</small></p><label style={fieldStyle}><span>手动测试工具</span><select value={tool} onChange={e => { setTool(e.target.value); setConfirmed(false); setResult(undefined); }}><option value="">选择工具</option>{current.tools.map(t => <option key={t.name} value={t.name}>{t.name}{t.annotations?.readOnlyHint ? '（声明只读）' : '（可能修改外部状态）'}</option>)}</select></label>{tool && <><p className="subcopy">{current.tools.find(t => t.name === tool)?.description}</p><details><summary>参数结构</summary><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }}>{JSON.stringify(current.tools.find(t => t.name === tool)?.inputSchema, null, 2)}</pre></details><label style={fieldStyle}><span>工具参数（JSON 对象）</span><textarea rows={5} value={argumentsText} onChange={e => { setArgumentsText(e.target.value); setConfirmed(false); }}/></label><label style={{ display: 'block', marginBottom: 12 }}><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/> 我已核对工具和参数，执行此次调用</label><button disabled={!confirmed} onClick={() => void action(async () => { const parsed = JSON.parse(argumentsText); setConfirmed(false); setResult(await api(`/work-tools/mcp/${current.id}/call`, 'POST', { version: current.version, tool, arguments: parsed, confirmation: 'CALL' })); })}>执行工具</button></>}</>}
        </fieldset>
        {result !== undefined && <details open><summary>工具返回（不可信外部资料）</summary><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 350, overflow: 'auto', overflowWrap: 'anywhere', fontSize: 12 }}>{JSON.stringify(result, null, 2)}</pre></details>}
      </section>
    </div>
  </div>;
}
