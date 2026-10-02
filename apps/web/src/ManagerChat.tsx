import { useEffect, useState } from 'react';
import { api } from './api.ts';
import type { Project } from '../../../packages/contracts/index.ts';

type Message = { id: string; content: string; reply?: string; status: string; error?: string; createdAt: string; projectVersion: number };
export function ManagerChat({ project }: { project: Project }) {
  const [messages, setMessages] = useState<Message[]>([]), [content, setContent] = useState(''), [maxCost, setMaxCost] = useState(.02), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const refresh = () => api<Message[]>(`/projects/${project.id}/messages`).then(setMessages);
  useEffect(() => { let active = true; const read = () => api<Message[]>(`/projects/${project.id}/messages`).then(value => { if (active) setMessages(value); }).catch(e => { if (active) setError(e.message); }); void read(); const timer = setInterval(() => void read(), 4000); return () => { active = false; clearInterval(timer); }; }, [project.id]);
  const pending = messages.some(m => ['waiting', 'replying'].includes(m.status));
  async function send() { setBusy(true); setError(''); try { await api(`/projects/${project.id}/messages`, 'POST', { version: project.version, content, maxCost }); setContent(''); await refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  return <section className="panel padded lower manager-chat"><h2>与经理对话</h2><p className="subcopy">讨论需求与进度，历史保留在本项目。运行中消息会等待本轮结束后回复；建议需另行保存为方案并批准。</p>
    <div className="manager-messages" aria-live="polite">{messages.length ? messages.map(m => <article key={m.id}><small>{new Date(m.createdAt).toLocaleString('zh-CN')} · 方案 v{m.projectVersion}</small><p><strong>你：</strong>{m.content}</p>{m.reply && <p><strong>经理：</strong>{m.reply}</p>}<small>{({ waiting: '等待回复（有任务执行时会排队）', replying: '经理正在回复', failed: '回复未完成', cancelled: '已取消等待', replied: '已回复' } as Record<string, string>)[m.status]}</small>{m.error && <p className="form-error">{m.error}</p>}{m.status === 'waiting' && <button onClick={() => void api(`/projects/${project.id}/messages/${m.id}`, 'DELETE', {}).then(refresh).catch(e => setError(e.message))}>取消等待</button>}</article>) : <p>还没有对话。可以先向经理说明需求或询问项目进度。</p>}</div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <label className="field">消息<textarea maxLength={6000} value={content} onChange={e => setContent(e.target.value)} rows={3}/></label>
    <div className="form-grid"><label className="field">本次回复费用上限（USD）<input type="number" min={.000001} max={1} step="any" value={maxCost} onChange={e => setMaxCost(e.target.valueAsNumber)}/></label><button disabled={busy || pending || !content.trim() || !Number.isFinite(maxCost) || maxCost <= 0 || maxCost > 1} onClick={() => void send()}>{busy ? '正在发送…' : '发送给经理'}</button></div><small>发送会使用经理的真实模型，计入项目与每日预算。页面最多展示最近 100 条，模型使用最近 12 轮回复。</small>
  </section>;
}
