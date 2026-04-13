const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const net = require('net');
const { Client } = require('ssh2');
const { dbManager } = require('./db');

// 存储所有 SSH 连接实例
const sshConnections = new Map();
// 存储所有子窗口
const childWindows = new Map();

let mainWindow;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1a1a2e',
    frame: false,          // 无边框，完全自定义标题栏
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile('renderer/index.html');

  mainWindow.on('closed', () => {
    childWindows.forEach(win => {
      if (!win.isDestroyed()) win.close();
    });
    childWindows.clear();
    sshConnections.forEach((conn) => {
      try { conn.conn.end(); } catch (e) {}
    });
    sshConnections.clear();
    mainWindow = null;
  });
}

// ===================== 窗口控制 IPC =====================
ipcMain.on('win-minimize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.minimize();
});

ipcMain.on('win-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  }
});

ipcMain.on('win-close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.close();
});

// ===================== 连接配置管理 IPC =====================

ipcMain.handle('get-connections', async () => {
  return dbManager.getConnections();
});

ipcMain.handle('save-connection', async (event, conn) => {
  return dbManager.saveConnection(conn);
});

ipcMain.handle('delete-connection', async (event, id) => {
  return dbManager.deleteConnection(id);
});

ipcMain.handle('reorder-connections', async (event, orderedIds) => {
  return dbManager.reorderConnections(orderedIds);
});

ipcMain.handle('get-groups', async () => {
  return dbManager.getGroups();
});

ipcMain.handle('save-group', async (event, group) => {
  return dbManager.saveGroup(group);
});

ipcMain.handle('delete-group', async (event, group) => {
  return dbManager.deleteGroup(group);
});

// ===================== 快捷指令 IPC =====================

ipcMain.handle('get-quick-commands', async () => {
  return dbManager.getQuickCommands();
});

ipcMain.handle('save-quick-command', async (event, cmd) => {
  return dbManager.saveQuickCommand(cmd);
});

ipcMain.handle('delete-quick-command', async (event, id) => {
  return dbManager.deleteQuickCommand(id);
});

// ===================== 数据库设置 IPC =====================

ipcMain.handle('get-db-config', () => {
  return { dbType: dbManager.getDBType(), mysqlConfig: dbManager.getMysqlConfig() };
});

ipcMain.handle('test-mysql', async (event, config) => {
  return dbManager.testMysqlConnection(config);
});

ipcMain.handle('switch-mysql', async (event, config) => {
  return dbManager.switchToMySQL(config);
});

ipcMain.handle('switch-sqlite', async () => {
  return dbManager.switchToSQLite();
});

