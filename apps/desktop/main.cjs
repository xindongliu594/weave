const { app, BrowserWindow, ipcMain, Menu, safeStorage, shell, dialog, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { normalizeServer, isWorkspaceURL } = require('./connection.cjs');
const {randomUUID,randomBytes}=require('node:crypto');
const {hostname}=require('node:os');
const {LocalDeviceClient}=require('./local-client.cjs');
if(process.env.AGENT_DESKTOP_TEST_HIDDEN==='1'&&process.env.AGENT_DESKTOP_TEST_PROFILE){fs.mkdirSync(process.env.AGENT_DESKTOP_TEST_PROFILE,{recursive:true});app.setPath('userData',process.env.AGENT_DESKTOP_TEST_PROFILE);}
let window, settingsWindow, config = { server: 'https://47.88.76.167/agent-department/', username: '', password: '' };
let localClient,localPair,selectedRoot,localState={status:'disabled'},startLocal=async()=>{},persistLocal=()=>{},quitting=false;
let authAttempts = 0;
const settingsURL = pathToFileURL(path.join(__dirname, 'settings.html')).href;
function settings() {
  if (settingsWindow) { settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({ width: 600, height: 780, resizable: true, show:process.env.AGENT_DESKTOP_TEST_HIDDEN!=='1', title: '连接与本机执行设置', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  settingsWindow.webContents.on('will-navigate', e => e.preventDefault());
  settingsWindow.on('closed', () => { settingsWindow = null; });
  settingsWindow.loadURL(settingsURL);
}
function workspace() {
  const previous = window;
  authAttempts = 0;
  window = new BrowserWindow({ width: 1380, height: 900, minWidth: 900, minHeight: 620, show:process.env.AGENT_DESKTOP_TEST_HIDDEN!=='1', title: 'Agent Department', webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, partition: 'persist:workspace' } });
  window.webContents.on('will-navigate', (e, url) => { if (!isWorkspaceURL(url, config.server)) e.preventDefault(); });
  window.webContents.on('will-redirect', (e, url) => { if (!isWorkspaceURL(url, config.server)) e.preventDefault(); });
  window.webContents.setWindowOpenHandler(({ url }) => { if (isWorkspaceURL(url, config.server)) void shell.openExternal(url); return { action: 'deny' }; });
  window.webContents.on('did-fail-load', (_e, code, _description, _url, mainFrame) => {
    if (!mainFrame || code === -3) return;
    if (!settingsWindow) settings();
  });
  const current = window;
  current.on('closed', () => { if (window === current) window = null; });
  previous?.close();
  void window.loadURL(config.server).catch(() => {});
  void startLocal();
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { (window ?? settingsWindow)?.show(); (window ?? settingsWindow)?.focus(); });
  app.on('login', (event, contents, details, authInfo, callback) => {
    event.preventDefault();
    if (contents === window?.webContents && !authInfo.isProxy && isWorkspaceURL(details.url, config.server) && config.username && authAttempts++ < 2) callback(config.username, config.password);
    else { callback(); settings(); }
  });
  app.whenReady().then(() => {
    const file = path.join(app.getPath('userData'), 'connection.json');
    const localFile=path.join(app.getPath('userData'),'local-device.json');
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      config = { server: normalizeServer(saved.server), username: saved.username ?? '', password: saved.secret && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(saved.secret, 'base64')) : '' };
    } catch {}
    try{const saved=JSON.parse(fs.readFileSync(localFile,'utf8'));if(saved.secret&&safeStorage.isEncryptionAvailable()){const token=safeStorage.decryptString(Buffer.from(saved.secret,'base64'));if(/^[a-f0-9-]{36}$/.test(saved.id)&&/^[a-f0-9]{64}$/.test(token))localPair={...saved,token};}}catch{}
    persistLocal=()=>{
      if(!localPair)return;
      if(!safeStorage.isEncryptionAvailable())throw Error('本机设备凭证需要系统加密存储');
      if(fs.existsSync(localFile)&&fs.lstatSync(localFile).isSymbolicLink())throw Error('设备凭证文件不能是链接');
      const {token,...saved}=localPair;fs.writeFileSync(localFile,JSON.stringify({...saved,secret:safeStorage.encryptString(token).toString('base64')}),{mode:0o600});
    };
    startLocal=async()=>{
      if(localClient||!localPair?.enabled||localPair.server!==config.server||!config.username||!config.password)return;
      let client;
      try{client=new LocalDeviceClient({connection:config,device:localPair,journalRoot:path.join(app.getPath('userData'),'local-receipts',localPair.id),onState:state=>{localState=state;}});localClient=client;await client.start();}
      catch(error){await client?.close();if(localClient===client)localClient=null;localState={status:'offline',message:error.message};}
    };
    const s = session.fromPartition('persist:workspace');
    s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    s.setPermissionCheckHandler(() => false);
    function trusted(event) { if (event.sender !== settingsWindow?.webContents || event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url !== settingsURL) throw new Error('Untrusted IPC sender'); }
    ipcMain.handle('connection:read', event => { trusted(event); return { server: config.server, username: config.username, hasPassword: !!config.password, canRemember: safeStorage.isEncryptionAvailable() }; });
    ipcMain.handle('connection:save', async (event, input) => {
      trusted(event);
      try {
        if (typeof input.server !== 'string' || typeof input.username !== 'string' || typeof input.password !== 'string' || input.password.length > 2000 || input.username.length > 100) throw new Error('连接信息不正确');
        const server = normalizeServer(input.server);
        const password = input.password || (server === config.server && input.username === config.username ? config.password : '');
        if(localClient){await localClient.close();localClient=null;}
        if(localPair&&server!==localPair.server){localPair.enabled=false;persistLocal();}
        config = { server, username: input.username, password };
        if (input.remember && !safeStorage.isEncryptionAvailable()) throw new Error('系统加密存储不可用，请取消记住密码');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ server, username: config.username, secret: input.remember && password ? safeStorage.encryptString(password).toString('base64') : undefined }), { mode: 0o600 });
        await s.clearAuthCache();
        workspace(); settingsWindow?.close();
        return { ok: true };
      } catch (error) { return { ok: false, message: error.message }; }
    });
    ipcMain.handle('local:read',event=>{trusted(event);return {enabled:!!localPair?.enabled,root:selectedRoot??localPair?.grant?.root??'',name:localPair?.name??hostname(),allowCommands:!!localPair?.grant?.allowCommands,canEnable:safeStorage.isEncryptionAvailable()&&!!config.username&&!!config.password,state:localState};});
    ipcMain.handle('local:choose',async event=>{
      trusted(event);if(localPair?.enabled)throw Error('请先停用当前本机授权，再选择新目录');
      const result=await dialog.showOpenDialog(settingsWindow,{title:'选择本机运行工作区的父目录',properties:['openDirectory']});
      if(!result.canceled&&result.filePaths.length)selectedRoot=fs.realpathSync(result.filePaths[0]);
      return {root:selectedRoot??localPair?.grant?.root??''};
    });
    ipcMain.handle('local:enable',async(event,input)=>{
      trusted(event);
      try{
        if(!safeStorage.isEncryptionAvailable()||!config.username||!config.password)throw Error('请先配置工作空间账号，并启用可用的系统加密存储');
        if(typeof input?.name!=='string'||!input.name.trim()||input.name.length>100||typeof input.allowCommands!=='boolean')throw Error('本机设备配置不正确');
        const root=selectedRoot??localPair?.grant?.root;if(!root)throw Error('请先选择本机目录');
        await localClient?.disable();localClient=null;
        localPair={id:randomUUID(),token:randomBytes(32).toString('hex'),name:input.name.trim(),server:config.server,enabled:true,grant:{id:randomUUID(),root,allowCommands:input.allowCommands}};persistLocal();
        await startLocal();if(localState.status==='offline')throw Error(localState.message);return {ok:true};
      }catch(error){return {ok:false,message:error.message};}
    });
    ipcMain.handle('local:disable',async event=>{trusted(event);await localClient?.disable();localClient=null;if(localPair){localPair.enabled=false;persistLocal();}localState={status:'disabled'};return {ok:true};});
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { label: '工作空间', submenu: [{ label: '连接设置', click: settings }, {label:'本机执行设置',click:settings}, { label: '重新连接', accelerator: 'CmdOrCtrl+R', click: workspace }, { label: '在浏览器打开', click: () => shell.openExternal(config.server) }, { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' }, { role: 'viewMenu' },
      { label: '帮助', submenu: [{ label: '关于', click: () => dialog.showMessageBox({ message: 'Agent Department ' + app.getVersion(), detail: '后端协调模型、预算与运行档案。桌面端可在用户选择的目录下执行获授权的文件和逐次批准的本机命令。' }) }] },
    ]));
    config.username && config.password ? workspace() : settings();
    app.on('activate', () => { if (!window && !settingsWindow) settings(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit',event=>{if(localClient&&!quitting){event.preventDefault();quitting=true;void localClient.close().finally(()=>app.quit());}});
}
