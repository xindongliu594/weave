const form = document.querySelector('form');
const fields = Object.fromEntries(['server','username','password','remember','error'].map(id => [id,document.getElementById(id)]));
window.connection.read().then(c => { fields.server.value=c.server; fields.username.value=c.username; fields.remember.disabled=!c.canRemember; fields.remember.checked=c.canRemember; });
form.addEventListener('submit', async e => {
  e.preventDefault(); fields.error.textContent=''; form.querySelector('button').disabled=true;
  try { const result=await window.connection.save({server:fields.server.value,username:fields.username.value,password:fields.password.value,remember:fields.remember.checked}); if(!result.ok) fields.error.textContent=result.message; }
  catch { fields.error.textContent='无法保存连接，请重试。'; }
  finally { form.querySelector('button').disabled=false; }
});
let initializedLocal=false,localBusy=false;
const localFields=Object.fromEntries(['device-name','local-root','allow-commands','local-status','local-error','choose-root','enable-local','disable-local'].map(id=>[id,document.getElementById(id)]));
async function refreshLocal(){const value=await window.localExecution.read();if(!initializedLocal){localFields['device-name'].value=value.name;localFields['allow-commands'].checked=value.allowCommands;initializedLocal=true;}localFields['local-root'].textContent=value.root||'尚未选择目录';localFields['local-status'].textContent=({disabled:'本机执行未启用',connected:'设备已连接',running:'正在执行获批准的本机操作',offline:'设备离线'}[value.state.status]||value.state.status)+(value.state.message?'：'+value.state.message:'');localFields['enable-local'].disabled=localBusy||value.enabled||!value.canEnable||!value.root;localFields['disable-local'].disabled=localBusy||!value.enabled;localFields['choose-root'].disabled=localBusy||value.enabled;localFields['allow-commands'].disabled=localBusy||value.enabled;if(!value.canEnable)localFields['local-status'].textContent+=' · 先连接工作空间；设备凭证需要系统加密存储。';}
async function localAction(fn){localBusy=true;localFields['local-error'].textContent='';try{const result=await fn();if(result?.ok===false)throw Error(result.message);}catch(error){localFields['local-error'].textContent=error.message;}finally{localBusy=false;await refreshLocal();}}
localFields['choose-root'].addEventListener('click',()=>void localAction(()=>window.localExecution.choose()));
localFields['enable-local'].addEventListener('click',()=>void localAction(()=>window.localExecution.enable({name:localFields['device-name'].value,allowCommands:localFields['allow-commands'].checked})));
localFields['disable-local'].addEventListener('click',()=>void localAction(()=>window.localExecution.disable()));
void refreshLocal();setInterval(()=>void refreshLocal().catch(()=>{}),2000);
