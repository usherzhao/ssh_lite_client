/**
 * SSH Client - 渲染进程主逻辑
 * 包含：连接管理、标签页、终端、分屏、多窗口、快捷指令、数据库设置
 */

// ===== xterm.js 动态加载 =====
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

const BASE = '../node_modules';
Promise.all([
  loadScript(`${BASE}/xterm/lib/xterm.js`),
  loadScript(`${BASE}/xterm-addon-fit/lib/xterm-addon-fit.js`),
  loadScript(`${BASE}/xterm-addon-web-links/lib/xterm-addon-web-links.js`)
]).then(() => App.init()).catch(() => App.init(true));

// ===== 全局状态 =====
const App = {
  // ===== 全局状态 =====
  connections: [],
  groups: [],
  quickCommands: [],
  tabs: [],
  activeTabId: null,
  splitMode: false,
  xtermAvailable: false,
  contextMenu: null,
  currentEditId: null,
  currentEditQcmdId: null,
  quickCmdCollapsed: false,
  cmdInputVisible: false,
  cmdInputCollapsed: false,
  cmdHistory: [],
  cmdHistoryIndex: -1,
  collapsedGroups: new Set(),
  connSortMode: 'custom',  // custom | name | host | time

  // 终端外观设置（持久化到 localStorage）
  termSettings: {
    fontFamily: '"Cascadia Code","Fira Code","JetBrains Mono",Consolas,monospace',
    fontSize: 14,
    lineHeight: 1.3,
    encoding: 'utf-8'
  },

  async init(fallback = false) {
    this.xtermAvailable = !fallback && typeof Terminal !== 'undefined';
    this.loadTermSettings();
    this.collapsedGroups = new Set(JSON.parse(localStorage.getItem('collapsedGroups') || '[]'));
    await Promise.all([
      this.loadConnections(),
      this.loadQuickCommands()
    ]);
    this.bindEvents();
    this.renderSidebar();
    this.renderQuickCommands();
    this.sftpInitResize();
    this.sftpInitDragDrop();
    // 检测子窗口初始化
    window.sshAPI.onInitTerminal((data) => {
      if (data && data.config) this.openConnection(data.config);
    });
  },

  // ===== 数据加载 =====
  async loadConnections() {
    [this.connections, this.groups] = await Promise.all([
      window.sshAPI.getConnections(),
      window.sshAPI.getGroups()
    ]);
    // 确保默认分组始终存在
    if (!this.groups.includes('默认分组')) this.groups.unshift('默认分组');
  },

  async loadQuickCommands() {
    this.quickCommands = await window.sshAPI.getQuickCommands();
  },

  // ===== 侧边栏渲染 =====
  renderSidebar() {
    const list = document.getElementById('connections-list');
    const search = document.getElementById('search-input').value.toLowerCase();

    let filtered = this.connections.filter(c =>
      (c.name || '').toLowerCase().includes(search) ||
      (c.host || '').toLowerCase().includes(search) ||
      (c.note || '').toLowerCase().includes(search)
    );

    // 排序
    if (this.connSortMode === 'name') {
      filtered = [...filtered].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    } else if (this.connSortMode === 'host') {
      filtered = [...filtered].sort((a, b) => (a.host || '').localeCompare(b.host || ''));
    } else if (this.connSortMode === 'time') {
      filtered = [...filtered].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    }
    // custom 模式按 sortOrder 排（数据库已按 sort_order 返回，维持原顺序）

    const grouped = {};
    filtered.forEach(c => {
      const g = c.group || '默认分组';
      if (!grouped[g]) grouped[g] = [];
      grouped[g].push(c);
    });

    list.innerHTML = '';
    Object.keys(grouped).forEach(group => {
      const collapsed = this.collapsedGroups.has(group);
      const count = grouped[group].length;

      const label = document.createElement('div');
      label.className = 'conn-group-label' + (collapsed ? ' collapsed' : '');
      label.innerHTML = `
        <span class="group-arrow">▾</span>
        <span class="group-name">${escapeHtml(group)}</span>
        <span class="group-count">${count}</span>
        ${group !== '默认分组' ? `<button class="group-del-btn" title="删除分组">✕</button>` : ''}
      `;
      label.addEventListener('click', (e) => {
        if (e.target.closest('.group-del-btn')) return;
        if (this.collapsedGroups.has(group)) {
          this.collapsedGroups.delete(group);
        } else {
          this.collapsedGroups.add(group);
        }
        this.saveCollapsedGroups();
        this.renderSidebar();
      });
      const delBtn = label.querySelector('.group-del-btn');
      if (delBtn) {
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.deleteGroup(group);
        });
      }
      list.appendChild(label);

        if (!collapsed) {
        grouped[group].forEach(conn => {
          const isConnected = this.tabs.some(t => t.connId === conn.id && t.connected);
          const item = document.createElement('div');
          item.className = 'conn-item' + (isConnected ? ' active' : '');
          item.dataset.id = conn.id;
          item.draggable = this.connSortMode === 'custom';
          item.innerHTML = `
            <div class="conn-item-icon ${isConnected ? 'connected' : ''}"></div>
            <div class="conn-item-info">
              <div class="conn-item-name">${escapeHtml(conn.name)}</div>
              <div class="conn-item-host">${escapeHtml(conn.username)}@${escapeHtml(conn.host)}:${conn.port || 22}</div>
            </div>
            <div class="conn-item-actions">
              <button class="btn-icon" title="编辑">✏</button>
              <button class="btn-icon" title="删除">🗑</button>
            </div>
          `;
          item.addEventListener('click', (e) => {
            if (e.target.closest('.btn-icon')) return;
            this.openConnection(conn);
          });
          item.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.showContextMenu(e, conn);
          });
          const btns = item.querySelectorAll('.btn-icon');
          btns[0].addEventListener('click', () => this.openEditModal(conn));
          btns[1].addEventListener('click', () => this.deleteConnection(conn.id));

          // 拖拽排序（仅 custom 模式）
          if (this.connSortMode === 'custom') {
            item.addEventListener('dragstart', (e) => {
              this._dragSrcId = conn.id;
              item.classList.add('dragging');
              e.dataTransfer.effectAllowed = 'move';
            });
            item.addEventListener('dragend', () => {
              item.classList.remove('dragging');
              list.querySelectorAll('.conn-item').forEach(el => el.classList.remove('drag-over'));
            });
            item.addEventListener('dragover', (e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              list.querySelectorAll('.conn-item').forEach(el => el.classList.remove('drag-over'));
              if (conn.id !== this._dragSrcId) item.classList.add('drag-over');
            });
            item.addEventListener('drop', async (e) => {
              e.preventDefault();
              if (!this._dragSrcId || this._dragSrcId === conn.id) return;
              // 在 this.connections 中交换位置
              const ids = this.connections.map(c => c.id);
              const fromIdx = ids.indexOf(this._dragSrcId);
              const toIdx = ids.indexOf(conn.id);
              if (fromIdx === -1 || toIdx === -1) return;
              const moved = this.connections.splice(fromIdx, 1)[0];
              this.connections.splice(toIdx, 0, moved);
              // 持久化
              this.connections = await window.sshAPI.reorderConnections(this.connections.map(c => c.id));
              this.renderSidebar();
            });
          }

          list.appendChild(item);
        });
      }
    });

    if (filtered.length === 0) {
      list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:12px">暂无连接</div>';
    }
  },

  // ===== 标签页管理 =====
  createTab(conn) {
    const sessionId = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    const tab = {
      id: sessionId, connId: conn.id, config: conn,
      title: conn.name, sessionId,
      connected: false, terminal: null, fitAddon: null,
      panelEl: null, removeListeners: null
    };
    this.tabs.push(tab);
    this.renderTabs();
    this.activateTab(sessionId);
    return tab;
  },

  renderTabs() {
    const wrapper = document.getElementById('tabs-wrapper');
    wrapper.innerHTML = '';
    this.tabs.forEach(tab => {
      const el = document.createElement('div');
      el.className = 'tab' + (tab.id === this.activeTabId ? ' active' : '');
      el.dataset.id = tab.id;
      el.innerHTML = `
        <div class="tab-dot ${tab.connected ? 'connected' : ''}"></div>
        <span style="overflow:hidden;text-overflow:ellipsis;flex:1">${escapeHtml(tab.title)}</span>
        <div class="tab-close">✕</div>
      `;
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('tab-close')) {
          this.closeTab(tab.id);
        } else {
          this.activateTab(tab.id);
        }
      });
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.showTabContextMenu(e, tab);
      });
      wrapper.appendChild(el);
    });
  },

  activateTab(tabId) {
    this.activeTabId = tabId;
    this.renderTabs();
    this.renderTerminalArea();
    if (this.cmdInputVisible) this.updateCmdTargetLabel();
    // 切换 SFTP 面板到对应 tab
    const tab = this.tabs.find(t => t.id === tabId);
    if (tab && tab.connected) {
      const panel = document.getElementById('sftp-panel');
      if (this.sftp.sessionId !== tab.sessionId) {
        // 只更新显示的路径/主机标签，不重新建连接
        // 如果此 tab 已有 sftp 连接则刷新，否则重新连接
        this.sftp.sessionId = tab.sessionId;
        this.sftp.connName = tab.config.name || tab.config.host;
        document.getElementById('sftp-host-label').textContent = this.sftp.connName;
        panel.style.display = 'flex';
        // 尝试刷新列表（如果 sftp 连接仍然有效）
        window.sshAPI.sftpList(tab.sessionId, this.sftp.currentPath).then(r => {
          if (r.success) {
            document.getElementById('sftp-path-display').textContent = this.sftp.currentPath;
            this.sftpRenderList(r.list);
          } else {
            // SFTP 连接失效，重新建立
            this.sftpAutoConnect(tab);
          }
        });
      }
    }
  },

  closeTab(tabId) {
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab) return;
    if (tab.removeListeners) tab.removeListeners();
    if (tab.terminal) tab.terminal.dispose();
    window.sshAPI.disconnect(tab.sessionId);
    // 如果当前 SFTP 绑定的是这个 tab，关闭 SFTP
    if (this.sftp.sessionId === tab.sessionId) {
      this.sftpClose();
    }
    this.tabs = this.tabs.filter(t => t.id !== tabId);
    if (this.activeTabId === tabId) {
      this.activeTabId = this.tabs.length ? this.tabs[this.tabs.length - 1].id : null;
    }
    this.renderTabs();
    this.renderTerminalArea();
    this.renderSidebar();
  },

  renderTerminalArea() {
    const welcome = document.getElementById('welcome-screen');
    const splitContainer = document.getElementById('split-container');

    if (this.tabs.length === 0) {
      welcome.style.display = 'flex';
      splitContainer.style.display = 'none';
      return;
    }

    welcome.style.display = 'none';
    splitContainer.style.display = 'flex';
    splitContainer.innerHTML = '';

    if (this.splitMode && this.tabs.length >= 2) {
      this.tabs.forEach(tab => splitContainer.appendChild(this.createTerminalPanel(tab, true)));
    } else {
      const tab = this.tabs.find(t => t.id === this.activeTabId);
      if (tab) splitContainer.appendChild(this.createTerminalPanel(tab, false));
    }

    setTimeout(() => {
      this.tabs.forEach(tab => {
        if (tab.fitAddon && tab.connected) {
          try { tab.fitAddon.fit(); } catch(e) {}
        }
      });
    }, 50);
  },

  createTerminalPanel(tab, showTitle) {
    const panel = document.createElement('div');
    panel.className = 'terminal-panel';
    panel.dataset.tabId = tab.id;
    tab.panelEl = panel;

    if (showTitle) {
      const bar = document.createElement('div');
      bar.className = 'terminal-panel-bar';
      bar.innerHTML = `
        <div class="terminal-panel-title">
          <div class="tab-dot ${tab.connected ? 'connected' : ''}"></div>
          <span>${escapeHtml(tab.title)}</span>
        </div>
        <div class="terminal-panel-actions">
          <button class="btn-icon" data-action="detach" title="新窗口">🗗</button>
          <button class="btn-icon" data-action="close" title="关闭">✕</button>
        </div>
      `;
      bar.querySelector('[data-action="detach"]').addEventListener('click', () => this.detachTab(tab));
      bar.querySelector('[data-action="close"]').addEventListener('click', () => this.closeTab(tab.id));
      panel.appendChild(bar);
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'terminal-wrapper';
    wrapper.id = 'term-wrapper-' + tab.id;
    panel.appendChild(wrapper);

    if (!tab.connected) {
      wrapper.innerHTML = `
        <div class="terminal-connecting">
          <div class="spinner"></div>
          <span>正在连接 ${escapeHtml(tab.config.host)}...</span>
        </div>
      `;
    } else if (tab.terminal) {
      wrapper.innerHTML = '';
      tab.terminal.open(wrapper);
      setTimeout(() => { if (tab.fitAddon) tab.fitAddon.fit(); }, 20);
    }

    return panel;
  },

  // ===== SSH 连接 =====
  async openConnection(conn) {
    // 如果该连接已有激活的标签页，直接切换过去
    const existing = this.tabs.find(t => t.connId === conn.id && t.connected);
    if (existing) {
      this.activateTab(existing.id);
      return;
    }

    const tab = this.createTab(conn);
    this.renderTerminalArea();

    const result = await window.sshAPI.connect(tab.sessionId, {
      host: conn.host, port: conn.port || 22,
      username: conn.username,
      authType: conn.authType || 'password',
      password: conn.password || '',
      privateKey: conn.privateKey || '',
      passphrase: conn.passphrase || '',
      x11Forwarding: !!conn.x11Forwarding,
      x11Display: conn.x11Display || 'localhost:0'
    });

    if (!result.success) {
      const wrapper = document.getElementById('term-wrapper-' + tab.id);
      if (wrapper) {
        wrapper.innerHTML = `
          <div class="terminal-connecting">
            <div style="color:var(--red);font-size:32px">✕</div>
            <span style="color:var(--red)">连接失败</span>
            <span style="font-size:12px;color:var(--text-muted)">${escapeHtml(result.error || '')}</span>
            <button class="btn-secondary" onclick="App.closeTab('${tab.id}')">关闭</button>
          </div>
        `;
      }
      return;
    }

    tab.connected = true;
    this.renderSidebar();
    this.renderTabs();
    this.attachTerminal(tab);
    // SSH 连接成功后，执行「登录后执行」命令
    if (conn.initCommands) {
      const lines = conn.initCommands.split('\n').map(l => l.trim()).filter(Boolean);
      if (lines.length > 0) {
        // 延迟等待 shell ready
        setTimeout(() => {
          lines.forEach(cmd => window.sshAPI.sendInput(tab.sessionId, cmd + '\n'));
        }, 600);
      }
    }
    // SSH 连接成功后，自动初始化 SFTP
    this.sftpAutoConnect(tab);
  },

  attachTerminal(tab) {
    if (!this.xtermAvailable) {
      this.attachFallbackTerminal(tab);
      return;
    }

    const term = new Terminal({
      theme: {
        background: '#0d1117', foreground: '#e2e8f0',
        cursor: '#3b82f6', cursorAccent: '#0d1117',
        black: '#1a1a2e', red: '#ef4444', green: '#22c55e',
        yellow: '#f59e0b', blue: '#3b82f6', magenta: '#a855f7',
        cyan: '#06b6d4', white: '#e2e8f0',
        brightBlack: '#4b5563', brightRed: '#f87171', brightGreen: '#4ade80',
        brightYellow: '#fbbf24', brightBlue: '#60a5fa',
        brightMagenta: '#c084fc', brightCyan: '#22d3ee', brightWhite: '#f9fafb'
      },
      fontFamily: this.termSettings.fontFamily,
      fontSize: this.termSettings.fontSize,
      lineHeight: this.termSettings.lineHeight,
      cursorBlink: true, cursorStyle: 'block',
      scrollback: 5000, allowTransparency: false
    });

    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    if (typeof WebLinksAddon !== 'undefined') {
      term.loadAddon(new WebLinksAddon.WebLinksAddon());
    }

    tab.terminal = term;
    tab.fitAddon = fitAddon;

    const wrapper = document.getElementById('term-wrapper-' + tab.id);
    if (wrapper) {
      wrapper.innerHTML = '';
      term.open(wrapper);
      setTimeout(() => fitAddon.fit(), 30);

      // 右键粘贴：有选中文字则复制，否则粘贴剪贴板内容
      wrapper.addEventListener('contextmenu', async (e) => {
        e.preventDefault();
        const selection = term.getSelection();
        if (selection) {
          await navigator.clipboard.writeText(selection).catch(() => {});
          term.clearSelection();
        } else {
          const text = await navigator.clipboard.readText().catch(() => '');
          if (text) window.sshAPI.sendInput(tab.sessionId, text);
        }
      });
    }

    term.onData(data => {
      window.sshAPI.sendInput(tab.sessionId, data);
      this.captureTerminalInput(tab, data);
    });

    const removeData = window.sshAPI.onData(tab.sessionId, (data) => {
      // 编码转换支持
      if (this.termSettings.encoding && this.termSettings.encoding !== 'utf-8') {
        try {
          const bytes = Uint8Array.from(data.split('').map(c => c.charCodeAt(0)));
          const decoded = new TextDecoder(this.termSettings.encoding).decode(bytes);
          term.write(decoded);
        } catch (e) {
          term.write(data);
        }
      } else {
        term.write(data);
      }
    });
    const removeClose = window.sshAPI.onClose(tab.sessionId, () => {
      tab.connected = false;
      term.write('\r\n\x1b[31m[连接已断开]\x1b[0m\r\n');
      this.renderTabs();
      this.renderSidebar();
    });

    tab.removeListeners = () => {
      if (removeData) removeData();
      if (removeClose) removeClose();
    };

    const ro = new ResizeObserver(() => {
      if (tab.fitAddon && tab.connected) {
        try {
          tab.fitAddon.fit();
          window.sshAPI.resize(tab.sessionId, term.cols, term.rows);
        } catch(e) {}
      }
    });
    if (wrapper) ro.observe(wrapper);

    setTimeout(() => {
      fitAddon.fit();
      window.sshAPI.resize(tab.sessionId, term.cols, term.rows);
    }, 100);
  },

  attachFallbackTerminal(tab) {
    const wrapper = document.getElementById('term-wrapper-' + tab.id);
    if (!wrapper) return;
    wrapper.innerHTML = '';
    Object.assign(wrapper.style, {
      padding: '8px', fontFamily: 'monospace', fontSize: '13px',
      color: '#e2e8f0', background: '#000', overflow: 'auto', userSelect: 'text'
    });
    const output = document.createElement('div');
    output.style.whiteSpace = 'pre-wrap';
    wrapper.appendChild(output);
    const input = document.createElement('input');
    input.style.cssText = 'width:100%;background:transparent;border:none;outline:none;color:#e2e8f0;font:inherit;';
    wrapper.appendChild(input);
    input.focus();
    const removeData = window.sshAPI.onData(tab.sessionId, (data) => {
      output.textContent += data;
      wrapper.scrollTop = wrapper.scrollHeight;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        window.sshAPI.sendInput(tab.sessionId, input.value + '\n');
        input.value = '';
      }
    });
    input.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      const text = await navigator.clipboard.readText().catch(() => '');
      if (text) {
        const start = input.selectionStart;
        const end = input.selectionEnd;
        input.value = input.value.slice(0, start) + text + input.value.slice(end);
        input.selectionStart = input.selectionEnd = start + text.length;
      }
    });
    tab.removeListeners = () => { if (removeData) removeData(); };
  },

  // 发送指令到当前激活的终端
  sendCommandToActiveTab(cmd) {
    const tab = this.tabs.find(t => t.id === this.activeTabId);
    if (!tab || !tab.connected) {
      alert('请先连接到一个服务器');
      return;
    }
    window.sshAPI.sendInput(tab.sessionId, cmd + '\n');
    if (tab.terminal) tab.terminal.focus();
  },

  // ===== 指令发送窗口 =====
  toggleCmdInputPanel() {
    this.cmdInputVisible = !this.cmdInputVisible;
    const panel = document.getElementById('cmd-input-panel');
    const btn = document.getElementById('btn-cmd-input');
    if (this.cmdInputVisible) {
      panel.style.display = 'flex';
      btn.style.background = 'var(--accent)';
      btn.style.color = '#fff';
      this.updateCmdTargetLabel();
      this.renderCmdHistoryList();
      setTimeout(() => document.getElementById('cmd-input-text').focus(), 50);
    } else {
      panel.style.display = 'none';
      btn.style.background = '';
      btn.style.color = '';
    }
  },

  updateCmdTargetLabel() {
    const label = document.getElementById('cmd-target-label');
    const tab = this.tabs.find(t => t.id === this.activeTabId);
    if (tab && tab.connected) {
      label.textContent = '→ ' + (tab.title || tab.config.host);
    } else {
      label.textContent = '→ 未连接';
    }
  },

  sendCmdInput() {
    const textarea = document.getElementById('cmd-input-text');
    const cmd = textarea.value.trim();
    if (!cmd) return;

    const tab = this.tabs.find(t => t.id === this.activeTabId);
    if (!tab || !tab.connected) {
      alert('请先连接到一个服务器');
      return;
    }

    const now = new Date();
    const timeStr = now.getHours().toString().padStart(2, '0') + ':' +
                    now.getMinutes().toString().padStart(2, '0') + ':' +
                    now.getSeconds().toString().padStart(2, '0');
    this.cmdHistory.push({ cmd, time: timeStr, source: 'panel' });
    if (this.cmdHistory.length > 200) this.cmdHistory.shift();

    const lines = cmd.split('\n');
    lines.forEach(line => {
      window.sshAPI.sendInput(tab.sessionId, line + '\n');
    });

    textarea.value = '';
    textarea.style.height = 'auto';
    this.renderCmdHistoryList();
    if (tab.terminal) tab.terminal.focus();
  },

  renderCmdHistoryList() {
    const list = document.getElementById('cmd-history-list');
    list.innerHTML = '';
    if (this.cmdHistory.length === 0) {
      list.innerHTML = '<div class="cmd-history-empty">暂无历史指令</div>';
      return;
    }
    this.cmdHistory.forEach((entry, index) => {
      const item = document.createElement('div');
      item.className = 'cmd-history-item';
      item.dataset.index = index;
      const displayCmd = entry.cmd.replace(/\n/g, ' ↵ ');
      const sourceIcon = entry.source === 'terminal' ? '⌨' : '▶';
      item.innerHTML = `
        <span class="cmd-history-item-index">${index + 1}</span>
        <span class="cmd-history-item-source" title="${entry.source === 'terminal' ? '终端输入' : '指令窗口'}">${sourceIcon}</span>
        <span class="cmd-history-item-text" title="${escapeHtml(entry.cmd)}">${escapeHtml(displayCmd)}</span>
        <span class="cmd-history-item-time">${entry.time}</span>
        <span class="cmd-history-item-del" title="删除">✕</span>
      `;
      item.addEventListener('click', (e) => {
        if (e.target.closest('.cmd-history-item-del')) {
          e.stopPropagation();
          this.cmdHistory.splice(index, 1);
          this.renderCmdHistoryList();
          return;
        }
        const textarea = document.getElementById('cmd-input-text');
        textarea.value = entry.cmd;
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
        textarea.focus();
      });
      list.appendChild(item);
    });
    list.scrollTop = list.scrollHeight;
  },

  clearCmdHistory() {
    if (this.cmdHistory.length === 0) return;
    if (!confirm('清空所有历史指令？')) return;
    this.cmdHistory = [];
    this.renderCmdHistoryList();
  },

  toggleCmdInputCollapse() {
    this.cmdInputCollapsed = !this.cmdInputCollapsed;
    const panel = document.getElementById('cmd-input-panel');
    const btn = document.getElementById('btn-cmd-toggle');
    if (this.cmdInputCollapsed) {
      panel.classList.add('collapsed');
      btn.textContent = '▲';
    } else {
      panel.classList.remove('collapsed');
      btn.textContent = '▼';
    }
  },

  closeCmdInput() {
    this.cmdInputVisible = false;
    const panel = document.getElementById('cmd-input-panel');
    const btn = document.getElementById('btn-cmd-input');
    panel.style.display = 'none';
    btn.style.background = '';
    btn.style.color = '';
  },

  captureTerminalInput(tab, data) {
    if (!tab._currentLine) tab._currentLine = '';
    if (data === '\r') {
      const line = tab._currentLine.trim();
      if (line) {
        const now = new Date();
        const timeStr = now.getHours().toString().padStart(2, '0') + ':' +
                        now.getMinutes().toString().padStart(2, '0') + ':' +
                        now.getSeconds().toString().padStart(2, '0');
        this.cmdHistory.push({ cmd: line, time: timeStr, source: 'terminal' });
        if (this.cmdHistory.length > 200) this.cmdHistory.shift();
        if (this.cmdInputVisible) this.renderCmdHistoryList();
        
        // 检测 cd 命令并同步 SFTP 目录
        if (line.startsWith('cd ')) {
          const path = line.substring(3).trim();
          if (path) {
            this.sftpSyncPath(path);
            
            // 如果 SFTP 未连接，缓存 cd 命令
            if (!this.sftp.sessionId) {
              tab._pendingCdCommand = path;
            }
          }
        }
      }
      tab._currentLine = '';
    } else if (data === '\x7f' || data === '\b') {
      tab._currentLine = tab._currentLine.slice(0, -1);
    } else if (data === '\x03') {
      tab._currentLine = '';
    } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
      tab._currentLine += data;
    } else if (data === '\x1b[A' || data === '\x1b[B' || data === '\x1b[C' || data === '\x1b[D') {
      // arrow keys - ignore
    } else if (data.startsWith('\x1b')) {
      // other escape sequences - ignore
    }
  },

  // ===== 分屏 =====
  toggleSplit() {
    this.splitMode = !this.splitMode;
    const btn = document.getElementById('btn-split-h');
    btn.style.background = this.splitMode ? 'var(--accent)' : '';
    btn.style.color = this.splitMode ? '#fff' : '';
    this.renderTerminalArea();
  },

  // ===== 脱离标签页 =====
  async detachTab(tab) {
    await window.sshAPI.detachTab(tab.sessionId, tab.config, tab.title);
  },

  async openNewWindow() {
    await window.sshAPI.openNewWindow();
  },

  // ===== 快捷指令 =====
  renderQuickCommands() {
    const list = document.getElementById('quick-cmd-list');
    const catSel = document.getElementById('quick-cmd-category');
    const selectedCat = catSel.value;

    // 更新分类选项
    const cats = ['', ...new Set(this.quickCommands.map(c => c.category || '常用'))];
    catSel.innerHTML = cats.map(c =>
      `<option value="${escapeHtml(c)}" ${c === selectedCat ? 'selected' : ''}>${c || '全部'}</option>`
    ).join('');

    const filtered = selectedCat
      ? this.quickCommands.filter(c => (c.category || '常用') === selectedCat)
      : this.quickCommands;

    list.innerHTML = '';
    if (filtered.length === 0) {
      list.innerHTML = '<span class="quick-cmd-empty">暂无快捷指令，点击 ＋ 添加</span>';
      return;
    }

    filtered.forEach(cmd => {
      const item = document.createElement('div');
      item.className = 'quick-cmd-item';
      item.title = cmd.command;
      item.innerHTML = `
        <span class="quick-cmd-item-name">${escapeHtml(cmd.name)}</span>
        <span class="quick-cmd-item-del" title="删除">✕</span>
      `;
      item.addEventListener('click', (e) => {
        if (e.target.classList.contains('quick-cmd-item-del')) {
          e.stopPropagation();
          this.deleteQuickCommand(cmd.id);
          return;
        }
        this.sendCommandToActiveTab(cmd.command);
      });
      item.querySelector('.quick-cmd-item-del').addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteQuickCommand(cmd.id);
      });
      list.appendChild(item);
    });
  },

  openQuickCmdModal(cmd = null) {
    this.currentEditQcmdId = cmd ? cmd.id : null;
    document.getElementById('quick-cmd-modal-title').textContent = cmd ? '编辑快捷指令' : '新建快捷指令';
    document.getElementById('qcmd-name').value = cmd ? cmd.name : '';
    document.getElementById('qcmd-category').value = cmd ? (cmd.category || '常用') : '常用';
    document.getElementById('qcmd-command').value = cmd ? cmd.command : '';
    document.getElementById('qcmd-sort').value = cmd ? (cmd.sortOrder || 0) : 0;
    document.getElementById('quick-cmd-overlay').style.display = 'flex';
    setTimeout(() => document.getElementById('qcmd-name').focus(), 50);
  },

  async saveQuickCommand() {
    const name = document.getElementById('qcmd-name').value.trim();
    const command = document.getElementById('qcmd-command').value.trim();
    const category = document.getElementById('qcmd-category').value.trim() || '常用';
    const sortOrder = parseInt(document.getElementById('qcmd-sort').value) || 0;
    if (!name) { alert('请输入指令名称'); return; }
    if (!command) { alert('请输入指令内容'); return; }
    const data = { name, command, category, sortOrder };
    if (this.currentEditQcmdId) data.id = this.currentEditQcmdId;
    this.quickCommands = await window.sshAPI.saveQuickCommand(data);
    document.getElementById('quick-cmd-overlay').style.display = 'none';
    this.renderQuickCommands();
  },

  async deleteQuickCommand(id) {
    if (!confirm('删除此快捷指令？')) return;
    this.quickCommands = await window.sshAPI.deleteQuickCommand(id);
    this.renderQuickCommands();
  },

  toggleQuickCmdBar() {
    this.quickCmdCollapsed = !this.quickCmdCollapsed;
    const bar = document.getElementById('quick-cmd-bar');
    const btn = document.getElementById('btn-toggle-quick-cmd');
    if (this.quickCmdCollapsed) {
      bar.classList.add('collapsed');
      btn.textContent = '▲';
    } else {
      bar.classList.remove('collapsed');
      btn.textContent = '▼';
    }
  },

  // ===== 连接管理弹窗 =====
  openNewConnModal() {
    this.currentEditId = null;
    document.getElementById('modal-title').textContent = '新建 SSH 连接';
    document.getElementById('conn-name').value = '';
    document.getElementById('conn-host').value = '';
    document.getElementById('conn-port').value = '22';
    document.getElementById('conn-username').value = '';
    document.getElementById('conn-password').value = '';
    document.getElementById('conn-privatekey').value = '';
    document.getElementById('conn-passphrase').value = '';
    document.getElementById('conn-note').value = '';
    document.getElementById('conn-init-commands').value = '';
    document.getElementById('conn-x11-forwarding').checked = false;
    document.getElementById('conn-x11-display').value = 'localhost:0';
    document.getElementById('x11-display-row').style.display = 'none';
    document.querySelectorAll('[name=auth-type]')[0].checked = true;
    this.toggleAuthType('password');
    document.getElementById('conn-status').textContent = '';
    document.getElementById('conn-status').className = 'conn-status';
    this.renderGroupSelect();
    document.getElementById('modal-overlay').style.display = 'flex';
    setTimeout(() => document.getElementById('conn-name').focus(), 50);
  },

  openEditModal(conn) {
    this.currentEditId = conn.id;
    document.getElementById('modal-title').textContent = '编辑连接';
    document.getElementById('conn-name').value = conn.name || '';
    document.getElementById('conn-host').value = conn.host || '';
    document.getElementById('conn-port').value = conn.port || 22;
    document.getElementById('conn-username').value = conn.username || '';
    document.getElementById('conn-password').value = ''; // 不显示密码
    document.getElementById('conn-privatekey').value = ''; // 不显示私钥
    document.getElementById('conn-passphrase').value = ''; // 不显示口令
    document.getElementById('conn-note').value = conn.note || '';
    document.getElementById('conn-init-commands').value = conn.initCommands || '';
    document.getElementById('conn-x11-forwarding').checked = !!conn.x11Forwarding;
    document.getElementById('conn-x11-display').value = conn.x11Display || 'localhost:0';
    document.getElementById('x11-display-row').style.display = conn.x11Forwarding ? '' : 'none';
    const authType = conn.authType || 'password';
    const radio = document.querySelector(`[name=auth-type][value="${authType}"]`);
    if (radio) radio.checked = true;
    this.toggleAuthType(authType);
    document.getElementById('conn-status').textContent = '';
    document.getElementById('conn-status').className = 'conn-status';
    this.renderGroupSelect(conn.group);
    document.getElementById('modal-overlay').style.display = 'flex';
  },

  renderGroupSelect(selected) {
    const sel = document.getElementById('conn-group');
    sel.innerHTML = '';
    this.groups.forEach(g => {
      const opt = document.createElement('option');
      opt.value = g;
      opt.textContent = g;
      if (g === selected) opt.selected = true;
      sel.appendChild(opt);
    });
  },

  toggleAuthType(type) {
    document.getElementById('auth-password-area').style.display = type === 'password' ? '' : 'none';
    document.getElementById('auth-key-area').style.display = type === 'privateKey' ? '' : 'none';
  },

  getFormData() {
    const authType = document.querySelector('[name=auth-type]:checked').value;
    return {
      id: this.currentEditId || undefined,
      name: document.getElementById('conn-name').value.trim(),
      host: document.getElementById('conn-host').value.trim(),
      port: parseInt(document.getElementById('conn-port').value) || 22,
      username: document.getElementById('conn-username').value.trim(),
      authType,
      password: authType === 'password' ? document.getElementById('conn-password').value : '',
      privateKey: authType === 'privateKey' ? document.getElementById('conn-privatekey').value.trim() : '',
      passphrase: authType === 'privateKey' ? document.getElementById('conn-passphrase').value : '',
      group: document.getElementById('conn-group').value,
      note: document.getElementById('conn-note').value.trim(),
      initCommands: document.getElementById('conn-init-commands').value.trim(),
      x11Forwarding: document.getElementById('conn-x11-forwarding').checked,
      x11Display: document.getElementById('conn-x11-display').value.trim() || 'localhost:0'
    };
  },

  validateForm(data) {
    if (!data.name) return '请输入连接名称';
    if (!data.host) return '请输入主机地址';
    if (!data.username) return '请输入用户名';
    if (data.authType === 'password' && !data.password) return '请输入密码';
    if (data.authType === 'privateKey' && !data.privateKey) return '请输入私钥内容';
    return null;
  },

  async saveConnection() {
    const data = this.getFormData();
    const err = this.validateForm(data);
    if (err) { this.setConnStatus(err, 'error'); return; }
    this.connections = await window.sshAPI.saveConnection(data);
    document.getElementById('modal-overlay').style.display = 'none';
    this.renderSidebar();
    const savedConn = this.connections.find(c =>
      c.host === data.host && c.username === data.username && c.name === data.name
    );
    if (savedConn) this.openConnection(savedConn);
  },

  async testConnection() {
    const data = this.getFormData();
    const err = this.validateForm(data);
    if (err) { this.setConnStatus(err, 'error'); return; }
    this.setConnStatus('正在测试连接...', 'info');
    const tempId = 'test_' + Date.now();
    const result = await window.sshAPI.connect(tempId, data);
    if (result.success) {
      this.setConnStatus('✓ 连接成功！', 'success');
      window.sshAPI.disconnect(tempId);
    } else {
      this.setConnStatus('✕ ' + (result.error || '连接失败'), 'error');
    }
  },

  setConnStatus(msg, type) {
    const el = document.getElementById('conn-status');
    el.textContent = msg;
    el.className = 'conn-status ' + (type || '');
  },

  async deleteConnection(id) {
    if (!confirm('确定要删除此连接吗？')) return;
    this.connections = await window.sshAPI.deleteConnection(id);
    this.renderSidebar();
    this.renderManageTable();
  },

  async deleteGroup(name) {
    const connsInGroup = this.connections.filter(c => (c.group || '默认分组') === name);
    const msg = connsInGroup.length > 0
      ? `删除分组"${name}"？该分组下 ${connsInGroup.length} 个连接将移至默认分组。`
      : `确定删除分组"${name}"？`;
    if (!confirm(msg)) return;
    await window.sshAPI.deleteGroup(name);
    this.collapsedGroups.delete(name);
    this.saveCollapsedGroups();
    await this.loadConnections();
    this.renderSidebar();
  },

  // ===== 管理弹窗 =====
  openManageModal() {
    document.getElementById('manage-overlay').style.display = 'flex';
    this.renderManageTable();
  },

  renderManageTable() {
    const tbody = document.getElementById('conn-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    this.connections.forEach(conn => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(conn.name)}</td>
        <td>${escapeHtml(conn.host)}</td>
        <td>${conn.port || 22}</td>
        <td>${escapeHtml(conn.username)}</td>
        <td>${escapeHtml(conn.group || '默认分组')}</td>
        <td>
          <div class="actions-cell">
            <button class="btn-sm" data-action="connect">连接</button>
            <button class="btn-sm" data-action="edit">编辑</button>
            <button class="btn-sm btn-danger" data-action="delete">删除</button>
          </div>
        </td>
      `;
      tr.querySelector('[data-action="connect"]').addEventListener('click', () => {
        document.getElementById('manage-overlay').style.display = 'none';
        this.openConnection(conn);
      });
      tr.querySelector('[data-action="edit"]').addEventListener('click', () => {
        document.getElementById('manage-overlay').style.display = 'none';
        this.openEditModal(conn);
      });
      tr.querySelector('[data-action="delete"]').addEventListener('click', () => this.deleteConnection(conn.id));
      tbody.appendChild(tr);
    });
    if (this.connections.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:20px">暂无已保存的连接</td></tr>';
    }
  },

  // ===== 数据库设置弹窗 =====
  async openDbSettings() {
    const cfg = await window.sshAPI.getDbConfig();
    document.getElementById('db-current-type').textContent = cfg.dbType === 'mysql' ? 'MySQL' : 'SQLite（本地）';
    const mysqlAddr = cfg.mysqlConfig ? `${cfg.mysqlConfig.host}:${cfg.mysqlConfig.port || 3306}/${cfg.mysqlConfig.database}` : '';
    document.getElementById('db-mysql-addr').textContent = mysqlAddr;
    document.getElementById('mysql-config-area').style.display = 'none';
    document.getElementById('mysql-status').textContent = '';
    document.getElementById('sync-status').textContent = '';
    document.getElementById('io-status').textContent = '';
    if (cfg.mysqlConfig) {
      document.getElementById('mysql-host').value = cfg.mysqlConfig.host || 'localhost';
      document.getElementById('mysql-port').value = cfg.mysqlConfig.port || 3306;
      document.getElementById('mysql-user').value = cfg.mysqlConfig.user || 'root';
      document.getElementById('mysql-pass').value = '';
      document.getElementById('mysql-db').value = cfg.mysqlConfig.database || 'ssh_client';
    }
    
    // 获取加密密钥状态
    const keyStatus = await window.sshAPI.getEncryptKeyStatus();
    const statusEl = document.getElementById('db-encrypt-key-status');
    const infoEl = document.getElementById('db-encrypt-key-info');
    if (keyStatus.hasEnvKey) {
      statusEl.textContent = '已设置环境变量';
      statusEl.style.color = 'var(--text-primary)';
      infoEl.textContent = '';
    } else {
      statusEl.textContent = '未设置环境变量';
      statusEl.style.color = 'var(--text-muted)';
      infoEl.textContent = `请设置环境变量: ${keyStatus.envKey}`;
    }
    
    document.getElementById('db-overlay').style.display = 'flex';
  },

  getMysqlFormConfig() {
    return {
      host: document.getElementById('mysql-host').value.trim(),
      port: parseInt(document.getElementById('mysql-port').value) || 3306,
      user: document.getElementById('mysql-user').value.trim(),
      password: document.getElementById('mysql-pass').value,
      database: document.getElementById('mysql-db').value.trim() || 'ssh_client'
    };
  },

  setMysqlStatus(msg, type) {
    const el = document.getElementById('mysql-status');
    el.textContent = msg;
    el.className = 'conn-status ' + (type || '');
  },

  setSyncStatus(msg, type) {
    const el = document.getElementById('sync-status');
    el.textContent = msg;
    el.className = 'conn-status ' + (type || '');
  },

  setIOStatus(msg, type) {
    const el = document.getElementById('io-status');
    el.textContent = msg;
    el.className = 'conn-status ' + (type || '');
  },

  // ===== 右键菜单 =====
  showContextMenu(e, conn) {
    this.closeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.innerHTML = `
      <div class="context-menu-item" data-action="connect">▶ 连接</div>
      <div class="context-menu-item" data-action="new-win">🗗 新窗口打开</div>
      <div class="context-menu-sep"></div>
      <div class="context-menu-item" data-action="edit">✏ 编辑</div>
      <div class="context-menu-item danger" data-action="delete">🗑 删除</div>
    `;
    menu.style.left = Math.min(e.clientX, window.innerWidth - 170) + 'px';
    menu.style.top = Math.min(e.clientY, window.innerHeight - 150) + 'px';
    menu.querySelector('[data-action="connect"]').addEventListener('click', () => { this.openConnection(conn); this.closeContextMenu(); });
    menu.querySelector('[data-action="new-win"]').addEventListener('click', () => { this.openNewWindow(); this.closeContextMenu(); });
    menu.querySelector('[data-action="edit"]').addEventListener('click', () => { this.openEditModal(conn); this.closeContextMenu(); });
    menu.querySelector('[data-action="delete"]').addEventListener('click', () => { this.deleteConnection(conn.id); this.closeContextMenu(); });
    document.body.appendChild(menu);
    this.contextMenu = menu;
    setTimeout(() => document.addEventListener('click', this._closeMenuHandler = () => this.closeContextMenu(), { once: true }), 10);
  },

  showTabContextMenu(e, tab) {
    this.closeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.innerHTML = `
      <div class="context-menu-item" data-action="detach">🗗 新窗口打开</div>
      <div class="context-menu-item" data-action="reconnect">↺ 重新连接</div>
      <div class="context-menu-sep"></div>
      <div class="context-menu-item danger" data-action="close">✕ 关闭标签页</div>
    `;
    menu.style.left = Math.min(e.clientX, window.innerWidth - 170) + 'px';
    menu.style.top = Math.min(e.clientY, window.innerHeight - 130) + 'px';
    menu.querySelector('[data-action="detach"]').addEventListener('click', () => { this.detachTab(tab); this.closeContextMenu(); });
    menu.querySelector('[data-action="reconnect"]').addEventListener('click', () => { this.closeTab(tab.id); this.openConnection(tab.config); this.closeContextMenu(); });
    menu.querySelector('[data-action="close"]').addEventListener('click', () => { this.closeTab(tab.id); this.closeContextMenu(); });
    document.body.appendChild(menu);
    this.contextMenu = menu;
    setTimeout(() => document.addEventListener('click', () => this.closeContextMenu(), { once: true }), 10);
  },

  closeContextMenu() {
    if (this.contextMenu) {
      this.contextMenu.remove();
      this.contextMenu = null;
    }
  },

  // ===== 终端外观设置 =====
  saveCollapsedGroups() {
    localStorage.setItem('collapsedGroups', JSON.stringify([...this.collapsedGroups]));
  },

  loadTermSettings() {
    try {
      const saved = localStorage.getItem('termSettings');
      if (saved) Object.assign(this.termSettings, JSON.parse(saved));
    } catch (e) {}
  },

  saveTermSettings() {
    localStorage.setItem('termSettings', JSON.stringify(this.termSettings));
  },

  openTermSettings() {
    const s = this.termSettings;
    // 字体下拉
    const fontSel = document.getElementById('term-font-family');
    let matched = false;
    for (const opt of fontSel.options) {
      if (opt.value === s.fontFamily) { opt.selected = true; matched = true; break; }
    }
    if (!matched) fontSel.options[0].selected = true;
    document.getElementById('term-font-size').value = s.fontSize;
    document.getElementById('term-line-height').value = s.lineHeight;
    const encSel = document.getElementById('term-encoding');
    for (const opt of encSel.options) {
      opt.selected = opt.value === s.encoding;
    }
    this.updateTermPreview();
    document.getElementById('term-settings-overlay').style.display = 'flex';
  },

  updateTermPreview() {
    const preview = document.getElementById('term-preview-box');
    const font = document.getElementById('term-font-family').value;
    const size = document.getElementById('term-font-size').value;
    const lh = document.getElementById('term-line-height').value;
    preview.style.fontFamily = font;
    preview.style.fontSize = size + 'px';
    preview.style.lineHeight = lh;
  },

  applyTermSettings() {
    this.termSettings.fontFamily = document.getElementById('term-font-family').value;
    this.termSettings.fontSize = parseFloat(document.getElementById('term-font-size').value) || 14;
    this.termSettings.lineHeight = parseFloat(document.getElementById('term-line-height').value) || 1.3;
    this.termSettings.encoding = document.getElementById('term-encoding').value;
    this.saveTermSettings();
    // 对所有已打开终端实时生效
    this.tabs.forEach(tab => {
      if (tab.terminal) {
        tab.terminal.options.fontFamily = this.termSettings.fontFamily;
        tab.terminal.options.fontSize = this.termSettings.fontSize;
        tab.terminal.options.lineHeight = this.termSettings.lineHeight;
        if (tab.fitAddon) try { tab.fitAddon.fit(); } catch(e) {}
      }
    });
    document.getElementById('term-settings-overlay').style.display = 'none';
  },

  resetTermSettings() {
    this.termSettings = {
      fontFamily: '"Cascadia Code","Fira Code","JetBrains Mono",Consolas,monospace',
      fontSize: 14,
      lineHeight: 1.3,
      encoding: 'utf-8'
    };
    this.saveTermSettings();
    // 重新打开弹窗以刷新表单
    document.getElementById('term-settings-overlay').style.display = 'none';
    setTimeout(() => this.openTermSettings(), 50);
  },

  // ===== SFTP 面板 =====
  sftp: {
    sessionId: null,     // 当前 SFTP 绑定的 SSH 会话 ID
    connName: '',        // 当前连接名称（显示用）
    currentPath: '/',
    history: [],         // 路径历史（用于后退）
    collapsed: false,
    contextMenu: null,
    selectedItem: null,  // 右键选中项
    cutItem: null,       // 剪切项
    _resizing: false,
    tasks: []            // 传输任务列表
  },

  async sftpAutoConnect(tab) {
    // 延迟 300ms 等待 SSH shell 稳定后再开 SFTP 子通道
    await new Promise(r => setTimeout(r, 300));
    const panel = document.getElementById('sftp-panel');
    panel.style.display = 'flex';
    this.sftp.sessionId = tab.sessionId;
    this.sftp.connName = tab.config.name || tab.config.host;
    this.sftp.currentPath = '/';
    this.sftp.history = [];
    document.getElementById('sftp-host-label').textContent = this.sftp.connName;
    this.sftpShowLoading(true);

    const r = await window.sshAPI.sftpConnect(tab.sessionId);
    this.sftpShowLoading(false);
    if (!r.success) {
      this.sftpShowError('SFTP 连接失败：' + r.error);
      return;
    }
    
    // 检查是否有缓存的 cd 命令
    if (tab._pendingCdCommand) {
      this.sftpSyncPath(tab._pendingCdCommand);
      delete tab._pendingCdCommand;
    } else {
      // 初始化成功，加载根目录
      await this.sftpNavigateTo('/');
    }
  },

  sftpShowLoading(show) {
    document.getElementById('sftp-loading').style.display = show ? 'flex' : 'none';
    document.getElementById('sftp-file-list').style.display = show ? 'none' : 'flex';
    document.getElementById('sftp-error').style.display = 'none';
  },

  sftpShowError(msg) {
    const el = document.getElementById('sftp-error');
    el.textContent = msg;
    el.style.display = 'block';
    document.getElementById('sftp-loading').style.display = 'none';
  },

  async sftpNavigateTo(path) {
    if (!this.sftp.sessionId) return;
    this.sftpShowLoading(true);
    const r = await window.sshAPI.sftpList(this.sftp.sessionId, path);
    this.sftpShowLoading(false);
    if (!r.success) {
      this.sftpShowError('无法读取目录：' + r.error);
      return;
    }
    if (path !== this.sftp.currentPath) {
      this.sftp.history.push(this.sftp.currentPath);
    }
    this.sftp.currentPath = path;
    // 更新路径输入框
    const pathInput = document.getElementById('sftp-path-input');
    if (pathInput) {
      pathInput.value = path;
    }
    this.sftpRenderList(r.list);
  },

  sftpRenderList(list) {
    const container = document.getElementById('sftp-file-list');
    container.innerHTML = '';
    // 切换目录时重置下载按钮
    const dlBtn = document.getElementById('btn-sftp-download');
    if (dlBtn) dlBtn.disabled = true;
    this.sftp.selectedItem = null;

    // 表头
    const header = document.createElement('div');
    header.className = 'sftp-file-list-header';
    header.innerHTML = `
      <span style="padding-left:22px">名称</span>
      <span class="h-size">大小</span>
      <span class="h-mtime">修改时间</span>
    `;
    container.appendChild(header);

    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sftp-empty';
      empty.textContent = '目录为空';
      container.appendChild(empty);
      return;
    }

    list.forEach(item => {
      if (item.name === '.' || item.name === '..') return;
      const row = document.createElement('div');
      row.className = 'sftp-file-item';
      const icon = item.isDir ? '📁' : (item.isSymlink ? '🔗' : this.sftpFileIcon(item.name));
      const nameClass = item.isDir ? 'is-dir' : (item.isSymlink ? 'is-symlink' : '');
      const sizeStr = item.isDir ? '-' : this.sftpFormatSize(item.size);
      const mtimeStr = this.sftpFormatTime(item.mtime);

      row.innerHTML = `
        <span class="sftp-file-icon">${icon}</span>
        <span class="sftp-file-name ${nameClass}">${escapeHtml(item.name)}</span>
        <span class="sftp-file-size">${sizeStr}</span>
        <span class="sftp-file-mtime">${mtimeStr}</span>
      `;
      row.dataset.name = item.name;
      row.dataset.isDir = item.isDir ? '1' : '0';

      // 双击：进入目录 或 下载文件
      row.addEventListener('dblclick', () => {
        if (item.isDir) {
          this.sftpNavigateTo(this.sftpJoin(this.sftp.currentPath, item.name));
        } else {
          this.sftpDownloadFile(item.name);
        }
      });

      // 右键菜单
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.sftp.selectedItem = item;
        this.sftpShowContextMenu(e, item);
      });

      // 单击选中（高亮）
      row.addEventListener('click', () => {
        container.querySelectorAll('.sftp-file-item').forEach(r2 => r2.classList.remove('selected'));
        row.classList.add('selected');
        this.sftp.selectedItem = item;
        // 文件和目录都可以下载
        const dlBtn = document.getElementById('btn-sftp-download');
        if (dlBtn) dlBtn.disabled = false;
      });

      container.appendChild(row);
    });
  },

  sftpShowContextMenu(e, item) {
    this.sftpCloseContextMenu();
    const menu = document.createElement('div');
    menu.className = 'sftp-context-menu';
    const fullPath = this.sftpJoin(this.sftp.currentPath, item.name);

    if (item.isDir) {
      menu.innerHTML = `
        <div class="sftp-context-menu-item" data-act="open">📂 打开</div>
        <div class="sftp-context-menu-item" data-act="download">⬇ 下载目录</div>
        <div class="sftp-context-menu-sep"></div>
        <div class="sftp-context-menu-item" data-act="rename">✏ 重命名</div>
        <div class="sftp-context-menu-item danger" data-act="delete">🗑 删除目录</div>
      `;
    } else {
      menu.innerHTML = `
        <div class="sftp-context-menu-item" data-act="download">⬇ 下载</div>
        <div class="sftp-context-menu-sep"></div>
        <div class="sftp-context-menu-item" data-act="rename">✏ 重命名</div>
        <div class="sftp-context-menu-item danger" data-act="delete">🗑 删除文件</div>
      `;
    }

    menu.style.left = Math.min(e.clientX, window.innerWidth - 180) + 'px';
    menu.style.top = Math.min(e.clientY, window.innerHeight - 150) + 'px';
    document.body.appendChild(menu);
    this.sftp.contextMenu = menu;

    menu.querySelector('[data-act="open"]')?.addEventListener('click', () => {
      this.sftpCloseContextMenu();
      this.sftpNavigateTo(fullPath);
    });
    menu.querySelector('[data-act="download"]')?.addEventListener('click', () => {
      this.sftpCloseContextMenu();
      if (item.isDir) {
        this.sftpDownloadDir(item.name);
      } else {
        this.sftpDownloadFile(item.name);
      }
    });
    menu.querySelector('[data-act="rename"]')?.addEventListener('click', () => {
      this.sftpCloseContextMenu();
      this.sftpRenameItem(item.name, fullPath);
    });
    menu.querySelector('[data-act="delete"]')?.addEventListener('click', () => {
      this.sftpCloseContextMenu();
      this.sftpDeleteItem(item.name, fullPath, item.isDir);
    });

    setTimeout(() => document.addEventListener('click', this._sftpMenuClose = () => this.sftpCloseContextMenu(), { once: true }), 10);
  },

  sftpCloseContextMenu() {
    if (this.sftp.contextMenu) { this.sftp.contextMenu.remove(); this.sftp.contextMenu = null; }
  },

  async sftpDownloadFile(name) {
    const remotePath = this.sftpJoin(this.sftp.currentPath, name);
    const result = await window.sshAPI.showSaveDialog({
      defaultPath: name,
      title: '保存文件'
    });
    if (result.canceled || !result.filePath) return;
    
    // 添加下载任务
    const taskId = this.sftpAddTask('download', name, result.filePath, remotePath);
    
    // 模拟进度更新
    let progress = 0;
    const interval = setInterval(() => {
      progress = Math.min(100, progress + Math.random() * 10);
      this.sftpUpdateTaskProgress(taskId, progress);
    }, 500);
    
    try {
      const r = await window.sshAPI.sftpDownload(this.sftp.sessionId, remotePath, result.filePath);
      clearInterval(interval);
      this.sftpCompleteTask(taskId, r.success, r.error);
      if (!r.success) {
        this.sftpShowError('下载失败：' + r.error);
        setTimeout(() => this.sftpNavigateTo(this.sftp.currentPath), 2000);
      } else {
        this.sftpShowToast(`✓ 下载完成：${name}`);
        await this.sftpNavigateTo(this.sftp.currentPath);
      }
    } catch (error) {
      clearInterval(interval);
      this.sftpCompleteTask(taskId, false, error.message);
      this.sftpShowError('下载失败：' + error.message);
      setTimeout(() => this.sftpNavigateTo(this.sftp.currentPath), 2000);
    }
  },

  async sftpDownloadDir(name) {
    const remotePath = this.sftpJoin(this.sftp.currentPath, name);
    // 让用户选择保存到哪个本地目录
    const result = await window.sshAPI.showOpenDialog({
      title: '选择保存目录',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) return;
    const localBase = result.filePaths[0];
    // 在本地目标目录下创建同名子目录
    const sep = localBase.includes('/') ? '/' : '\\';
    const localPath = localBase.replace(/[/\\]$/, '') + sep + name;
    
    // 添加下载任务
    const taskId = this.sftpAddTask('download', name, localPath, remotePath);
    
    // 模拟进度更新
    let progress = 0;
    const interval = setInterval(() => {
      progress = Math.min(100, progress + Math.random() * 5);
      this.sftpUpdateTaskProgress(taskId, progress);
    }, 800);
    
    try {
      const r = await window.sshAPI.sftpDownloadDir(this.sftp.sessionId, remotePath, localPath);
      clearInterval(interval);
      this.sftpCompleteTask(taskId, r.success, r.error);
      if (!r.success) {
        this.sftpShowError('目录下载失败：' + r.error);
        setTimeout(() => this.sftpNavigateTo(this.sftp.currentPath), 2000);
      } else {
        this.sftpShowToast(`✓ 目录下载完成：${name}`);
      }
    } catch (error) {
      clearInterval(interval);
      this.sftpCompleteTask(taskId, false, error.message);
      this.sftpShowError('目录下载失败：' + error.message);
      setTimeout(() => this.sftpNavigateTo(this.sftp.currentPath), 2000);
    }
  },

  sftpShowToast(msg, duration = 3000) {
    let toast = document.getElementById('sftp-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'sftp-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.className = 'sftp-toast show';
    clearTimeout(this._sftpToastTimer);
    this._sftpToastTimer = setTimeout(() => toast.classList.remove('show'), duration);
  },

  async sftpUploadFiles() {
    const result = await window.sshAPI.showOpenDialog({
      title: '选择要上传的文件',
      properties: ['openFile', 'multiSelections']
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) return;

    let failCount = 0;
    for (const localPath of result.filePaths) {
      const fileName = localPath.split(/[/\\]/).pop();
      const remotePath = this.sftpJoin(this.sftp.currentPath, fileName);
      
      // 添加上传任务
      const taskId = this.sftpAddTask('upload', fileName, localPath, remotePath);
      
      // 模拟进度更新
      let progress = 0;
      const interval = setInterval(() => {
        progress = Math.min(100, progress + Math.random() * 10);
        this.sftpUpdateTaskProgress(taskId, progress);
      }, 500);
      
      try {
        const r = await window.sshAPI.sftpUpload(this.sftp.sessionId, localPath, remotePath);
        clearInterval(interval);
        this.sftpCompleteTask(taskId, r.success, r.error);
        if (!r.success) failCount++;
      } catch (error) {
        clearInterval(interval);
        this.sftpCompleteTask(taskId, false, error.message);
        failCount++;
      }
    }
    
    if (failCount > 0) {
      this.sftpShowError(`${failCount} 个文件上传失败`);
      setTimeout(() => this.sftpNavigateTo(this.sftp.currentPath), 2000);
    } else {
      await this.sftpNavigateTo(this.sftp.currentPath);
    }
  },

  async sftpMkdir() {
    // 使用自定义输入弹窗
    this.sftpShowInputModal('新建目录', '请输入目录名称：', '', async (name) => {
      if (!name) return;
      const remotePath = this.sftpJoin(this.sftp.currentPath, name);
      const r = await window.sshAPI.sftpMkdir(this.sftp.sessionId, remotePath);
      if (!r.success) {
        this.sftpShowError('创建目录失败：' + r.error);
        setTimeout(() => this.sftpNavigateTo(this.sftp.currentPath), 2000);
      } else {
        await this.sftpNavigateTo(this.sftp.currentPath);
      }
    });
  },

  async sftpRenameItem(oldName, fullOldPath) {
    this.sftpShowInputModal('重命名', '请输入新名称：', oldName, async (newName) => {
      if (!newName || newName === oldName) return;
      const newPath = this.sftpJoin(this.sftp.currentPath, newName);
      const r = await window.sshAPI.sftpRename(this.sftp.sessionId, fullOldPath, newPath);
      if (!r.success) {
        this.sftpShowError('重命名失败：' + r.error);
        setTimeout(() => this.sftpNavigateTo(this.sftp.currentPath), 2000);
      } else {
        await this.sftpNavigateTo(this.sftp.currentPath);
      }
    });
  },

  async sftpDeleteItem(name, fullPath, isDir) {
    const what = isDir ? '目录（仅支持空目录）' : '文件';
    if (!confirm(`确定要删除${what}：${name} ？`)) return;
    const r = await window.sshAPI.sftpDelete(this.sftp.sessionId, fullPath, isDir);
    if (!r.success) {
      this.sftpShowError('删除失败：' + r.error);
      setTimeout(() => this.sftpNavigateTo(this.sftp.currentPath), 2000);
    } else {
      await this.sftpNavigateTo(this.sftp.currentPath);
    }
  },

  sftpShowInputModal(title, label, defaultVal, callback) {
    // 复用新建分组弹窗结构，动态创建一个简单输入弹窗
    let overlay = document.getElementById('sftp-input-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'sftp-input-overlay';
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal" style="max-width:380px;" id="modal-sftp-input">
          <div class="modal-header">
            <span id="sftp-input-title"></span>
            <button class="btn-icon" id="sftp-input-close">✕</button>
          </div>
          <div class="modal-body">
            <div class="form-row">
              <label id="sftp-input-label"></label>
              <input type="text" id="sftp-input-value" />
            </div>
          </div>
          <div class="modal-footer">
            <div class="flex-gap">
              <button class="btn-secondary" id="sftp-input-cancel">取消</button>
              <button class="btn-primary" id="sftp-input-confirm">确定</button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
    }

    document.getElementById('sftp-input-title').textContent = title;
    document.getElementById('sftp-input-label').textContent = label;
    const input = document.getElementById('sftp-input-value');
    input.value = defaultVal || '';
    overlay.style.display = 'flex';
    setTimeout(() => { input.focus(); input.select(); }, 50);

    const close = () => { overlay.style.display = 'none'; };
    const confirm2 = () => { const v = input.value.trim(); close(); if (v) callback(v); };

    // 重新绑定（防止多次点击叠加）
    const btnConfirm = document.getElementById('sftp-input-confirm');
    const btnCancel = document.getElementById('sftp-input-cancel');
    const btnClose = document.getElementById('sftp-input-close');
    btnConfirm.onclick = confirm2;
    btnCancel.onclick = close;
    btnClose.onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    document.getElementById('modal-sftp-input').onkeydown = (e) => {
      if (e.key === 'Enter') confirm2();
      if (e.key === 'Escape') close();
    };
  },

  sftpClose() {
    const panel = document.getElementById('sftp-panel');
    panel.style.display = 'none';
    if (this.sftp.sessionId) {
      window.sshAPI.sftpDisconnect(this.sftp.sessionId);
      this.sftp.sessionId = null;
    }
    this.sftp.tasks = [];
  },
  
  // ===== 传输任务管理 =====
  
  // 添加传输任务
  sftpAddTask(type, name, localPath, remotePath) {
    const task = {
      id: 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
      type: type, // 'upload' or 'download'
      name: name,
      localPath: localPath,
      remotePath: remotePath,
      status: 'pending', // 'pending', 'progress', 'success', 'error'
      progress: 0,
      speed: 0,
      startTime: Date.now(),
      endTime: null
    };
    
    this.sftp.tasks.push(task);
    this.sftpShowTaskList(true);
    this.sftpRenderTasks();
    return task.id;
  },
  
  // 更新任务进度
  sftpUpdateTaskProgress(taskId, progress, speed = 0) {
    const task = this.sftp.tasks.find(t => t.id === taskId);
    if (task) {
      task.status = 'progress';
      task.progress = Math.min(100, Math.max(0, progress));
      task.speed = speed;
      this.sftpRenderTasks();
    }
  },
  
  // 完成任务
  sftpCompleteTask(taskId, success, error = null) {
    const task = this.sftp.tasks.find(t => t.id === taskId);
    if (task) {
      task.status = success ? 'success' : 'error';
      task.endTime = Date.now();
      if (error) task.error = error;
      this.sftpRenderTasks();
    }
  },
  
  // 同步终端 cd 命令到 SFTP 目录
  sftpSyncPath(path) {
    if (!this.sftp.sessionId) return;
    
    let targetPath = path;
    // 处理相对路径
    if (!path.startsWith('/')) {
      // 解析路径，处理 .. 和 .
      const parts = this.sftp.currentPath.split('/').filter(p => p);
      const pathParts = path.split('/');
      
      for (const part of pathParts) {
        if (part === '..') {
          // 向上一级
          parts.pop();
        } else if (part === '.') {
          // 当前目录，忽略
          continue;
        } else if (part) {
          // 正常目录
          parts.push(part);
        }
      }
      
      targetPath = '/' + parts.join('/');
    }
    
    // 尝试同步到新路径
    this.sftpNavigateTo(targetPath).catch(err => {
      // 忽略权限错误
      console.log('SFTP 路径同步失败（可能权限不足）:', err);
    });
  },
  
  // 显示/隐藏任务列表
  sftpShowTaskList(show) {
    const list = document.getElementById('sftp-task-list');
    if (list) {
      list.style.display = show ? 'block' : 'none';
    }
  },
  
  // 渲染任务列表
  sftpRenderTasks() {
    const container = document.getElementById('sftp-task-items');
    if (!container) return;
    
    container.innerHTML = '';
    
    if (this.sftp.tasks.length === 0) {
      container.innerHTML = '<div style="padding: 12px; text-align: center; color: var(--text-muted); font-size: 11px;">暂无传输任务</div>';
      return;
    }
    
    this.sftp.tasks.forEach(task => {
      const item = document.createElement('div');
      item.className = 'sftp-task-item';
      
      const icon = task.type === 'upload' ? '⬆' : '⬇';
      const statusIcon = task.status === 'success' ? '✓' : 
                       task.status === 'error' ? '✕' : 
                       task.status === 'progress' ? '⟳' : '⏳';
      const statusClass = task.status === 'success' ? 'success' : 
                         task.status === 'error' ? 'error' : 'pending';
      
      const localPath = task.localPath ? task.localPath.replace(/^.*[\\/]/, '') : '';
      const remotePath = task.remotePath ? task.remotePath.replace(/^.*[\\/]/, '') : '';
      
      item.innerHTML = `
        <div class="sftp-task-icon">${icon}</div>
        <div class="sftp-task-info">
          <div class="sftp-task-name">${escapeHtml(task.name)}</div>
          <div class="sftp-task-path">${escapeHtml(localPath)} → ${escapeHtml(remotePath)}</div>
          ${task.status === 'progress' ? `
          <div class="sftp-task-progress">
            <div class="sftp-task-progress-bar">
              <div class="sftp-task-progress-fill" style="width: ${task.progress}%"></div>
            </div>
            <div class="sftp-task-progress-text">${task.progress.toFixed(1)}%</div>
          </div>
          ` : ''}
        </div>
        <div class="sftp-task-status ${statusClass}">${statusIcon}</div>
      `;
      
      container.appendChild(item);
    });
  },
  
  // 清空完成的任务
  sftpClearCompletedTasks() {
    this.sftp.tasks = this.sftp.tasks.filter(t => t.status === 'pending' || t.status === 'progress');
    this.sftpRenderTasks();
    if (this.sftp.tasks.length === 0) {
      this.sftpShowTaskList(false);
    }
  },

  sftpToggleCollapse() {
    const panel = document.getElementById('sftp-panel');
    const btn = document.getElementById('btn-sftp-toggle');
    this.sftp.collapsed = !this.sftp.collapsed;
    panel.classList.toggle('collapsed', this.sftp.collapsed);
    btn.textContent = this.sftp.collapsed ? '▲' : '▼';
  },

  sftpUp() {
    const cur = this.sftp.currentPath;
    if (cur === '/') return;
    const parent = cur.replace(/\/[^/]+\/?$/, '') || '/';
    this.sftpNavigateTo(parent);
  },

  sftpGoHome() {
    this.sftpNavigateTo('/');
  },

  // 工具：路径拼接
  sftpJoin(base, name) {
    if (base === '/') return '/' + name;
    return base.replace(/\/$/, '') + '/' + name;
  },

  // 工具：格式化文件大小
  sftpFormatSize(bytes) {
    if (bytes == null) return '-';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  },

  // 工具：格式化时间
  sftpFormatTime(mtime) {
    if (!mtime) return '-';
    const d = new Date(mtime * 1000);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },

  // 工具：根据扩展名返回文件图标
  sftpFileIcon(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    const map = {
      js: '📜', ts: '📜', jsx: '📜', tsx: '📜',
      py: '🐍', rb: '💎', go: '🐹', rs: '🦀', java: '☕',
      html: '🌐', css: '🎨', scss: '🎨', less: '🎨',
      json: '📋', xml: '📋', yaml: '📋', yml: '📋', toml: '📋',
      md: '📝', txt: '📝', log: '📋',
      sh: '⚙', bash: '⚙', zsh: '⚙',
      zip: '📦', tar: '📦', gz: '📦', bz2: '📦', rar: '📦', '7z': '📦',
      jpg: '🖼', jpeg: '🖼', png: '🖼', gif: '🖼', svg: '🖼', webp: '🖼',
      mp4: '🎬', mkv: '🎬', avi: '🎬', mov: '🎬',
      mp3: '🎵', wav: '🎵', flac: '🎵',
      pdf: '📕', doc: '📄', docx: '📄', xls: '📊', xlsx: '📊',
      db: '🗄', sql: '🗄',
    };
    return map[ext] || '📄';
  },

  // SFTP 面板拖拽调整高度
  sftpInitResize() {
    const panel = document.getElementById('sftp-panel');
    const handle = document.createElement('div');
    handle.className = 'sftp-resize-handle';
    panel.prepend(handle);

    let startY = 0, startH = 0;
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startY = e.clientY;
      startH = panel.offsetHeight;
      const onMove = (ev) => {
        const delta = startY - ev.clientY;
        const newH = Math.max(80, Math.min(window.innerHeight * 0.7, startH + delta));
        panel.style.height = newH + 'px';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  },

  // SFTP 拖拽上传文件
  sftpInitDragDrop() {
    const panel = document.getElementById('sftp-panel');
    panel.addEventListener('dragover', (e) => {
      e.preventDefault();
      panel.classList.add('drag-over');
    });
    panel.addEventListener('dragleave', (e) => {
      if (!panel.contains(e.relatedTarget)) panel.classList.remove('drag-over');
    });
    panel.addEventListener('drop', async (e) => {
      e.preventDefault();
      panel.classList.remove('drag-over');
      if (!this.sftp.sessionId) return;
      
      const items = Array.from(e.dataTransfer.items);
      if (items.length === 0) return;
      
      this.sftpShowLoading(true);
      let failCount = 0;
      
      // 处理所有拖拽项（文件和文件夹）
      for (const item of items) {
        if (item.kind === 'file') {
          const entry = item.webkitGetAsEntry();
          if (entry) {
            const result = await this.sftpUploadEntry(entry, this.sftp.currentPath);
            if (!result.success) failCount++;
          }
        }
      }
      
      this.sftpShowLoading(false);
      if (failCount > 0) {
        this.sftpShowError(`${failCount} 个项目上传失败`);
        setTimeout(() => this.sftpNavigateTo(this.sftp.currentPath), 2000);
      } else {
        await this.sftpNavigateTo(this.sftp.currentPath);
      }
    });
  },
  
  // 上传文件或文件夹（递归）
  async sftpUploadEntry(entry, remoteBasePath) {
    if (entry.isFile) {
      // 上传单个文件
      return new Promise((resolve) => {
        entry.file(async (file) => {
          const remotePath = this.sftpJoin(remoteBasePath, entry.name);
          
          // 添加上传任务
          const taskId = this.sftpAddTask('upload', entry.name, file.path, remotePath);
          
          // 模拟进度更新
          let progress = 0;
          const interval = setInterval(() => {
            progress = Math.min(100, progress + Math.random() * 10);
            this.sftpUpdateTaskProgress(taskId, progress);
          }, 500);
          
          try {
            const r = await window.sshAPI.sftpUpload(this.sftp.sessionId, file.path, remotePath);
            clearInterval(interval);
            this.sftpCompleteTask(taskId, r.success, r.error);
            resolve(r);
          } catch (error) {
            clearInterval(interval);
            this.sftpCompleteTask(taskId, false, error.message);
            resolve({ success: false, error: error.message });
          }
        }, () => {
          resolve({ success: false, error: '无法读取文件' });
        });
      });
    } else if (entry.isDirectory) {
      // 创建远程目录
      const remoteDirPath = this.sftpJoin(remoteBasePath, entry.name);
      const mkdirResult = await window.sshAPI.sftpMkdir(this.sftp.sessionId, remoteDirPath);
      if (!mkdirResult.success) {
        return mkdirResult;
      }
      
      // 递归上传目录内容
      let failCount = 0;
      const reader = entry.createReader();
      
      async function readEntries() {
        const entries = await new Promise((resolve) => {
          reader.readEntries(resolve);
        });
        
        for (const subEntry of entries) {
          const result = await this.sftpUploadEntry(subEntry, remoteDirPath);
          if (!result.success) failCount++;
        }
        
        if (entries.length > 0) {
          await readEntries.call(this);
        }
      }
      
      await readEntries.call(this);
      return { success: failCount === 0, error: failCount > 0 ? `${failCount} 个文件上传失败` : null };
    }
    return { success: false, error: '未知项目类型' };
  },

  // ===== 事件绑定 =====
  bindEvents() {
    // 标题栏窗口控制
    document.getElementById('btn-minimize').addEventListener('click', () => window.sshAPI.winMinimize());
    document.getElementById('btn-maximize').addEventListener('click', () => window.sshAPI.winMaximize());
    document.getElementById('btn-close').addEventListener('click', () => window.sshAPI.winClose());

    // 新建连接
    document.getElementById('btn-new-conn').addEventListener('click', () => this.openNewConnModal());
    document.getElementById('btn-welcome-new').addEventListener('click', () => this.openNewConnModal());
    document.getElementById('btn-manage').addEventListener('click', () => this.openManageModal());
    document.getElementById('btn-db-settings').addEventListener('click', () => this.openDbSettings());

    // 连接弹窗
    document.getElementById('modal-close').addEventListener('click', () => { document.getElementById('modal-overlay').style.display = 'none'; });
    document.getElementById('btn-cancel-conn').addEventListener('click', () => { document.getElementById('modal-overlay').style.display = 'none'; });
    document.getElementById('btn-save-conn').addEventListener('click', () => this.saveConnection());
    document.getElementById('btn-test-conn').addEventListener('click', () => this.testConnection());
    document.getElementById('manage-close').addEventListener('click', () => { document.getElementById('manage-overlay').style.display = 'none'; });

    // 认证方式切换
    document.querySelectorAll('[name=auth-type]').forEach(radio => {
      radio.addEventListener('change', (e) => this.toggleAuthType(e.target.value));
    });
    // X11 转发开关
    document.getElementById('conn-x11-forwarding').addEventListener('change', (e) => {
      document.getElementById('x11-display-row').style.display = e.target.checked ? '' : 'none';
    });
    document.getElementById('btn-toggle-pwd').addEventListener('click', () => {
      const input = document.getElementById('conn-password');
      input.type = input.type === 'password' ? 'text' : 'password';
    });

    // 新建分组（自定义弹窗，替代 prompt）
    document.getElementById('btn-add-group').addEventListener('click', () => {
      document.getElementById('new-group-name').value = '';
      document.getElementById('add-group-overlay').style.display = 'flex';
      setTimeout(() => document.getElementById('new-group-name').focus(), 50);
    });

    const confirmAddGroup = async () => {
      const name = document.getElementById('new-group-name').value.trim();
      if (!name) { document.getElementById('new-group-name').focus(); return; }
      document.getElementById('add-group-overlay').style.display = 'none';
      this.groups = await window.sshAPI.saveGroup(name);
      this.renderGroupSelect(name);
    };

    document.getElementById('btn-confirm-group').addEventListener('click', confirmAddGroup);
    document.getElementById('btn-cancel-group').addEventListener('click', () => {
      document.getElementById('add-group-overlay').style.display = 'none';
    });
    document.getElementById('add-group-close').addEventListener('click', () => {
      document.getElementById('add-group-overlay').style.display = 'none';
    });
    document.getElementById('modal-add-group').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') confirmAddGroup();
      if (e.key === 'Escape') document.getElementById('add-group-overlay').style.display = 'none';
    });
    document.getElementById('add-group-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'add-group-overlay') document.getElementById('add-group-overlay').style.display = 'none';
    });

    // 搜索
    document.getElementById('search-input').addEventListener('input', () => this.renderSidebar());

    // 排序按钮
    document.querySelectorAll('.sort-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.connSortMode = btn.dataset.sort;
        document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.renderSidebar();
      });
    });

    // 标签栏按钮
    document.getElementById('btn-add-tab').addEventListener('click', () => this.openNewConnModal());
    document.getElementById('btn-split-h').addEventListener('click', () => this.toggleSplit());
    document.getElementById('btn-multi-win').addEventListener('click', () => this.openNewWindow());
    document.getElementById('btn-term-settings').addEventListener('click', () => this.openTermSettings());
    document.getElementById('btn-cmd-input').addEventListener('click', () => this.toggleCmdInputPanel());

    // 指令发送窗口事件
    document.getElementById('btn-cmd-send').addEventListener('click', () => this.sendCmdInput());
    document.getElementById('btn-cmd-clear').addEventListener('click', () => {
      document.getElementById('cmd-input-text').value = '';
      document.getElementById('cmd-input-text').style.height = 'auto';
    });
    document.getElementById('btn-cmd-clear-history').addEventListener('click', () => this.clearCmdHistory());
    document.getElementById('btn-cmd-toggle').addEventListener('click', () => this.toggleCmdInputCollapse());
    document.getElementById('btn-cmd-close').addEventListener('click', () => this.closeCmdInput());
    document.getElementById('cmd-input-text').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendCmdInput();
      }
    });
    document.getElementById('cmd-input-text').addEventListener('input', () => {
      const ta = document.getElementById('cmd-input-text');
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
    });

    // Enter 键保存连接
    document.getElementById('modal-conn').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') this.saveConnection();
    });

    // 点击遮罩关闭弹窗
    ['manage-overlay', 'quick-cmd-overlay', 'db-overlay', 'add-group-overlay', 'term-settings-overlay'].forEach(id => {
      document.getElementById(id).addEventListener('click', (e) => {
        if (e.target.id === id) document.getElementById(id).style.display = 'none';
      });
    });

    // 快捷指令弹窗
    document.getElementById('btn-add-quick-cmd').addEventListener('click', () => this.openQuickCmdModal());
    document.getElementById('btn-toggle-quick-cmd').addEventListener('click', () => this.toggleQuickCmdBar());
    document.getElementById('quick-cmd-modal-close').addEventListener('click', () => { document.getElementById('quick-cmd-overlay').style.display = 'none'; });
    document.getElementById('btn-cancel-qcmd').addEventListener('click', () => { document.getElementById('quick-cmd-overlay').style.display = 'none'; });
    document.getElementById('btn-save-qcmd').addEventListener('click', () => this.saveQuickCommand());
    document.getElementById('quick-cmd-category').addEventListener('change', () => this.renderQuickCommands());
    // Enter 键保存快捷指令
    document.getElementById('modal-quick-cmd').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') this.saveQuickCommand();
    });

    // 数据库设置弹窗
    document.getElementById('db-modal-close').addEventListener('click', () => { document.getElementById('db-overlay').style.display = 'none'; });

    document.getElementById('btn-use-sqlite').addEventListener('click', async () => {
      const r = window.sshAPI.switchSQLite();
      document.getElementById('db-current-type').textContent = 'SQLite（本地）';
      document.getElementById('db-mysql-addr').textContent = '';
      document.getElementById('mysql-config-area').style.display = 'none';
      await this.loadConnections();
      this.renderSidebar();
    });

    document.getElementById('btn-use-mysql').addEventListener('click', () => {
      document.getElementById('mysql-config-area').style.display = 'block';
    });

    document.getElementById('btn-test-mysql').addEventListener('click', async () => {
      this.setMysqlStatus('测试中...', 'info');
      const r = await window.sshAPI.testMySQL(this.getMysqlFormConfig());
      this.setMysqlStatus(r.success ? '✓ 连接成功' : '✕ ' + r.error, r.success ? 'success' : 'error');
    });

    document.getElementById('btn-connect-mysql').addEventListener('click', async () => {
      this.setMysqlStatus('正在连接...', 'info');
      const cfg = this.getMysqlFormConfig();
      const r = await window.sshAPI.switchMySQL(cfg);
      if (r.success) {
        this.setMysqlStatus('✓ 已切换至 MySQL', 'success');
        document.getElementById('db-current-type').textContent = 'MySQL';
        document.getElementById('db-mysql-addr').textContent = `${cfg.host}:${cfg.port}/${cfg.database}`;
        await this.loadConnections();
        this.renderSidebar();
      } else {
        this.setMysqlStatus('✕ ' + r.error, 'error');
      }
    });

    document.getElementById('btn-sync-s2m').addEventListener('click', async () => {
      if (!confirm('确定要将 SQLite 数据同步到 MySQL 吗？\n此操作可能会覆盖 MySQL 中的现有数据！')) {
        return;
      }
      this.setSyncStatus('同步中...', 'info');
      const r = await window.sshAPI.syncSQLiteToMySQL();
      this.setSyncStatus(r.success ? `✓ 已同步 ${r.count} 条连接` : '✕ ' + r.error, r.success ? 'success' : 'error');
    });

    document.getElementById('btn-sync-m2s').addEventListener('click', async () => {
      if (!confirm('确定要将 MySQL 数据同步到 SQLite 吗？\n此操作可能会覆盖 SQLite 中的现有数据！')) {
        return;
      }
      this.setSyncStatus('同步中...', 'info');
      const r = await window.sshAPI.syncMySQLToSQLite();
      this.setSyncStatus(r.success ? `✓ 已同步 ${r.count} 条连接` : '✕ ' + r.error, r.success ? 'success' : 'error');
      if (r.success) { await this.loadConnections(); this.renderSidebar(); }
    });

    document.getElementById('btn-export-data').addEventListener('click', async () => {
      const result = await window.sshAPI.showSaveDialog({
        defaultPath: 'ssh-client-backup.json',
        filters: [{ name: 'JSON', extensions: ['json'] }]
      });
      if (result.canceled || !result.filePath) return;
      const r = await window.sshAPI.exportData(result.filePath);
      this.setIOStatus(r.success ? '✓ 导出成功：' + result.filePath : '✕ ' + r.error, r.success ? 'success' : 'error');
    });

    document.getElementById('btn-import-data').addEventListener('click', async () => {
      const result = await window.sshAPI.showOpenDialog({
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile']
      });
      if (result.canceled || !result.filePaths || !result.filePaths[0]) return;
      const r = await window.sshAPI.importData(result.filePaths[0]);
      if (r.success) {
        this.setIOStatus('✓ 导入成功', 'success');
        await this.loadConnections();
        this.renderSidebar();
      } else {
        this.setIOStatus('✕ ' + r.error, 'error');
      }
    });

    // SFTP 面板按钮
    document.getElementById('btn-sftp-home').addEventListener('click', () => this.sftpGoHome());
    document.getElementById('btn-sftp-up').addEventListener('click', () => this.sftpUp());
    document.getElementById('btn-sftp-refresh').addEventListener('click', () => this.sftpNavigateTo(this.sftp.currentPath));
    document.getElementById('btn-sftp-upload').addEventListener('click', () => this.sftpUploadFiles());
    document.getElementById('btn-sftp-download').addEventListener('click', () => {
      if (!this.sftp.selectedItem) return;
      if (this.sftp.selectedItem.isDir) {
        this.sftpDownloadDir(this.sftp.selectedItem.name);
      } else {
        this.sftpDownloadFile(this.sftp.selectedItem.name);
      }
    });
    document.getElementById('btn-sftp-mkdir').addEventListener('click', () => this.sftpMkdir());
    document.getElementById('btn-sftp-toggle').addEventListener('click', () => this.sftpToggleCollapse());
    document.getElementById('btn-sftp-close').addEventListener('click', () => this.sftpClose());
    
    // 任务列表按钮
    document.getElementById('btn-sftp-task-clear').addEventListener('click', () => this.sftpClearCompletedTasks());
    document.getElementById('btn-sftp-task-close').addEventListener('click', () => this.sftpShowTaskList(false));
    
    // 路径输入框和复制按钮
    const pathInput = document.getElementById('sftp-path-input');
    if (pathInput) {
      pathInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          const path = pathInput.value.trim();
          if (path) {
            this.sftpNavigateTo(path);
          }
        }
      });
    }
    
    const copyPathBtn = document.getElementById('btn-sftp-copy-path');
    if (copyPathBtn) {
      copyPathBtn.addEventListener('click', () => {
        const path = this.sftp.currentPath;
        navigator.clipboard.writeText(path).then(() => {
          this.sftpShowToast('✓ 路径已复制到剪贴板');
        }).catch(() => {
          this.sftpShowToast('复制失败');
        });
      });
    }

    // 终端外观设置弹窗
    document.getElementById('term-settings-close').addEventListener('click', () => { document.getElementById('term-settings-overlay').style.display = 'none'; });
    document.getElementById('btn-term-settings-cancel').addEventListener('click', () => { document.getElementById('term-settings-overlay').style.display = 'none'; });
    document.getElementById('btn-term-settings-apply').addEventListener('click', () => this.applyTermSettings());
    document.getElementById('btn-term-settings-reset').addEventListener('click', () => this.resetTermSettings());
    // 实时预览
    ['term-font-family', 'term-font-size', 'term-line-height'].forEach(id => {
      document.getElementById(id).addEventListener('input', () => this.updateTermPreview());
      document.getElementById(id).addEventListener('change', () => this.updateTermPreview());
    });
  }
};

// ===== 工具函数 =====
function escapeHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
