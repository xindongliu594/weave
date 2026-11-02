import React,{useEffect,useMemo,useSyncExternalStore} from 'react';
import {identitySession} from './identity-session.ts';
import {createMemberWorkspace,memberPageSize,type MemberWorkspaceState} from './MemberWorkspace-data.ts';

const status=(value:string)=>({running:'执行中',completed:'已完成',failed:'失败',cancelled:'已取消',queued:'排队中',draft:'待完善',approved:'已批准',planning:'规划中',ready:'已就绪'} as Record<string,string>)[value]??value;
export function MemberWorkspace(){
 const identity=useSyncExternalStore(identitySession.subscribe,identitySession.getSnapshot,identitySession.getSnapshot);
 const store=useMemo(()=>createMemberWorkspace(),[]);
 const state=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot);
 // Revalidate successful reads on session refresh; loading/error await completion or user action.
 useEffect(()=>{void store.refreshAutomatically();},[store,identity]);
 return <MemberWorkspaceView state={state} refresh={offsets=>void store.refresh(offsets)}/>;
}

export function MemberWorkspaceView({state,refresh}:{state:MemberWorkspaceState;refresh:(offsets?:Partial<Pick<MemberWorkspaceState,'projectOffset'|'runOffset'>>)=>void}){
 const busy=state.status==='loading';
 function pages(kind:'project'|'run',count:number){const key=kind==='project'?'projectOffset':'runOffset',offset=state[key];return <div className="row"><button disabled={busy||offset===0} onClick={()=>refresh({[key]:Math.max(0,offset-memberPageSize)})}>上一页</button><span>第 {offset/memberPageSize+1} 页</span><button disabled={busy||count<memberPageSize||offset+memberPageSize>1000000} onClick={()=>refresh({[key]:offset+memberPageSize})}>下一页</button></div>;}
 return <main className="identity-screen"><section className="panel padded" aria-busy={busy}>
  <span className="organization-kicker">为伍 · 成员入口</span><h1>成员只读工作台</h1><p>查看当前获授权的部门、项目和运行概要。执行、审批与管理入口仍在接入。</p>
  <button disabled={busy} onClick={()=>refresh()}>刷新授权资源</button>
  {state.error&&<p role="alert">{state.error}</p>}{(busy||state.status==='idle')&&<p role="status">正在读取当前授权资源…</p>}
  <h2>我的部门</h2>{state.departments.map(row=><article key={row.id}><h3>{row.name}</h3><p>{row.description}</p></article>)}{state.status==='ready'&&!state.departments.length&&<p>暂无可访问部门，请联系管理员确认部门授权。</p>}
  <h2>项目</h2>{state.projects.map(row=><article key={row.id}><h3>{row.requirement}</h3><p>{row.departmentName} · {status(row.status)}{row.version!==undefined&&` · v${row.version}`}</p></article>)}{state.status==='ready'&&!state.projects.length&&<p>本页暂无可访问项目。</p>}{pages('project',state.projects.length)}
  <h2>运行概要</h2>{state.runs.map(row=><article key={row.id}><h3>{row.title||row.id}</h3><p>{status(row.status)}{row.createdAt&&` · ${row.createdAt}`}</p><small>运行编号：{row.id}</small></article>)}{state.status==='ready'&&!state.runs.length&&<p>本页暂无可访问运行。</p>}{pages('run',state.runs.length)}
 </section></main>;
}
