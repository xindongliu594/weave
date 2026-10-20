import React, {useSyncExternalStore, type ReactNode} from 'react';
import {identityAuthorized,identitySession} from './identity-session.ts';

export function IdentityGate({children}:{children:ReactNode}) {
 const state=useSyncExternalStore(identitySession.subscribe,identitySession.getSnapshot,identitySession.getSnapshot);
 const user=state.session?.user;
 const logout=<button disabled={state.busy} onClick={()=>void identitySession.logout()}>退出登录</button>;
 if(identityAuthorized(state))return <React.Fragment key={state.generation}><div className="identity-bar"><span>{state.status==='local-owner'?'本机单人模式':user?.displayName||user?.email||'已登录管理员'}</span>{state.status!=='local-owner'&&logout}</div>{children}</React.Fragment>;
 const content=({loading:['正在确认登录状态','确认后再加载工作空间。'],pending:['等待管理员开通','身份已确认，账号尚未获准进入工作空间。'],disabled:['账号已停用','请联系管理员确认账号状态。'],member:['成员工作空间尚未开放','当前版本仅开放管理员入口，部门成员权限仍在接入。'],unavailable:['登录服务暂不可用','未能确认身份，工作空间已暂停加载。'],'signed-out':['登录为伍','使用公司账号进入工作空间。']} as Record<string,string[]>)[state.status]??['登录为伍','请确认身份后继续。'];
 return <main className="identity-screen"><section className="panel padded"><span className="organization-kicker">为伍 · 团队工作台</span><h1>{content[0]}</h1><p>{content[1]}</p>{state.error&&<p role="alert">{state.error}</p>}<div className="row">{state.status==='signed-out'&&<button className="primary" disabled={state.busy||!state.session?.loginAvailable} onClick={()=>void identitySession.login()}>使用公司账号登录</button>}{state.status!=='loading'&&<button disabled={state.busy} onClick={()=>void identitySession.refresh()}>刷新登录状态</button>}{user&&logout}</div></section></main>;
}
