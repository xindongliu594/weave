import React,{useState,useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {IdentityGate} from '../../../apps/web/src/IdentityGate.tsx';
import {RunCenter} from '../../../apps/web/src/RunCenter.tsx';
import {StorageCenter} from '../../../apps/web/src/StorageCenter.tsx';
import '../../../apps/web/src/styles.css';

const first='10000000-0000-0000-0000-000000000001';
function Fixture(){
 const [storage,setStorage]=useState(location.hash==='#storage');
 useEffect(()=>{const changed=()=>setStorage(location.hash==='#storage');window.addEventListener('hashchange',changed);return()=>window.removeEventListener('hashchange',changed);},[]);
 async function setup(mode:string){await fetch('/__terminal_fixture/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode})});location.reload();}
 return <main style={{maxWidth:1200,margin:'0 auto',padding:24}}>
  <div className="notice-box" role="note">工程隔离验证 · 使用实际网页组件与虚构接口数据 · 无模型调用、无真实沙箱操作</div>
  <nav aria-label="工程验证控制"><a href={'#run/'+first}>运行页</a>{' · '}<a href="#storage">容量页</a>{' · '}<a href="#run/10000000-0000-0000-0000-000000000009">另一运行</a>
   <button onClick={()=>void setup('hold')}>设为原请求待核对</button>
   <button onClick={()=>void fetch('/__terminal_fixture/release',{method:'POST'})}>释放模拟响应</button>
   <button onClick={()=>void setup('denied')}>设为设备授权拒绝</button>
   <button onClick={()=>void setup('no-intent')}>设为没有原意向</button>
   <button onClick={()=>void setup('mismatch')}>设为错运行投影</button>
  </nav>
  {storage?<StorageCenter/>:<RunCenter onOpenProject={()=>{}}/>}
 </main>;
}
createRoot(document.getElementById('root')!).render(<IdentityGate><Fixture/></IdentityGate>);
