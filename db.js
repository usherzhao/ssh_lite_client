/**
 * 数据库层：支持 SQLite (sql.js) 和 MySQL 双引擎
 * 数据加密：AES-256-GCM
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

// ===================== 加密工具 =====================
const CIPHER_KEY = 'ssh-client-aes256-secret-key-32b!'; // 32字节
const CIPHER_IV_LEN = 16;

function encrypt(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(CIPHER_IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(CIPHER_KEY.slice(0, 32)), iv);
  let encrypted = cipher.update(String(text), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text) {
  if (!text || !text.includes(':')) return text || '';
  try {
    const [ivHex, encrypted] = text.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(CIPHER_KEY.slice(0, 32)), iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    return text;
  }
}

// ===================== SQLite 实现 =====================
class SQLiteDB {
  constructor() {
    this.db = null;
    this.dataDir = null;
    this.dbPath = null;
  }

  async init() {
    const SQL = require('sql.js');
    this.dataDir = app ? app.getPath('userData') : path.join(__dirname, 'data');
    if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
    this.dbPath = path.join(this.dataDir, 'ssh_client.db');

    const sqlJs = await SQL({ locateFile: f => path.join(__dirname, 'node_modules/sql.js/dist/', f) });

    if (fs.existsSync(this.dbPath)) {
      const buf = fs.readFileSync(this.dbPath);
      this.db = new sqlJs.Database(buf);
    } else {
      this.db = new sqlJs.Database();
    }
    this._createTables();
    this._save();
    return this;
  }

  _createTables() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL
      )
    `);
    this.db.run(`INSERT OR IGNORE INTO groups (name) VALUES ('默认分组')`);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER DEFAULT 22,
        username TEXT NOT NULL,
        auth_type TEXT DEFAULT 'password',
        password TEXT,
        private_key TEXT,
        passphrase TEXT,
        group_name TEXT DEFAULT '默认分组',
        note TEXT,
        init_commands TEXT,
        x11_forwarding INTEGER DEFAULT 0,
        x11_display TEXT DEFAULT 'localhost:0',
        created_at TEXT,
        updated_at TEXT
      )
    `);
    // 兼容旧库：若列不存在则添加
    try { this.db.run(`ALTER TABLE connections ADD COLUMN init_commands TEXT`); } catch(e) {}
    try { this.db.run(`ALTER TABLE connections ADD COLUMN x11_forwarding INTEGER DEFAULT 0`); } catch(e) {}
    try { this.db.run(`ALTER TABLE connections ADD COLUMN x11_display TEXT DEFAULT 'localhost:0'`); } catch(e) {}
    try { this.db.run(`ALTER TABLE connections ADD COLUMN sort_order INTEGER DEFAULT 0`); } catch(e) {}

    this.db.run(`
      CREATE TABLE IF NOT EXISTS quick_commands (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        command TEXT NOT NULL,
        category TEXT DEFAULT '常用',
        sort_order INTEGER DEFAULT 0,
        created_at TEXT
      )
    `);
  }

  _save() {
    if (!this.dbPath) return;
    const data = this.db.export();
    fs.writeFileSync(this.dbPath, Buffer.from(data));
  }

  // ===== Groups =====
  getGroups() {
    const res = this.db.exec('SELECT name FROM groups ORDER BY id');
    if (!res.length) return ['默认分组'];
    return res[0].values.map(r => r[0]);
  }

  saveGroup(name) {
    this.db.run('INSERT OR IGNORE INTO groups (name) VALUES (?)', [name]);
    this._save();
    return this.getGroups();
  }

  deleteGroup(name) {
    if (name === '默认分组') return false;
    this.db.run('UPDATE connections SET group_name=? WHERE group_name=?', ['默认分组', name]);
    this.db.run('DELETE FROM groups WHERE name=?', [name]);
    this._save();
    return true;
  }

  // ===== Connections =====
  getConnections() {
    const res = this.db.exec('SELECT * FROM connections ORDER BY sort_order, group_name, name');
    if (!res.length) return [];
    const cols = res[0].columns;
    return res[0].values.map(row => {
      const obj = {};
      cols.forEach((c, i) => obj[c] = row[i]);
      return {
        id: obj.id,
        name: obj.name,
        host: obj.host,
        port: obj.port,
        username: obj.username,
        authType: obj.auth_type,
        password: decrypt(obj.password),
        privateKey: decrypt(obj.private_key),
        passphrase: decrypt(obj.passphrase),
        group: obj.group_name,
        note: obj.note,
        initCommands: obj.init_commands || '',
        x11Forwarding: !!obj.x11_forwarding,
        x11Display: obj.x11_display || 'localhost:0',
        sortOrder: obj.sort_order || 0,
        createdAt: obj.created_at,
        updatedAt: obj.updated_at
      };
    });
  }

  reorderConnections(orderedIds) {
    orderedIds.forEach((id, index) => {
      this.db.run('UPDATE connections SET sort_order=? WHERE id=?', [index, id]);
    });
    this._save();
    return this.getConnections();
  }

  saveConnection(conn) {
    const now = new Date().toISOString();
    if (!conn.id) {
      conn.id = Date.now().toString(36) + Math.random().toString(36).slice(2);
      conn.createdAt = now;
    }
    conn.updatedAt = now;
    this.db.run(`
      INSERT OR REPLACE INTO connections
        (id, name, host, port, username, auth_type, password, private_key, passphrase, group_name, note, init_commands, x11_forwarding, x11_display, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
      conn.id, conn.name, conn.host, conn.port || 22, conn.username,
      conn.authType || 'password',
      encrypt(conn.password || ''),
      encrypt(conn.privateKey || ''),
      encrypt(conn.passphrase || ''),
      conn.group || '默认分组',
      conn.note || '',
      conn.initCommands || '',
      conn.x11Forwarding ? 1 : 0,
      conn.x11Display || 'localhost:0',
      conn.createdAt || now,
      conn.updatedAt
    ]);
    this._save();
    return this.getConnections();
  }

  deleteConnection(id) {
    this.db.run('DELETE FROM connections WHERE id=?', [id]);
    this._save();
    return this.getConnections();
  }

  // ===== Quick Commands =====
  getQuickCommands() {
    const res = this.db.exec('SELECT * FROM quick_commands ORDER BY sort_order, name');
    if (!res.length) return [];
    const cols = res[0].columns;
    return res[0].values.map(row => {
      const obj = {};
      cols.forEach((c, i) => obj[c] = row[i]);
      return {
        id: obj.id,
        name: obj.name,
        command: obj.command,
        category: obj.category,
        sortOrder: obj.sort_order,
        createdAt: obj.created_at
      };
    });
  }

  saveQuickCommand(cmd) {
    const now = new Date().toISOString();
    if (!cmd.id) cmd.id = Date.now().toString(36) + Math.random().toString(36).slice(2);
    this.db.run(`
      INSERT OR REPLACE INTO quick_commands (id, name, command, category, sort_order, created_at)
      VALUES (?,?,?,?,?,?)
    `, [cmd.id, cmd.name, cmd.command, cmd.category || '常用', cmd.sortOrder || 0, cmd.createdAt || now]);
    this._save();
    return this.getQuickCommands();
  }

  deleteQuickCommand(id) {
    this.db.run('DELETE FROM quick_commands WHERE id=?', [id]);
    this._save();
    return this.getQuickCommands();
  }

  // ===== 导出全部数据 =====
  exportAll() {
    return {
      groups: this.getGroups(),
      connections: this.getConnections(),
      quickCommands: this.getQuickCommands(),
      exportTime: new Date().toISOString(),
      source: 'sqlite'
    };
  }

  // ===== 导入数据 =====
  importAll(data) {
    if (data.groups) {
      data.groups.forEach(g => {
        if (g !== '默认分组') this.saveGroup(g);
      });
    }
    if (data.connections) {
      data.connections.forEach(c => this.saveConnection(c));
    }
    if (data.quickCommands) {
      data.quickCommands.forEach(q => this.saveQuickCommand(q));
    }
    return true;
  }
}

// ===================== MySQL 实现 =====================
class MySQLDB {
  constructor(config) {
    this.config = config;
    this.pool = null;
  }

  async init() {
    const mysql = require('mysql2/promise');
    this.pool = mysql.createPool({
      host: this.config.host || 'localhost',
      port: this.config.port || 3306,
      user: this.config.user || 'root',
      password: this.config.password || '',
      database: this.config.database || 'ssh_client',
      waitForConnections: true,
      connectionLimit: 5
    });
    await this._createTables();
    return this;
  }

  async _createTables() {
    const conn = await this.pool.getConnection();
    try {
      await conn.query(`CREATE DATABASE IF NOT EXISTS \`${this.config.database || 'ssh_client'}\``);
      await conn.query(`USE \`${this.config.database || 'ssh_client'}\``);
      await conn.query(`
        CREATE TABLE IF NOT EXISTS groups (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(100) UNIQUE NOT NULL
        )
      `);
      await conn.query(`INSERT IGNORE INTO groups (name) VALUES ('默认分组')`);
      await conn.query(`
        CREATE TABLE IF NOT EXISTS connections (
          id VARCHAR(64) PRIMARY KEY,
          name VARCHAR(200) NOT NULL,
          host VARCHAR(200) NOT NULL,
          port INT DEFAULT 22,
          username VARCHAR(100) NOT NULL,
          auth_type VARCHAR(20) DEFAULT 'password',
          password TEXT,
          private_key TEXT,
          passphrase TEXT,
          group_name VARCHAR(100) DEFAULT '默认分组',
          note TEXT,
          init_commands TEXT,
          x11_forwarding TINYINT DEFAULT 0,
          x11_display VARCHAR(100) DEFAULT 'localhost:0',
          created_at VARCHAR(30),
          updated_at VARCHAR(30)
        ) CHARACTER SET utf8mb4
      `);
      // 兼容旧库
      try { await conn.query(`ALTER TABLE connections ADD COLUMN init_commands TEXT`); } catch(e) {}
      try { await conn.query(`ALTER TABLE connections ADD COLUMN x11_forwarding TINYINT DEFAULT 0`); } catch(e) {}
      try { await conn.query(`ALTER TABLE connections ADD COLUMN x11_display VARCHAR(100) DEFAULT 'localhost:0'`); } catch(e) {}
      try { await conn.query(`ALTER TABLE connections ADD COLUMN sort_order INT DEFAULT 0`); } catch(e) {}
      await conn.query(`
        CREATE TABLE IF NOT EXISTS quick_commands (
          id VARCHAR(64) PRIMARY KEY,
          name VARCHAR(200) NOT NULL,
          command TEXT NOT NULL,
          category VARCHAR(100) DEFAULT '常用',
          sort_order INT DEFAULT 0,
          created_at VARCHAR(30)
        ) CHARACTER SET utf8mb4
      `);
    } finally {
      conn.release();
    }
  }

  async getGroups() {
    const [rows] = await this.pool.query('SELECT name FROM groups ORDER BY id');
    return rows.map(r => r.name);
  }

  async saveGroup(name) {
    await this.pool.query('INSERT IGNORE INTO groups (name) VALUES (?)', [name]);
    return this.getGroups();
  }

  async deleteGroup(name) {
    if (name === '默认分组') return false;
    await this.pool.query('UPDATE connections SET group_name=? WHERE group_name=?', ['默认分组', name]);
    await this.pool.query('DELETE FROM groups WHERE name=?', [name]);
    return true;
  }

  async getConnections() {
    const [rows] = await this.pool.query('SELECT * FROM connections ORDER BY sort_order, group_name, name');
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      host: row.host,
      port: row.port,
      username: row.username,
      authType: row.auth_type,
      password: decrypt(row.password),
      privateKey: decrypt(row.private_key),
      passphrase: decrypt(row.passphrase),
      group: row.group_name,
      note: row.note,
      initCommands: row.init_commands || '',
      x11Forwarding: !!row.x11_forwarding,
      x11Display: row.x11_display || 'localhost:0',
      sortOrder: row.sort_order || 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  async reorderConnections(orderedIds) {
    for (let i = 0; i < orderedIds.length; i++) {
      await this.pool.query('UPDATE connections SET sort_order=? WHERE id=?', [i, orderedIds[i]]);
    }
    return this.getConnections();
  }

  async saveConnection(conn) {
    const now = new Date().toISOString();
    if (!conn.id) {
      conn.id = Date.now().toString(36) + Math.random().toString(36).slice(2);
      conn.createdAt = now;
    }
    conn.updatedAt = now;
    await this.pool.query(`
      INSERT INTO connections (id,name,host,port,username,auth_type,password,private_key,passphrase,group_name,note,init_commands,x11_forwarding,x11_display,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE
        name=VALUES(name), host=VALUES(host), port=VALUES(port),
        username=VALUES(username), auth_type=VALUES(auth_type),
        password=VALUES(password), private_key=VALUES(private_key),
        passphrase=VALUES(passphrase), group_name=VALUES(group_name),
        note=VALUES(note), init_commands=VALUES(init_commands),
        x11_forwarding=VALUES(x11_forwarding), x11_display=VALUES(x11_display),
        updated_at=VALUES(updated_at)
    `, [
      conn.id, conn.name, conn.host, conn.port || 22, conn.username,
      conn.authType || 'password',
      encrypt(conn.password || ''),
      encrypt(conn.privateKey || ''),
      encrypt(conn.passphrase || ''),
      conn.group || '默认分组', conn.note || '',
      conn.initCommands || '',
      conn.x11Forwarding ? 1 : 0,
      conn.x11Display || 'localhost:0',
      conn.createdAt || now, conn.updatedAt
    ]);
    return this.getConnections();
  }

  async deleteConnection(id) {
    await this.pool.query('DELETE FROM connections WHERE id=?', [id]);
    return this.getConnections();
  }

  async getQuickCommands() {
    const [rows] = await this.pool.query('SELECT * FROM quick_commands ORDER BY sort_order, name');
    return rows.map(row => ({
      id: row.id, name: row.name, command: row.command,
      category: row.category, sortOrder: row.sort_order, createdAt: row.created_at
    }));
  }

  async saveQuickCommand(cmd) {
    const now = new Date().toISOString();
    if (!cmd.id) cmd.id = Date.now().toString(36) + Math.random().toString(36).slice(2);
    await this.pool.query(`
      INSERT INTO quick_commands (id,name,command,category,sort_order,created_at)
      VALUES (?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE name=VALUES(name),command=VALUES(command),category=VALUES(category),sort_order=VALUES(sort_order)
    `, [cmd.id, cmd.name, cmd.command, cmd.category || '常用', cmd.sortOrder || 0, cmd.createdAt || now]);
    return this.getQuickCommands();
  }

  async deleteQuickCommand(id) {
    await this.pool.query('DELETE FROM quick_commands WHERE id=?', [id]);
    return this.getQuickCommands();
  }

  async exportAll() {
    return {
      groups: await this.getGroups(),
      connections: await this.getConnections(),
      quickCommands: await this.getQuickCommands(),
      exportTime: new Date().toISOString(),
      source: 'mysql'
    };
  }

  async importAll(data) {
    if (data.groups) {
      for (const g of data.groups) {
        if (g !== '默认分组') await this.saveGroup(g);
      }
    }
    if (data.connections) {
      for (const c of data.connections) await this.saveConnection(c);
    }
    if (data.quickCommands) {
      for (const q of data.quickCommands) await this.saveQuickCommand(q);
    }
    return true;
  }

  async close() {
    if (this.pool) await this.pool.end();
  }
}

// ===================== 数据库管理器 =====================
class DBManager {
  constructor() {
    this.current = null;      // 当前激活的DB实例
    this.sqliteDB = null;
    this.mysqlDB = null;
    this.dbType = 'sqlite';   // 'sqlite' | 'mysql'
    this.mysqlConfig = null;
    this.configPath = null;
  }

  async init() {
    // 读取保存的DB配置
    const userDataDir = app ? app.getPath('userData') : path.join(__dirname, 'data');
    if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });
    this.configPath = path.join(userDataDir, 'db_config.json');

    let savedConfig = { dbType: 'sqlite', mysqlConfig: null };
    if (fs.existsSync(this.configPath)) {
      try { savedConfig = JSON.parse(fs.readFileSync(this.configPath, 'utf8')); } catch(e) {}
    }

    // 始终初始化 SQLite
    this.sqliteDB = new SQLiteDB();
    await this.sqliteDB.init();

    this.dbType = savedConfig.dbType || 'sqlite';
    this.mysqlConfig = savedConfig.mysqlConfig;

    if (this.dbType === 'mysql' && this.mysqlConfig) {
      try {
        this.mysqlDB = new MySQLDB(this.mysqlConfig);
        await this.mysqlDB.init();
        this.current = this.mysqlDB;
      } catch (e) {
        console.error('MySQL init failed, fallback to SQLite:', e.message);
        this.dbType = 'sqlite';
        this.current = this.sqliteDB;
      }
    } else {
      this.current = this.sqliteDB;
    }
  }

  _saveConfig() {
    if (!this.configPath) return;
    fs.writeFileSync(this.configPath, JSON.stringify({
      dbType: this.dbType,
      mysqlConfig: this.mysqlConfig
    }, null, 2));
  }

  getDBType() { return this.dbType; }
  getMysqlConfig() { return this.mysqlConfig; }

  async switchToMySQL(config) {
    try {
      const newDB = new MySQLDB(config);
      await newDB.init();
      if (this.mysqlDB) { try { await this.mysqlDB.close(); } catch(e) {} }
      this.mysqlDB = newDB;
      this.mysqlConfig = config;
      this.dbType = 'mysql';
      this.current = this.mysqlDB;
      this._saveConfig();
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  switchToSQLite() {
    this.dbType = 'sqlite';
    this.current = this.sqliteDB;
    this._saveConfig();
    return { success: true };
  }

  async testMysqlConnection(config) {
    try {
      const mysql = require('mysql2/promise');
      const conn = await mysql.createConnection({
        host: config.host, port: config.port || 3306,
        user: config.user, password: config.password
      });
      await conn.ping();
      await conn.end();
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // ===== 同步操作 =====
  async syncSQLiteToMySQL() {
    if (!this.mysqlDB) throw new Error('MySQL未连接');
    const data = this.sqliteDB.exportAll();
    await this.mysqlDB.importAll(data);
    return { success: true, count: (data.connections || []).length };
  }

  async syncMySQLToSQLite() {
    if (!this.mysqlDB) throw new Error('MySQL未连接');
    const data = await this.mysqlDB.exportAll();
    this.sqliteDB.importAll(data);
    return { success: true, count: (data.connections || []).length };
  }

  async exportToFile(filePath) {
    const data = await Promise.resolve(this.current.exportAll());
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return { success: true };
  }

  async importFromFile(filePath) {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    await Promise.resolve(this.current.importAll(data));
    return { success: true };
  }

  // ===== 代理所有DB操作 =====
  async getGroups() { return Promise.resolve(this.current.getGroups()); }
  async saveGroup(name) { return Promise.resolve(this.current.saveGroup(name)); }
  async deleteGroup(name) { return Promise.resolve(this.current.deleteGroup(name)); }
  async getConnections() { return Promise.resolve(this.current.getConnections()); }
  async saveConnection(conn) { return Promise.resolve(this.current.saveConnection(conn)); }
  async deleteConnection(id) { return Promise.resolve(this.current.deleteConnection(id)); }
  async reorderConnections(orderedIds) { return Promise.resolve(this.current.reorderConnections(orderedIds)); }
  async getQuickCommands() { return Promise.resolve(this.current.getQuickCommands()); }
  async saveQuickCommand(cmd) { return Promise.resolve(this.current.saveQuickCommand(cmd)); }
  async deleteQuickCommand(id) { return Promise.resolve(this.current.deleteQuickCommand(id)); }
}

const dbManager = new DBManager();
module.exports = { dbManager, encrypt, decrypt };
