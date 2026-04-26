const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sshAPI', {
  // 窗口控制
  winMinimize: () => ipcRenderer.send('win-minimize'),
  winMaximize: () => ipcRenderer.send('win-maximize'),
  winClose: () => ipcRenderer.send('win-close'),

  // 连接配置
  getConnections: () => ipcRenderer.invoke('get-connections'),
  saveConnection: (conn) => ipcRenderer.invoke('save-connection', conn),
  deleteConnection: (id) => ipcRenderer.invoke('delete-connection', id),
  reorderConnections: (orderedIds) => ipcRenderer.invoke('reorder-connections', orderedIds),
  getGroups: () => ipcRenderer.invoke('get-groups'),
  saveGroup: (group) => ipcRenderer.invoke('save-group', group),
  deleteGroup: (group) => ipcRenderer.invoke('delete-group', group),

  // 快捷指令
  getQuickCommands: () => ipcRenderer.invoke('get-quick-commands'),
  saveQuickCommand: (cmd) => ipcRenderer.invoke('save-quick-command', cmd),
  deleteQuickCommand: (id) => ipcRenderer.invoke('delete-quick-command', id),

  // 数据库配置
  getDbConfig: () => ipcRenderer.invoke('get-db-config'),
  testMySQL: (config) => ipcRenderer.invoke('test-mysql', config),
  switchMySQL: (config) => ipcRenderer.invoke('switch-mysql', config),
  switchSQLite: () => ipcRenderer.invoke('switch-sqlite'),
  syncSQLiteToMySQL: () => ipcRenderer.invoke('sync-sqlite-to-mysql'),
  syncMySQLToSQLite: () => ipcRenderer.invoke('sync-mysql-to-sqlite'),
  exportData: (filePath) => ipcRenderer.invoke('export-data', filePath),
  importData: (filePath) => ipcRenderer.invoke('import-data', filePath),
  saveWinSCPPath: (winscpPath) => ipcRenderer.invoke('save-winscp-path', winscpPath),
  openInWinSCP: (conn) => ipcRenderer.invoke('open-in-winscp', conn),
  showSaveDialog: (opts) => ipcRenderer.invoke('show-save-dialog', opts),
  showOpenDialog: (opts) => ipcRenderer.invoke('show-open-dialog', opts),
  getEncryptKeyStatus: () => ipcRenderer.invoke('get-encrypt-key-status'),

  // SSH 操作
  connect: (sessionId, config) => ipcRenderer.invoke('ssh-connect', { sessionId, config }),
  sendInput: (sessionId, data) => ipcRenderer.send('ssh-input', { sessionId, data }),
  resize: (sessionId, cols, rows) => ipcRenderer.send('ssh-resize', { sessionId, cols, rows }),
  disconnect: (sessionId) => ipcRenderer.invoke('ssh-disconnect', sessionId),

  // 数据监听
  onData: (sessionId, callback) => {
    const channel = `ssh-data-${sessionId}`;
    const handler = (event, data) => callback(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  onClose: (sessionId, callback) => {
    const channel = `ssh-close-${sessionId}`;
    const handler = () => callback();
    ipcRenderer.once(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },

  // 多窗口
  openNewWindow: () => ipcRenderer.invoke('open-new-window'),
  detachTab: (sessionId, config, title) => ipcRenderer.invoke('detach-tab', { sessionId, config, title }),

  // 子窗口初始化监听
  onInitTerminal: (callback) => {
    ipcRenderer.on('init-terminal', (event, data) => callback(data));
  },

  // SFTP 操作
  sftpConnect: (sessionId) => ipcRenderer.invoke('sftp-connect', { sessionId }),
  sftpList: (sessionId, remotePath) => ipcRenderer.invoke('sftp-list', { sessionId, remotePath }),
  sftpDownload: (sessionId, remotePath, localPath) => ipcRenderer.invoke('sftp-download', { sessionId, remotePath, localPath }),
  sftpDownloadDir: (sessionId, remotePath, localPath) => ipcRenderer.invoke('sftp-download-dir', { sessionId, remotePath, localPath }),
  sftpUpload: (sessionId, localPath, remotePath) => ipcRenderer.invoke('sftp-upload', { sessionId, localPath, remotePath }),
  sftpMkdir: (sessionId, remotePath) => ipcRenderer.invoke('sftp-mkdir', { sessionId, remotePath }),
  sftpDelete: (sessionId, remotePath, isDir) => ipcRenderer.invoke('sftp-delete', { sessionId, remotePath, isDir }),
  sftpRename: (sessionId, oldPath, newPath) => ipcRenderer.invoke('sftp-rename', { sessionId, oldPath, newPath }),
  sftpStat: (sessionId, remotePath) => ipcRenderer.invoke('sftp-stat', { sessionId, remotePath }),
  sftpDisconnect: (sessionId) => ipcRenderer.invoke('sftp-disconnect', sessionId)
});
