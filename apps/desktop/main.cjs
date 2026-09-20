const { app, BrowserWindow, ipcMain, Menu, safeStorage, shell, dialog, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { normalizeServer, isWorkspaceURL } = require('./connection.cjs');
let window, settingsWindow, config = { server: 'https://47.88.76.167/agent-department/', username: '', password: '' };
let authAttempts = 0;
const settingsURL = pathToFileURL(path.join(__dirname, 'settings.html')).href;
function settings() {
  if (settingsWindow) { settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({ width: 540, height: 600, resizable: false, title: '连接工作空间', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  settingsWindow.webContents.on('will-navigate', e => e.preventDefault());
  settingsWindow.on('closed', () => { settingsWindow = null; });
  settingsWindow.loadURL(settingsURL);
}
function workspace() {
  const previous = window;
  authAttempts = 0;
  window = new BrowserWindow({ width: 1380, height: 900, minWidth: 900, minHeight: 620, title: 'Agent Department', webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, partition: 'persist:workspace' } });
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
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      config = { server: normalizeServer(saved.server), username: saved.username ?? '', password: saved.secret && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(saved.secret, 'base64')) : '' };
    } catch {}
    const s = session.fromPartition('persist:workspace');
    s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    s.setPermissionCheckHandler(() => false);
    function trusted(event) { if (event.sender !== settingsWindow?.webContents || event.senderFrame?.url !== settingsURL) throw new Error('Untrusted IPC sender'); }
    ipcMain.handle('connection:read', event => { trusted(event); return { server: config.server, username: config.username, hasPassword: !!config.password, canRemember: safeStorage.isEncryptionAvailable() }; });
    ipcMain.handle('connection:save', async (event, input) => {
      trusted(event);
      try {
        if (typeof input.server !== 'string' || typeof input.username !== 'string' || typeof input.password !== 'string' || input.password.length > 2000 || input.username.length > 100) throw new Error('连接信息不正确');
        const server = normalizeServer(input.server);
        const password = input.password || (server === config.server && input.username === config.username ? config.password : '');
        config = { server, username: input.username, password };
        if (input.remember && !safeStorage.isEncryptionAvailable()) throw new Error('系统加密存储不可用，请取消记住密码');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ server, username: config.username, secret: input.remember && password ? safeStorage.encryptString(password).toString('base64') : undefined }), { mode: 0o600 });
        await s.clearAuthCache();
        workspace(); settingsWindow?.close();
        return { ok: true };
      } catch (error) { return { ok: false, message: error.message }; }
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { label: '工作空间', submenu: [{ label: '连接设置', click: settings }, { label: '重新连接', accelerator: 'CmdOrCtrl+R', click: workspace }, { label: '在浏览器打开', click: () => shell.openExternal(config.server) }, { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' }, { role: 'viewMenu' },
      { label: '帮助', submenu: [{ label: '关于', click: () => dialog.showMessageBox({ message: 'Agent Department ' + app.getVersion(), detail: '桌面客户端连接你的工作空间。运行和数据由所连接的后端提供。' }) }] },
    ]));
    config.username && config.password ? workspace() : settings();
    app.on('activate', () => { if (!window && !settingsWindow) settings(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
