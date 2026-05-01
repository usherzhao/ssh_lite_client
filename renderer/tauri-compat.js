(function () {
  if (window.sshAPI) return;

  const tauri = window.__TAURI__ || {};
  const invoke = tauri.core && typeof tauri.core.invoke === 'function'
    ? tauri.core.invoke
    : typeof tauri.invoke === 'function'
      ? tauri.invoke
      : null;
  const dialog = tauri.dialog || null;
  const eventApi = tauri.event || null;

  function call(command, args) {
    if (!invoke) {
      return Promise.reject(new Error('Tauri API is not available'));
    }
    return invoke(command, args);
  }

  function listen(eventName, callback) {
    if (!eventApi || typeof eventApi.listen !== 'function') {
      return () => {};
    }
    let unlisten = null;
    eventApi.listen(eventName, (event) => {
      callback(event && Object.prototype.hasOwnProperty.call(event, 'payload') ? event.payload : event);
    }).then((fn) => {
      unlisten = fn;
    }).catch(() => {});
    return () => {
      if (typeof unlisten === 'function') {
        unlisten();
      }
    };
  }

  function normalizeOpenOptions(options) {
    const properties = Array.isArray(options && options.properties) ? options.properties : [];
    const directory = properties.includes('openDirectory');
    const multiple = properties.includes('multiSelections');
    const normalized = {
      title: options && options.title,
      defaultPath: options && options.defaultPath,
      directory,
      multiple,
      filters: options && options.filters
    };
    return normalized;
  }

  async function openDialog(options) {
    if (dialog && typeof dialog.open === 'function') {
      const selected = await dialog.open(normalizeOpenOptions(options));
      if (selected === null || typeof selected === 'undefined') {
        return { canceled: true, filePaths: [] };
      }
      if (Array.isArray(selected)) {
        return { canceled: false, filePaths: selected };
      }
      return { canceled: false, filePaths: [selected] };
    }
    return call('show_open_dialog', { options });
  }

  async function saveDialog(options) {
    if (dialog && typeof dialog.save === 'function') {
      const selected = await dialog.save({
        title: options && options.title,
        defaultPath: options && options.defaultPath,
        filters: options && options.filters
      });
      if (selected === null || typeof selected === 'undefined') {
        return { canceled: true, filePath: null };
      }
      return { canceled: false, filePath: selected };
    }
    return call('show_save_dialog', { options });
  }

  window.sshAPI = {
    winMinimize: () => call('win_minimize'),
    winMaximize: () => call('win_maximize'),
    winClose: () => call('win_close'),

    getConnections: () => call('get_connections'),
    saveConnection: (conn) => call('save_connection', { conn }),
    deleteConnection: (id) => call('delete_connection', { id }),
    reorderConnections: (orderedIds) => call('reorder_connections', { orderedIds }),
    getGroups: () => call('get_groups'),
    saveGroup: (group) => call('save_group', { group }),
    deleteGroup: (group) => call('delete_group', { group }),

    getQuickCommands: () => call('get_quick_commands'),
    saveQuickCommand: (cmd) => call('save_quick_command', { cmd }),
    deleteQuickCommand: (id) => call('delete_quick_command', { id }),

    getDbConfig: () => call('get_db_config'),
    testMySQL: (config) => call('test_mysql', { config }),
    switchMySQL: (config) => call('switch_mysql', { config }),
    switchSQLite: () => call('switch_sqlite'),
    syncSQLiteToMySQL: () => call('sync_sqlite_to_mysql'),
    syncMySQLToSQLite: () => call('sync_mysql_to_sqlite'),
    exportData: (filePath) => call('export_data', { filePath }),
    importData: (filePath) => call('import_data', { filePath }),
    saveWinSCPPath: (winscpPath) => call('save_winscp_path', { winscpPath }),
    openInWinSCP: (conn) => call('open_in_winscp', { conn }),
    showSaveDialog: (opts) => saveDialog(opts),
    showOpenDialog: (opts) => openDialog(opts),
    getEncryptKeyStatus: () => call('get_encrypt_key_status'),

    connect: (sessionId, config) => call('ssh_connect', { sessionId, config }),
    sendInput: (sessionId, data) => call('ssh_input', { sessionId, data }),
    resize: (sessionId, cols, rows) => call('ssh_resize', { sessionId, cols, rows }),
    disconnect: (sessionId) => call('ssh_disconnect', { sessionId }),
    onData: (sessionId, callback) => listen(`ssh-data-${sessionId}`, callback),
    onClose: (sessionId, callback) => listen(`ssh-close-${sessionId}`, callback),

    openNewWindow: () => call('open_new_window'),
    detachTab: (sessionId, config, title) => call('detach_tab', { sessionId, config, title }),
    onInitTerminal: (callback) => listen('init-terminal', callback),

    sftpConnect: (sessionId) => call('sftp_connect', { sessionId }),
    sftpList: (sessionId, remotePath) => call('sftp_list', { sessionId, remotePath }),
    sftpDownload: (sessionId, remotePath, localPath) => call('sftp_download', { sessionId, remotePath, localPath }),
    sftpDownloadDir: (sessionId, remotePath, localPath) => call('sftp_download_dir', { sessionId, remotePath, localPath }),
    sftpUpload: (sessionId, localPath, remotePath) => call('sftp_upload', { sessionId, localPath, remotePath }),
    sftpMkdir: (sessionId, remotePath) => call('sftp_mkdir', { sessionId, remotePath }),
    sftpDelete: (sessionId, remotePath, isDir) => call('sftp_delete', { sessionId, remotePath, isDir }),
    sftpRename: (sessionId, oldPath, newPath) => call('sftp_rename', { sessionId, oldPath, newPath }),
    sftpStat: (sessionId, remotePath) => call('sftp_stat', { sessionId, remotePath }),
    sftpDisconnect: (sessionId) => call('sftp_disconnect', { sessionId })
  };
})();