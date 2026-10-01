import {useEffect,useState} from 'react';
import type {Policy} from '../../../packages/contracts/index.ts';
import {api} from './api.ts';
type Device={id:string;name:string;platform:string;grantId:string;label:string;allowCommands:boolean;enabled:boolean;online:boolean};
const platform=(value:string)=>({win32:'Windows',darwin:'macOS',linux:'Linux'}[value]??value);
export function ExecutionTarget({policy,onChange}:{policy:Policy;onChange?:(value:Policy)=>void}){
 const [devices,setDevices]=useState<Device[]>([]),[error,setError]=useState('');
 async function refresh(){try{setDevices(await api<Device[]>('/local-devices'));setError('');}catch(e){setError((e as Error).message);}}
 useEffect(()=>{void refresh();},[]);
 const target=policy.executionTarget,value=target?.kind==='local'?target.deviceId+':'+target.grantId:'server';
 const current=target?.kind==='local'?devices.find(d=>d.id===target.deviceId&&d.grantId===target.grantId&&d.enabled):undefined;
 return <div className="lower-small"><label className="field">文件与命令执行位置{onChange?<select value={value} onChange={event=>{const [deviceId,grantId]=event.target.value.split(':');onChange({...policy,executionTarget:deviceId==='server'?{kind:'server'}:{kind:'local',deviceId,grantId}});}}><option value="server">后端隔离工作区（Docker）</option>{devices.filter(d=>d.enabled).map(d=><option key={d.id} value={d.id+':'+d.grantId} disabled={!d.online}>{d.name} · {platform(d.platform)} · {d.label}{d.online?'':'（离线）'}</option>)}{target?.kind==='local'&&!current&&<option value={value} disabled>原本机设备或目录授权已失效，请重新选择</option>}</select>:<strong>{target?.kind==='local'?(current?current.name+' · '+platform(current.platform)+' · '+current.label:'已批准的本机设备（'+target.deviceId+'）'):'后端隔离工作区（Docker）'}</strong>}</label>
 <p className="subcopy">桌面端选择目录并启用本机执行后，设备才会出现在这里。每次运行使用所选目录下的独立工作区，交付物回传验收。本机命令以当前系统用户权限执行，可访问工作区外的资源，仍需逐次批准。</p>{onChange&&<button type="button" onClick={()=>void refresh()}>刷新本机设备</button>}{error&&<p role="alert">{error}</p>}</div>;
}
export function LocalDevices(){
 const [devices,setDevices]=useState<Device[]>([]),[error,setError]=useState('');
 async function refresh(){try{setDevices(await api<Device[]>('/local-devices'));setError('');}catch(e){setError((e as Error).message);}}
 useEffect(()=>{void refresh();const timer=setInterval(()=>void refresh(),5000);return()=>clearInterval(timer);},[]);
 return <section className="panel padded lower"><div className="section-title"><h2>桌面本机执行设备</h2><button onClick={()=>void refresh()}>刷新设备</button></div><p>在桌面端“工作空间 → 本机执行设置”中选择目录、启用设备，再在项目策略中选择执行位置。后端继续管理模型、预算与运行档案。</p>{error&&<p role="alert">{error}</p>}{!devices.length&&<p className="subcopy">尚未启用本机设备。</p>}{devices.map(device=><div className="knowledge-result" key={device.id}><strong>{device.name} · {platform(device.platform)}</strong><p>{device.label} · {device.enabled?(device.online?'在线':'离线'):'已停用'} · {device.allowCommands?'允许逐次批准的本机命令':'仅文件操作'}</p>{device.enabled&&<button onClick={async()=>{if(!confirm('停用这台设备？在途本机操作会取消，已发生的修改仍需核对。'))return;try{await api('/local-devices/'+device.id,'DELETE',{});await refresh();}catch(e){setError((e as Error).message);}}}>停用设备</button>}</div>)}</section>;
}