ipcMain.handle('sync-sqlite-to-mysql', async () => {
  try { return await dbManager.syncSQLiteToMySQL(); }
  catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('sync-mysql-to-sqlite', async () => {
  try { return await dbManager.syncMySQLToSQLite(); }
  catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('export-data', async (event, filePath) => {
  try { return await dbManager.exportToFile(filePath); }
  catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('import-data', async (event, filePath) => {
  try { return await dbManager.importFromFile(filePath); }
  catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('show-save-dialog', async (event, opts) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return dialog.showSaveDialog(win, opts);
});

ipcMain.handle('show-open-dialog', async (event, opts) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return dialog.showOpenDialog(win, opts);
});

ipcMain.handle('get-encrypt-key-status', () => {
  const hasEnvKey = !!process.env.SSH_CLIENT_ENCRYPT_KEY;
  return {
    hasEnvKey,
    envKey: 'SSH_CLIENT_ENCRYPT_KEY'
  };
});

// ===================== SSH 连接 IPC =====================

ipcMain.handle('ssh-connect', async (event, { sessionId, config }) => {
  return new Promise((resolve) => {
    const conn = new Client();
    const sender = event.sender;

    conn.on('ready', () => {
      // ===== X11 转发：监听服务端发来的 X11 通道 =====
      if (config.x11Forwarding) {
        conn.on('x11', (info, accept, reject) => {
          // 解析本地 X Display，格式 "host:display" 或 ":display"
          const displayStr = config.x11Display || 'localhost:0';
          const match = displayStr.match(/^(.*?):(\d+)(\.\d+)?$/);
          let xHost = 'localhost';
          let xPort = 6000;
          if (match) {
            xHost = match[1] || 'localhost';
            xPort = 6000 + parseInt(match[2], 10);
          }
          const xClient = net.createConnection({ host: xHost, port: xPort }, () => {
            const channel = accept();
            xClient.pipe(channel);
            channel.pipe(xClient);
          });
          xClient.on('error', () => { try { reject(); } catch(e) {} });
        });
      }

      const shellOpts = { term: 'xterm-256color', cols: 220, rows: 50 };
      if (config.x11Forwarding) shellOpts.x11 = true;

      conn.shell(shellOpts, (err, stream) => {
        if (err) {
          resolve({ success: false, error: err.message });
          return;
        }

        sshConnections.set(sessionId, { conn, stream });

        stream.on('data', (data) => {
          if (!sender.isDestroyed()) {
            sender.send(`ssh-data-${sessionId}`, data.toString());
          }
        });

        stream.stderr.on('data', (data) => {
          if (!sender.isDestroyed()) {
            sender.send(`ssh-data-${sessionId}`, data.toString());
          }
        });

        stream.on('close', () => {
          if (!sender.isDestroyed()) {
            sender.send(`ssh-close-${sessionId}`);
          }
          sshConnections.delete(sessionId);
        });

        resolve({ success: true });
      });
    });

    conn.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });

    conn.on('end', () => {
      if (!sender.isDestroyed()) {
        sender.send(`ssh-close-${sessionId}`);
      }
    });

    const connectConfig = {
      host: config.host,
      port: config.port || 22,
      username: config.username,
      readyTimeout: 15000,
      keepaliveInterval: 30000
    };

    if (config.authType === 'password') {
      connectConfig.password = config.password;
    } else if (config.authType === 'privateKey') {
      connectConfig.privateKey = config.privateKey;
      if (config.passphrase) connectConfig.passphrase = config.passphrase;
    }

    conn.connect(connectConfig);
  });
});

ipcMain.on('ssh-input', (event, { sessionId, data }) => {
  const session = sshConnections.get(sessionId);
  if (session && session.stream) {
    session.stream.write(data);
  }
});

ipcMain.on('ssh-resize', (event, { sessionId, cols, rows }) => {
  const session = sshConnections.get(sessionId);
  if (session && session.stream) {
    session.stream.setWindow(rows, cols);
  }
});

ipcMain.handle('ssh-disconnect', (event, sessionId) => {
  const session = sshConnections.get(sessionId);
  if (session) {
    try {
      session.stream.close();
      session.conn.end();
    } catch (e) {}
    sshConnections.delete(sessionId);
  }
  return true;
});

// ===================== SFTP IPC =====================

// 存储 SFTP 连接实例（复用 SSH 连接）
const sftpSessions = new Map();

ipcMain.handle('sftp-connect', async (event, { sessionId }) => {
  const session = sshConnections.get(sessionId);
  if (!session || !session.conn) return { success: false, error: '无对应的 SSH 连接' };
  return new Promise((resolve) => {
    session.conn.sftp((err, sftp) => {
      if (err) return resolve({ success: false, error: err.message });
      sftpSessions.set(sessionId, sftp);
      sftp.on('end', () => sftpSessions.delete(sessionId));
      resolve({ success: true });
    });
  });
});

ipcMain.handle('sftp-list', async (event, { sessionId, remotePath }) => {
  const sftp = sftpSessions.get(sessionId);
  if (!sftp) return { success: false, error: 'SFTP 未连接' };
  return new Promise((resolve) => {
    sftp.readdir(remotePath, (err, list) => {
      if (err) return resolve({ success: false, error: err.message });
      const items = list.map(item => ({
        name: item.filename,
        longname: item.longname,
        isDir: item.attrs.isDirectory(),
        isSymlink: item.attrs.isSymbolicLink(),
        size: item.attrs.size,
        mtime: item.attrs.mtime,
        permissions: item.attrs.mode
      }));
      items.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      resolve({ success: true, list: items });
    });
  });
});

ipcMain.handle('sftp-download', async (event, { sessionId, remotePath, localPath }) => {
  const sftp = sftpSessions.get(sessionId);
  if (!sftp) return { success: false, error: 'SFTP 未连接' };
  return new Promise((resolve) => {
    sftp.fastGet(remotePath, localPath, (err) => {
      if (err) return resolve({ success: false, error: err.message });
      resolve({ success: true });
    });
  });
});

ipcMain.handle('sftp-download-dir', async (event, { sessionId, remotePath, localPath }) => {
  const sftp = sftpSessions.get(sessionId);
  if (!sftp) return { success: false, error: 'SFTP 未连接' };
  const fs = require('fs');

  // 递归下载目录
  async function downloadDir(remote, local) {
    await fs.promises.mkdir(local, { recursive: true });
    const list = await new Promise((res, rej) =>
      sftp.readdir(remote, (err, items) => err ? rej(err) : res(items))
    );
    for (const item of list) {
      if (item.filename === '.' || item.filename === '..') continue;
      const rSub = remote.replace(/\/$/, '') + '/' + item.filename;
      const lSub = path.join(local, item.filename);
      if (item.attrs.isDirectory()) {
        await downloadDir(rSub, lSub);
      } else {
        await new Promise((res, rej) =>
          sftp.fastGet(rSub, lSub, err => err ? rej(err) : res())
        );
      }
    }
  }

  try {
    await downloadDir(remotePath, localPath);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('sftp-upload', async (event, { sessionId, localPath, remotePath }) => {
  const sftp = sftpSessions.get(sessionId);
  if (!sftp) return { success: false, error: 'SFTP 未连接' };
  return new Promise((resolve) => {
    sftp.fastPut(localPath, remotePath, (err) => {
      if (err) return resolve({ success: false, error: err.message });
      resolve({ success: true });
    });
  });
});

ipcMain.handle('sftp-mkdir', async (event, { sessionId, remotePath }) => {
  const sftp = sftpSessions.get(sessionId);
  if (!sftp) return { success: false, error: 'SFTP 未连接' };
  return new Promise((resolve) => {
    sftp.mkdir(remotePath, (err) => {
      if (err) return resolve({ success: false, error: err.message });
      resolve({ success: true });
    });
  });
});

ipcMain.handle('sftp-delete', async (event, { sessionId, remotePath, isDir }) => {
  const sftp = sftpSessions.get(sessionId);
  if (!sftp) return { success: false, error: 'SFTP 未连接' };
  return new Promise((resolve) => {
    const op = isDir
      ? (p, cb) => sftp.rmdir(p, cb)
      : (p, cb) => sftp.unlink(p, cb);
    op(remotePath, (err) => {
      if (err) return resolve({ success: false, error: err.message });
      resolve({ success: true });
    });
  });
});

ipcMain.handle('sftp-rename', async (event, { sessionId, oldPath, newPath }) => {
  const sftp = sftpSessions.get(sessionId);
  if (!sftp) return { success: false, error: 'SFTP 未连接' };
  return new Promise((resolve) => {
    sftp.rename(oldPath, newPath, (err) => {
      if (err) return resolve({ success: false, error: err.message });
      resolve({ success: true });
    });
  });
});

ipcMain.handle('sftp-stat', async (event, { sessionId, remotePath }) => {
  const sftp = sftpSessions.get(sessionId);
  if (!sftp) return { success: false, error: 'SFTP 未连接' };
  return new Promise((resolve) => {
    sftp.stat(remotePath, (err, stats) => {
      if (err) return resolve({ success: false, error: err.message });
      resolve({ success: true, isDir: stats.isDirectory() });
    });
  });
});

ipcMain.handle('sftp-disconnect', (event, sessionId) => {
  const sftp = sftpSessions.get(sessionId);
  if (sftp) { try { sftp.end(); } catch (e) {} sftpSessions.delete(sessionId); }
  return true;
});

// ===================== 多屏/多窗口 IPC =====================

function createChildWindow(opts = {}) {
  const win = new BrowserWindow({
    width: opts.width || 1100,
    height: opts.height || 700,
    minWidth: 700,
    minHeight: 400,
    backgroundColor: '#1a1a2e',
    frame: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  win.loadFile('renderer/index.html');
  const key = 'win_' + Date.now();
  childWindows.set(key, win);
  win.on('closed', () => childWindows.delete(key));
  return win;
}

ipcMain.handle('open-new-window', () => {
  createChildWindow();
  return true;
});

ipcMain.handle('detach-tab', (event, { sessionId, config, title }) => {
  const win = createChildWindow();
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('init-terminal', { sessionId, config, title, isDetached: true });
  });
  return true;
});

// SSH数据转发给子窗口
ipcMain.on('forward-ssh-data', (event, { targetSessionId, data }) => {
  childWindows.forEach(win => {
    if (!win.isDestroyed()) {
      win.webContents.send(`ssh-data-${targetSessionId}`, data);
    }
  });
});

// ===================== 应用生命周期 =====================

app.whenReady().then(async () => {
  await dbManager.init();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
