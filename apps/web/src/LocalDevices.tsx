import {useEffect,useState} from 'react';
import type {Policy,ExecutionBackend} from '../../../packages/contracts/index.ts';
import {api} from './api.ts';
type Device={id:string;name:string;platform:string;grantId:string;label:string;allowCommands:boolean;enabled:boolean;online:boolean;backend?:ExecutionBackend};
const platform=(value:string)=>({win32:'Windows',darwin:'macOS',linux:'Linux'}[value]??value);
const environment=(device:Device)=>device.backend?.kind==='openshell'?'OpenShell 隔离执行':'系统用户权限执行';
export function ExecutionTarget({policy,onChange}:{policy:Policy;onChange?:(value:Policy)=>void}){
 const [devices,setDevices]=useState<Device[]>([]),[error,setError]=useState('');
 async function refresh(){try{setDevices(await api<Device[]>('/local-devices'));setError('');}catch(e){setError((e as Error).message);}}
 useEffect(()=>{void refresh();},[]);
 const target=policy.executionTarget,value=target?.kind==='local'?target.deviceId+':'+target.grantId:'server';
 const current=target?.kind==='local'?devices.find(d=>d.id===target.deviceId&&d.grantId===target.grantId&&d.enabled):undefined;
 const approvedOpenShell=target?.kind==='local'&&target.backend?.kind==='openshell';
 return <div className="lower-small"><label className="field">文件与命令执行位置{onChange?<select value={value} onChange={event=>{const [deviceId,grantId]=event.target.value.split(':');const device=devices.find(d=>d.id===deviceId&&d.grantId===grantId);onChange({...policy,executionTarget:deviceId==='server'?{kind:'server'}:{kind:'local',deviceId,grantId,...(device?.backend?{backend:device.backend}:{})}});}}><option value="server">后端隔离工作区（Docker）</option>{devices.filter(d=>d.enabled).map(d=><option key={d.id} value={d.id+':'+d.grantId} disabled={!d.online}>{d.name} · {environment(d)} · {d.label}{d.online?'':'（离线）'}</option>)}{target?.kind==='local'&&!current&&<option value={value} disabled>原设备或目录授权已失效，请重新选择</option>}</select>:<strong>{target?.kind==='local'?(current?current.name+' · '+environment(current)+' · '+current.label:'已批准的执行设备（'+target.deviceId+'）'):'后端隔离工作区（Docker）'}</strong>}</label>
 <p className="subcopy">每次运行使用独立工作区，交付物回传验收，命令仍需逐次批准。{current?.backend?.kind==='openshell'?'当前设备的文件与命令在 OpenShell 沙箱内执行；模型调用和任务协调由后端管理。':approvedOpenShell?'已批准 OpenShell 隔离执行；设备当前不可用，请刷新设备并检查原授权。':target?.kind==='local'?'当前设备的命令以系统用户权限执行，可访问工作区外的资源。':'后端在受限 Docker 工作区执行文件与命令。'}</p>{onChange&&<button type="button" onClick={()=>void refresh()}>刷新设备</button>}{error&&<p role="alert">{error}</p>}</div>;
}
export function LocalDevices(){
 const [devices,setDevices]=useState<Device[]>([]),[error,setError]=useState('');
 async function refresh(){try{setDevices(await api<Device[]>('/local-devices'));setError('');}catch(e){setError((e as Error).message);}}
 useEffect(()=>{void refresh();const timer=setInterval(()=>void refresh(),5000);return()=>clearInterval(timer);},[]);
 return <section className="panel padded lower"><div className="section-title"><h2>执行设备</h2><button onClick={()=>void refresh()}>刷新设备</button></div><p>网页启动器会注册已配置的执行设备。在项目策略中选择文件与命令的执行位置，后端管理模型、预算与运行档案。</p>{error&&<p role="alert">{error}</p>}{!devices.length&&<p className="subcopy">尚未启用执行设备。</p>}{devices.map(device=><div className="knowledge-result" key={device.id}><strong>{device.name} · {platform(device.platform)} · {environment(device)}</strong><p>{device.label} · {device.enabled?(device.online?'在线':'离线'):'已停用'} · {device.allowCommands?'命令需逐次批准':'仅文件操作'}</p>{device.enabled&&<button onClick={async()=>{if(!confirm('停用这台设备？在途操作会取消，已发生的修改仍需核对。'))return;try{await api('/local-devices/'+device.id,'DELETE',{});await refresh();}catch(e){setError((e as Error).message);}}}>停用设备</button>}</div>)}</section>;
}
