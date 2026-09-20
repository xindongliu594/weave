const form = document.querySelector('form');
const fields = Object.fromEntries(['server','username','password','remember','error'].map(id => [id,document.getElementById(id)]));
window.connection.read().then(c => { fields.server.value=c.server; fields.username.value=c.username; fields.remember.disabled=!c.canRemember; fields.remember.checked=c.canRemember; });
form.addEventListener('submit', async e => {
  e.preventDefault(); fields.error.textContent=''; form.querySelector('button').disabled=true;
  try { const result=await window.connection.save({server:fields.server.value,username:fields.username.value,password:fields.password.value,remember:fields.remember.checked}); if(!result.ok) fields.error.textContent=result.message; }
  catch { fields.error.textContent='无法保存连接，请重试。'; }
  finally { form.querySelector('button').disabled=false; }
});
