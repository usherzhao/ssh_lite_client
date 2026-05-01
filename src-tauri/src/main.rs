use chrono::Utc;
use mysql::{params, prelude::Queryable, OptsBuilder, Pool, PooledConn};
use openssl::{rand::rand_bytes, symm::{decrypt as openssl_decrypt, encrypt as openssl_encrypt, Cipher}};
use serde::{Deserialize, Serialize};
use ssh2::{ExtendedData, FileStat, OpenFlags, OpenType, Session};
use std::{
  collections::HashMap,
  fs,
  io::{ErrorKind, Read, Write},
  net::TcpStream,
  path::{Path, PathBuf},
  process::Command,
  sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
  },
  thread,
  time::Duration,
};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, FilePath};

const SSH_EAGAIN: i32 = -37;
const IO_WAIT_MS: u64 = 10;
const DEFAULT_CIPHER_KEY: &str = "ssh-client-aes256-secret-key-32b!";
const CIPHER_IV_LEN: usize = 16;
const MODE_MASK: u32 = 0o170000;
const MODE_DIR: u32 = 0o040000;
const MODE_SYMLINK: u32 = 0o120000;

#[derive(Default, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", default)]
struct AppSettings {
  db_type: String,
  mysql_config: Option<serde_json::Value>,
  winscp_path: String,
}

#[derive(Default, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", default)]
struct DataFile {
  groups: Vec<String>,
  connections: Vec<Connection>,
  quick_commands: Vec<QuickCommand>,
  settings: AppSettings,
}

#[derive(Default, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", default)]
struct Connection {
  id: String,
  name: String,
  host: String,
  port: i64,
  username: String,
  auth_type: String,
  password: String,
  private_key: String,
  passphrase: String,
  group: String,
  note: String,
  init_commands: String,
  x11_forwarding: bool,
  x11_display: String,
  sort_order: i64,
  created_at: String,
  updated_at: String,
}

#[derive(Default, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct QuickCommand {
  id: String,
  name: String,
  command: String,
  category: String,
  sort_order: i64,
  created_at: String,
}

#[derive(Default, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DbConfig {
  db_type: String,
  mysql_config: Option<serde_json::Value>,
  winscp_path: String,
}

#[derive(Default, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", default)]
struct MySqlConfig {
  host: String,
  port: u16,
  user: String,
  password: String,
  database: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SftpItem {
  name: String,
  longname: String,
  is_dir: bool,
  is_symlink: bool,
  size: u64,
  mtime: u64,
  permissions: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DialogFilter {
  name: String,
  extensions: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenDialogOptions {
  title: Option<String>,
  default_path: Option<String>,
  #[serde(default)]
  directory: bool,
  #[serde(default)]
  multiple: bool,
  #[serde(default)]
  filters: Vec<DialogFilter>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveDialogOptions {
  title: Option<String>,
  default_path: Option<String>,
  #[serde(default)]
  filters: Vec<DialogFilter>,
}

#[derive(Clone)]
struct SshSessionRecord {
  runtime_id: String,
  config: Connection,
  title: String,
  is_detached: bool,
  connected_at: String,
  session: Session,
  channel: Arc<Mutex<ssh2::Channel>>,
  alive: Arc<AtomicBool>,
}

#[derive(Clone)]
struct SftpSessionRecord {
  runtime_id: String,
  session_id: String,
  connected_at: String,
  sftp: Arc<Mutex<ssh2::Sftp>>,
}

#[derive(Default)]
struct AppState {
  storage_path: Mutex<Option<PathBuf>>,
  data: Mutex<DataFile>,
  ssh_sessions: Mutex<HashMap<String, SshSessionRecord>>,
  sftp_sessions: Mutex<HashMap<String, SftpSessionRecord>>,
}

fn now_string() -> String {
  Utc::now().to_rfc3339()
}

fn hex_encode(bytes: &[u8]) -> String {
  bytes.iter().map(|byte| format!("{:02x}", byte)).collect()
}

fn hex_decode(value: &str) -> Option<Vec<u8>> {
  if value.len() % 2 != 0 {
    return None;
  }
  let mut bytes = Vec::with_capacity(value.len() / 2);
  let mut index = 0;
  while index < value.len() {
    let byte = u8::from_str_radix(&value[index..index + 2], 16).ok()?;
    bytes.push(byte);
    index += 2;
  }
  Some(bytes)
}

fn cipher_key() -> [u8; 32] {
  let source = std::env::var("SSH_CLIENT_ENCRYPT_KEY").unwrap_or_else(|_| DEFAULT_CIPHER_KEY.to_string());
  let mut key = [0u8; 32];
  for (index, byte) in source.as_bytes().iter().take(32).enumerate() {
    key[index] = *byte;
  }
  key
}

fn is_hex(value: &str) -> bool {
  value.as_bytes().iter().all(|byte| byte.is_ascii_hexdigit())
}

fn looks_encrypted_secret(value: &str) -> bool {
  let mut parts = value.splitn(2, ':');
  let Some(iv_hex) = parts.next() else {
    return false;
  };
  let Some(cipher_hex) = parts.next() else {
    return false;
  };
  iv_hex.len() == CIPHER_IV_LEN * 2 && !cipher_hex.is_empty() && cipher_hex.len() % 2 == 0 && is_hex(iv_hex) && is_hex(cipher_hex)
}

fn encrypt_secret(value: &str) -> String {
  if value.is_empty() || looks_encrypted_secret(value) {
    return value.to_string();
  }
  let mut iv = [0u8; CIPHER_IV_LEN];
  if rand_bytes(&mut iv).is_err() {
    return value.to_string();
  }
  match openssl_encrypt(Cipher::aes_256_cbc(), &cipher_key(), Some(&iv), value.as_bytes()) {
    Ok(encrypted) => format!("{}:{}", hex_encode(&iv), hex_encode(&encrypted)),
    Err(_) => value.to_string(),
  }
}

fn decrypt_secret(value: &str) -> String {
  if value.is_empty() || !looks_encrypted_secret(value) {
    return value.to_string();
  }
  let mut parts = value.splitn(2, ':');
  let Some(iv_hex) = parts.next() else {
    return value.to_string();
  };
  let Some(cipher_hex) = parts.next() else {
    return value.to_string();
  };
  let Some(iv) = hex_decode(iv_hex) else {
    return value.to_string();
  };
  let Some(encrypted) = hex_decode(cipher_hex) else {
    return value.to_string();
  };
  match openssl_decrypt(Cipher::aes_256_cbc(), &cipher_key(), Some(&iv), &encrypted) {
    Ok(decrypted) => String::from_utf8(decrypted).unwrap_or_else(|_| value.to_string()),
    Err(_) => value.to_string(),
  }
}

fn encrypt_connection(mut connection: Connection) -> Connection {
  connection.password = encrypt_secret(&connection.password);
  connection.private_key = encrypt_secret(&connection.private_key);
  connection.passphrase = encrypt_secret(&connection.passphrase);
  connection
}

fn decrypt_connection(mut connection: Connection) -> Connection {
  connection.password = decrypt_secret(&connection.password);
  connection.private_key = decrypt_secret(&connection.private_key);
  connection.passphrase = decrypt_secret(&connection.passphrase);
  connection
}

fn data_for_storage(data: &DataFile) -> DataFile {
  let mut storage = data.clone();
  storage.connections = storage.connections.into_iter().map(encrypt_connection).collect();
  storage
}

fn data_from_storage(mut data: DataFile) -> DataFile {
  data.connections = data.connections.into_iter().map(decrypt_connection).collect();
  data
}

fn default_data() -> DataFile {
  DataFile {
    groups: vec!["默认分组".to_string()],
    connections: vec![],
    quick_commands: vec![],
    settings: AppSettings {
      db_type: "sqlite".to_string(),
      mysql_config: None,
      winscp_path: String::new(),
    },
  }
}

fn storage_file(app: &AppHandle) -> Option<PathBuf> {
  app.path().app_data_dir().ok().map(|dir| dir.join("ssh-client-data.json"))
}

fn load_data(path: &Path) -> DataFile {
  fs::read_to_string(path)
    .ok()
    .and_then(|text| serde_json::from_str(&text).ok())
    .map(data_from_storage)
    .unwrap_or_else(default_data)
}

fn save_data(path: &Path, data: &DataFile) -> Result<(), String> {
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }
  let storage = data_for_storage(data);
  let text = serde_json::to_string_pretty(&storage).map_err(|e| e.to_string())?;
  fs::write(path, text).map_err(|e| e.to_string())
}

fn ensure_storage(app: &AppHandle, state: &tauri::State<AppState>) -> Result<PathBuf, String> {
  if let Some(path) = state.storage_path.lock().unwrap().clone() {
    return Ok(path);
  }
  let path = storage_file(app).ok_or_else(|| "无法解析应用数据目录".to_string())?;
  if !path.exists() {
    save_data(&path, &default_data())?;
  }
  let data = load_data(&path);
  *state.data.lock().unwrap() = data;
  *state.storage_path.lock().unwrap() = Some(path.clone());
  Ok(path)
}

fn with_data<T, F>(app: &AppHandle, state: &tauri::State<AppState>, f: F) -> Result<T, String>
where
  F: FnOnce(&mut DataFile) -> T,
{
  let path = ensure_storage(app, state)?;
  let mut data = state.data.lock().unwrap();
  let value = f(&mut data);
  save_data(&path, &data)?;
  Ok(value)
}

fn create_connection_id() -> String {
  format!("c{}", Utc::now().timestamp_millis())
}

fn create_command_id() -> String {
  format!("q{}", Utc::now().timestamp_millis())
}

fn create_runtime_id() -> String {
  format!("r{}", Utc::now().timestamp_millis())
}

fn dialog_file_path_to_string(path: &FilePath) -> String {
  match path {
    FilePath::Path(path) => path.to_string_lossy().to_string(),
    FilePath::Url(url) => url.to_string(),
  }
}

fn apply_default_dialog_path<R: tauri::Runtime>(mut file_dialog: tauri_plugin_dialog::FileDialogBuilder<R>, default_path: Option<&str>) -> tauri_plugin_dialog::FileDialogBuilder<R> {
  if let Some(default_path) = default_path {
    let path = Path::new(default_path);
    if let Some(file_name) = path.file_name().and_then(|value| value.to_str()) {
      file_dialog = file_dialog.set_file_name(file_name);
    }
    if let Some(parent) = path.parent() {
      file_dialog = file_dialog.set_directory(parent);
    } else {
      file_dialog = file_dialog.set_directory(path);
    }
  }
  file_dialog
}

fn normalize_mysql_config(config: MySqlConfig) -> Result<MySqlConfig, String> {
  let host = if config.host.trim().is_empty() { "localhost".to_string() } else { config.host.trim().to_string() };
  let user = if config.user.trim().is_empty() { "root".to_string() } else { config.user.trim().to_string() };
  let database = if config.database.trim().is_empty() { "ssh_client".to_string() } else { config.database.trim().to_string() };
  if !database.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '$') {
    return Err("数据库名只能包含字母、数字、下划线或 $".to_string());
  }
  Ok(MySqlConfig {
    host,
    port: if config.port == 0 { 3306 } else { config.port },
    user,
    password: config.password,
    database,
  })
}

fn mysql_pool(config: &MySqlConfig, database: Option<&str>) -> Result<Pool, String> {
  let mut builder = OptsBuilder::new()
    .ip_or_hostname(Some(config.host.clone()))
    .tcp_port(config.port)
    .user(Some(config.user.clone()))
    .pass(Some(config.password.clone()));
  if let Some(database) = database {
    builder = builder.db_name(Some(database.to_string()));
  }
  Pool::new(builder).map_err(|e| e.to_string())
}

fn mysql_conn(config: &MySqlConfig, database: Option<&str>) -> Result<PooledConn, String> {
  mysql_pool(config, database)?.get_conn().map_err(|e| e.to_string())
}

fn current_mysql_config(data: &DataFile) -> Option<MySqlConfig> {
  if data.settings.db_type != "mysql" {
    return None;
  }
  data.settings
    .mysql_config
    .clone()
    .and_then(|value| serde_json::from_value::<MySqlConfig>(value).ok())
    .and_then(|config| normalize_mysql_config(config).ok())
}

fn mysql_connection_from_row(row: mysql::Row) -> Connection {
  decrypt_connection(Connection {
    id: row.get("id").unwrap_or_default(),
    name: row.get("name").unwrap_or_default(),
    host: row.get("host").unwrap_or_default(),
    port: row.get::<i64, _>("port").unwrap_or(22),
    username: row.get("username").unwrap_or_default(),
    auth_type: row.get("auth_type").unwrap_or_else(|| "password".to_string()),
    password: row.get("password").unwrap_or_default(),
    private_key: row.get("private_key").unwrap_or_default(),
    passphrase: row.get("passphrase").unwrap_or_default(),
    group: row.get("group_name").unwrap_or_else(|| "默认分组".to_string()),
    note: row.get("note").unwrap_or_default(),
    init_commands: row.get("init_commands").unwrap_or_default(),
    x11_forwarding: row.get::<i64, _>("x11_forwarding").unwrap_or(0) != 0,
    x11_display: row.get("x11_display").unwrap_or_else(|| "localhost:0".to_string()),
    sort_order: row.get::<i64, _>("sort_order").unwrap_or(0),
    created_at: row.get("created_at").unwrap_or_default(),
    updated_at: row.get("updated_at").unwrap_or_default(),
  })
}

fn mysql_quick_command_from_row(row: mysql::Row) -> QuickCommand {
  QuickCommand {
    id: row.get("id").unwrap_or_default(),
    name: row.get("name").unwrap_or_default(),
    command: row.get("command").unwrap_or_default(),
    category: row.get("category").unwrap_or_else(|| "常用".to_string()),
    sort_order: row.get::<i64, _>("sort_order").unwrap_or(0),
    created_at: row.get("created_at").unwrap_or_default(),
  }
}

fn init_mysql_schema(config: &MySqlConfig) -> Result<(), String> {
  let mut conn = mysql_conn(config, None)?;
  conn.query_drop(format!("CREATE DATABASE IF NOT EXISTS `{}` CHARACTER SET utf8mb4", config.database)).map_err(|e| e.to_string())?;
  conn.query_drop(format!("USE `{}`", config.database)).map_err(|e| e.to_string())?;
  conn.query_drop("CREATE TABLE IF NOT EXISTS `groups` (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) UNIQUE NOT NULL)").map_err(|e| e.to_string())?;
  conn.exec_drop("INSERT IGNORE INTO `groups` (name) VALUES (:name)", params! { "name" => "默认分组" }).map_err(|e| e.to_string())?;
  conn.query_drop("CREATE TABLE IF NOT EXISTS connections (id VARCHAR(64) PRIMARY KEY, name VARCHAR(200) NOT NULL, host VARCHAR(200) NOT NULL, port INT DEFAULT 22, username VARCHAR(100) NOT NULL, auth_type VARCHAR(20) DEFAULT 'password', password TEXT, private_key TEXT, passphrase TEXT, group_name VARCHAR(100) DEFAULT '默认分组', note TEXT, init_commands TEXT, x11_forwarding TINYINT DEFAULT 0, x11_display VARCHAR(100) DEFAULT 'localhost:0', sort_order INT DEFAULT 0, created_at VARCHAR(30), updated_at VARCHAR(30)) CHARACTER SET utf8mb4").map_err(|e| e.to_string())?;
  conn.query_drop("CREATE TABLE IF NOT EXISTS quick_commands (id VARCHAR(64) PRIMARY KEY, name VARCHAR(200) NOT NULL, command TEXT NOT NULL, category VARCHAR(100) DEFAULT '常用', sort_order INT DEFAULT 0, created_at VARCHAR(30)) CHARACTER SET utf8mb4").map_err(|e| e.to_string())?;
  let _ = conn.query_drop("ALTER TABLE connections ADD COLUMN init_commands TEXT");
  let _ = conn.query_drop("ALTER TABLE connections ADD COLUMN x11_forwarding TINYINT DEFAULT 0");
  let _ = conn.query_drop("ALTER TABLE connections ADD COLUMN x11_display VARCHAR(100) DEFAULT 'localhost:0'");
  let _ = conn.query_drop("ALTER TABLE connections ADD COLUMN sort_order INT DEFAULT 0");
  Ok(())
}

fn mysql_get_connections(config: &MySqlConfig) -> Result<Vec<Connection>, String> {
  let mut conn = mysql_conn(config, Some(&config.database))?;
  let rows: Vec<mysql::Row> = conn.query("SELECT * FROM connections ORDER BY sort_order, group_name, name").map_err(|e| e.to_string())?;
  Ok(rows.into_iter().map(mysql_connection_from_row).collect())
}

fn mysql_get_groups(config: &MySqlConfig) -> Result<Vec<String>, String> {
  let mut conn = mysql_conn(config, Some(&config.database))?;
  let groups: Vec<String> = conn.query_map("SELECT name FROM `groups` ORDER BY id", |name: String| name).map_err(|e| e.to_string())?;
  Ok(if groups.is_empty() { vec!["默认分组".to_string()] } else { groups })
}

fn mysql_get_quick_commands(config: &MySqlConfig) -> Result<Vec<QuickCommand>, String> {
  let mut conn = mysql_conn(config, Some(&config.database))?;
  let rows: Vec<mysql::Row> = conn.query("SELECT * FROM quick_commands ORDER BY sort_order, name").map_err(|e| e.to_string())?;
  Ok(rows.into_iter().map(mysql_quick_command_from_row).collect())
}

fn mysql_save_connection(config: &MySqlConfig, conn_data: &Connection) -> Result<Vec<Connection>, String> {
  let storage_conn = encrypt_connection(conn_data.clone());
  let mut conn = mysql_conn(config, Some(&config.database))?;
  conn.exec_drop(
    "INSERT INTO connections (id,name,host,port,username,auth_type,password,private_key,passphrase,group_name,note,init_commands,x11_forwarding,x11_display,sort_order,created_at,updated_at) VALUES (:id,:name,:host,:port,:username,:auth_type,:password,:private_key,:passphrase,:group_name,:note,:init_commands,:x11_forwarding,:x11_display,:sort_order,:created_at,:updated_at) ON DUPLICATE KEY UPDATE name=VALUES(name), host=VALUES(host), port=VALUES(port), username=VALUES(username), auth_type=VALUES(auth_type), password=VALUES(password), private_key=VALUES(private_key), passphrase=VALUES(passphrase), group_name=VALUES(group_name), note=VALUES(note), init_commands=VALUES(init_commands), x11_forwarding=VALUES(x11_forwarding), x11_display=VALUES(x11_display), sort_order=VALUES(sort_order), updated_at=VALUES(updated_at)",
    params! {
      "id" => &storage_conn.id,
      "name" => &storage_conn.name,
      "host" => &storage_conn.host,
      "port" => storage_conn.port,
      "username" => &storage_conn.username,
      "auth_type" => &storage_conn.auth_type,
      "password" => &storage_conn.password,
      "private_key" => &storage_conn.private_key,
      "passphrase" => &storage_conn.passphrase,
      "group_name" => &storage_conn.group,
      "note" => &storage_conn.note,
      "init_commands" => &storage_conn.init_commands,
      "x11_forwarding" => if storage_conn.x11_forwarding { 1 } else { 0 },
      "x11_display" => &storage_conn.x11_display,
      "sort_order" => storage_conn.sort_order,
      "created_at" => &storage_conn.created_at,
      "updated_at" => &storage_conn.updated_at,
    },
  ).map_err(|e| e.to_string())?;
  conn.exec_drop("INSERT IGNORE INTO `groups` (name) VALUES (:name)", params! { "name" => &storage_conn.group }).map_err(|e| e.to_string())?;
  mysql_get_connections(config)
}

fn mysql_delete_connection(config: &MySqlConfig, id: &str) -> Result<Vec<Connection>, String> {
  let mut conn = mysql_conn(config, Some(&config.database))?;
  conn.exec_drop("DELETE FROM connections WHERE id=:id", params! { "id" => id }).map_err(|e| e.to_string())?;
  mysql_get_connections(config)
}

fn mysql_reorder_connections(config: &MySqlConfig, ordered_ids: &[String]) -> Result<Vec<Connection>, String> {
  let mut conn = mysql_conn(config, Some(&config.database))?;
  for (index, id) in ordered_ids.iter().enumerate() {
    conn.exec_drop("UPDATE connections SET sort_order=:sort_order WHERE id=:id", params! { "sort_order" => index as i64, "id" => id }).map_err(|e| e.to_string())?;
  }
  mysql_get_connections(config)
}

fn mysql_save_group(config: &MySqlConfig, group: &str) -> Result<Vec<String>, String> {
  if group.trim().is_empty() {
    return mysql_get_groups(config);
  }
  let mut conn = mysql_conn(config, Some(&config.database))?;
  conn.exec_drop("INSERT IGNORE INTO `groups` (name) VALUES (:name)", params! { "name" => group.trim() }).map_err(|e| e.to_string())?;
  mysql_get_groups(config)
}

fn mysql_delete_group(config: &MySqlConfig, group: &str) -> Result<Vec<String>, String> {
  if group == "默认分组" {
    return mysql_get_groups(config);
  }
  let mut conn = mysql_conn(config, Some(&config.database))?;
  conn.exec_drop("UPDATE connections SET group_name=:default_group WHERE group_name=:group", params! { "default_group" => "默认分组", "group" => group }).map_err(|e| e.to_string())?;
  conn.exec_drop("DELETE FROM `groups` WHERE name=:group", params! { "group" => group }).map_err(|e| e.to_string())?;
  mysql_get_groups(config)
}

fn mysql_save_quick_command(config: &MySqlConfig, cmd: &QuickCommand) -> Result<Vec<QuickCommand>, String> {
  let mut conn = mysql_conn(config, Some(&config.database))?;
  conn.exec_drop(
    "INSERT INTO quick_commands (id,name,command,category,sort_order,created_at) VALUES (:id,:name,:command,:category,:sort_order,:created_at) ON DUPLICATE KEY UPDATE name=VALUES(name), command=VALUES(command), category=VALUES(category), sort_order=VALUES(sort_order)",
    params! {
      "id" => &cmd.id,
      "name" => &cmd.name,
      "command" => &cmd.command,
      "category" => &cmd.category,
      "sort_order" => cmd.sort_order,
      "created_at" => &cmd.created_at,
    },
  ).map_err(|e| e.to_string())?;
  mysql_get_quick_commands(config)
}

fn mysql_delete_quick_command(config: &MySqlConfig, id: &str) -> Result<Vec<QuickCommand>, String> {
  let mut conn = mysql_conn(config, Some(&config.database))?;
  conn.exec_drop("DELETE FROM quick_commands WHERE id=:id", params! { "id" => id }).map_err(|e| e.to_string())?;
  mysql_get_quick_commands(config)
}

fn mysql_import_data(config: &MySqlConfig, data: &DataFile) -> Result<usize, String> {
  init_mysql_schema(config)?;
  let mut conn = mysql_conn(config, Some(&config.database))?;
  conn.query_drop("DELETE FROM connections").map_err(|e| e.to_string())?;
  conn.query_drop("DELETE FROM quick_commands").map_err(|e| e.to_string())?;
  conn.query_drop("DELETE FROM `groups`").map_err(|e| e.to_string())?;
  conn.exec_drop("INSERT IGNORE INTO `groups` (name) VALUES (:name)", params! { "name" => "默认分组" }).map_err(|e| e.to_string())?;
  for group in &data.groups {
    if !group.trim().is_empty() {
      conn.exec_drop("INSERT IGNORE INTO `groups` (name) VALUES (:name)", params! { "name" => group }).map_err(|e| e.to_string())?;
    }
  }
  drop(conn);
  for connection in &data.connections {
    mysql_save_connection(config, connection)?;
  }
  for command in &data.quick_commands {
    mysql_save_quick_command(config, command)?;
  }
  Ok(data.connections.len())
}

fn mysql_export_data(config: &MySqlConfig, settings: AppSettings) -> Result<DataFile, String> {
  Ok(DataFile {
    groups: mysql_get_groups(config)?,
    connections: mysql_get_connections(config)?,
    quick_commands: mysql_get_quick_commands(config)?,
    settings,
  })
}

fn is_ssh_would_block(error: &ssh2::Error) -> bool {
  matches!(error.code(), ssh2::ErrorCode::Session(code) if code == SSH_EAGAIN)
}

fn wait_ssh<T, F>(mut op: F) -> Result<T, String>
where
  F: FnMut() -> Result<T, ssh2::Error>,
{
  loop {
    match op() {
      Ok(value) => return Ok(value),
      Err(error) if is_ssh_would_block(&error) => thread::sleep(Duration::from_millis(IO_WAIT_MS)),
      Err(error) => return Err(error.to_string()),
    }
  }
}

fn write_all_ssh(target: &mut impl Write, data: &[u8]) -> Result<(), String> {
  let mut offset = 0;
  while offset < data.len() {
    match target.write(&data[offset..]) {
      Ok(0) => thread::sleep(Duration::from_millis(IO_WAIT_MS)),
      Ok(size) => offset += size,
      Err(error) if error.kind() == ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(IO_WAIT_MS)),
      Err(error) => return Err(error.to_string()),
    }
  }
  Ok(())
}

fn file_kind(perm: Option<u32>) -> (bool, bool) {
  match perm {
    Some(mode) => {
      let file_type = mode & MODE_MASK;
      (file_type == MODE_DIR, file_type == MODE_SYMLINK)
    }
    None => (false, false),
  }
}

fn build_sftp_item(name: String, stat: &FileStat) -> SftpItem {
  let (is_dir, is_symlink) = file_kind(stat.perm);
  SftpItem {
    name,
    longname: String::new(),
    is_dir,
    is_symlink,
    size: stat.size.unwrap_or(0),
    mtime: stat.mtime.unwrap_or(0),
    permissions: stat.perm,
  }
}

fn join_remote_path(base: &str, name: &str) -> String {
  let clean_name = name.trim_start_matches('/');
  if base.is_empty() || base == "/" {
    format!("/{}", clean_name)
  } else {
    format!("{}/{}", base.trim_end_matches('/'), clean_name)
  }
}

fn read_remote_file_to_local(sftp: &Arc<Mutex<ssh2::Sftp>>, remote_path: &str, local_path: &Path) -> Result<(), String> {
  if let Some(parent) = local_path.parent() {
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }
  let mut remote_file = {
    let guard = sftp.lock().unwrap();
    wait_ssh(|| guard.open(Path::new(remote_path)))?
  };
  let mut local_file = fs::File::create(local_path).map_err(|e| e.to_string())?;
  let mut buffer = vec![0u8; 64 * 1024];
  loop {
    match remote_file.read(&mut buffer) {
      Ok(0) => break,
      Ok(size) => local_file.write_all(&buffer[..size]).map_err(|e| e.to_string())?,
      Err(error) if error.kind() == ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(IO_WAIT_MS)),
      Err(error) => return Err(error.to_string()),
    }
  }
  local_file.flush().map_err(|e| e.to_string())?;
  Ok(())
}

fn write_local_file_to_remote(sftp: &Arc<Mutex<ssh2::Sftp>>, local_path: &Path, remote_path: &str) -> Result<(), String> {
  let mut local_file = fs::File::open(local_path).map_err(|e| e.to_string())?;
  let mut remote_file = {
    let guard = sftp.lock().unwrap();
    wait_ssh(|| {
      guard.open_mode(
        Path::new(remote_path),
        OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
        0o644,
        OpenType::File,
      )
    })?
  };
  let mut buffer = vec![0u8; 64 * 1024];
  loop {
    let size = local_file.read(&mut buffer).map_err(|e| e.to_string())?;
    if size == 0 {
      break;
    }
    write_all_ssh(&mut remote_file, &buffer[..size])?;
  }
  remote_file.flush().map_err(|e| e.to_string())?;
  Ok(())
}

fn list_remote_dir(sftp: &Arc<Mutex<ssh2::Sftp>>, remote_path: &str) -> Result<Vec<SftpItem>, String> {
  let entries = {
    let guard = sftp.lock().unwrap();
    wait_ssh(|| guard.readdir(Path::new(remote_path)))?
  };
  let mut items = entries
    .into_iter()
    .filter_map(|(path, stat)| {
      let name = path.file_name().map(|value| value.to_string_lossy().to_string())?;
      if name == "." || name == ".." {
        None
      } else {
        Some(build_sftp_item(name, &stat))
      }
    })
    .collect::<Vec<_>>();
  items.sort_by(|a, b| a.is_dir.cmp(&b.is_dir).reverse().then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
  Ok(items)
}

fn download_remote_dir(sftp: &Arc<Mutex<ssh2::Sftp>>, remote_path: &str, local_path: &Path) -> Result<(), String> {
  fs::create_dir_all(local_path).map_err(|e| e.to_string())?;
  for item in list_remote_dir(sftp, remote_path)? {
    let child_remote = join_remote_path(remote_path, &item.name);
    let child_local = local_path.join(&item.name);
    if item.is_dir {
      download_remote_dir(sftp, &child_remote, &child_local)?;
    } else {
      read_remote_file_to_local(sftp, &child_remote, &child_local)?;
    }
  }
  Ok(())
}

fn create_ssh_runtime(config: &Connection) -> Result<(Session, ssh2::Channel), String> {
  if config.host.trim().is_empty() {
    return Err("主机地址不能为空".to_string());
  }
  if config.username.trim().is_empty() {
    return Err("用户名不能为空".to_string());
  }
  let address = format!("{}:{}", config.host.trim(), if config.port == 0 { 22 } else { config.port });
  let tcp = TcpStream::connect(address).map_err(|e| e.to_string())?;
  tcp.set_nodelay(true).map_err(|e| e.to_string())?;

  let mut session = Session::new().map_err(|e| e.to_string())?;
  session.set_timeout(15000);
  session.set_tcp_stream(tcp);
  session.handshake().map_err(|e| e.to_string())?;

  match config.auth_type.as_str() {
    "privateKey" => {
      if config.private_key.trim().is_empty() {
        return Err("当前连接未配置私钥内容".to_string());
      }
      let passphrase = if config.passphrase.trim().is_empty() {
        None
      } else {
        Some(config.passphrase.as_str())
      };
      session
        .userauth_pubkey_memory(&config.username, None, &config.private_key, passphrase)
        .map_err(|e| e.to_string())?;
    }
    "agent" => {
      session.userauth_agent(&config.username).map_err(|e| e.to_string())?;
    }
    _ => {
      session
        .userauth_password(&config.username, &config.password)
        .map_err(|e| e.to_string())?;
    }
  }

  if !session.authenticated() {
    return Err("SSH 认证失败".to_string());
  }

  let mut channel = session.channel_session().map_err(|e| e.to_string())?;
  channel.handle_extended_data(ExtendedData::Merge).map_err(|e| e.to_string())?;
  channel
    .request_pty("xterm-256color", None, Some((120, 40, 0, 0)))
    .map_err(|e| e.to_string())?;
  channel.shell().map_err(|e| e.to_string())?;
  session.set_blocking(false);

  Ok((session, channel))
}

fn spawn_ssh_reader(app: AppHandle, session_id: String, runtime_id: String, channel: Arc<Mutex<ssh2::Channel>>, alive: Arc<AtomicBool>) {
  thread::spawn(move || {
    let event_name = format!("ssh-data-{}", session_id);
    let close_event = format!("ssh-close-{}", session_id);
    let mut buffer = vec![0u8; 64 * 1024];

    loop {
      let read_result = {
        let mut guard = channel.lock().unwrap();
        guard.read(&mut buffer).map(|size| (size, guard.eof()))
      };
      match read_result {
        Ok((0, eof)) => {
          if eof || !alive.load(Ordering::SeqCst) {
            break;
          }
          thread::sleep(Duration::from_millis(IO_WAIT_MS));
        }
        Ok((size, _)) => {
          let payload = String::from_utf8_lossy(&buffer[..size]).to_string();
          let _ = app.emit(&event_name, payload);
        }
        Err(error) if error.kind() == ErrorKind::WouldBlock => {
          let eof = channel.lock().unwrap().eof();
          if eof || !alive.load(Ordering::SeqCst) {
            break;
          }
          thread::sleep(Duration::from_millis(IO_WAIT_MS));
        }
        Err(_) => break,
      }
    }

    alive.store(false, Ordering::SeqCst);

    let should_emit = {
      let state = app.state::<AppState>();
      let mut ssh_sessions = state.ssh_sessions.lock().unwrap();
      match ssh_sessions.get(&session_id) {
        Some(record) if record.runtime_id == runtime_id => {
          ssh_sessions.remove(&session_id);
          state.sftp_sessions.lock().unwrap().remove(&session_id);
          true
        }
        Some(_) => false,
        None => false,
      }
    };

    if should_emit {
      let _ = app.emit(&close_event, true);
    }
  });
}

#[tauri::command]
fn win_minimize(window: tauri::Window) -> Result<(), String> {
  window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
fn win_maximize(window: tauri::Window) -> Result<(), String> {
  if window.is_maximized().unwrap_or(false) {
    window.unmaximize().map_err(|e| e.to_string())
  } else {
    window.maximize().map_err(|e| e.to_string())
  }
}

#[tauri::command]
fn win_close(window: tauri::Window) -> Result<(), String> {
  window.close().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_connections(app: AppHandle, state: tauri::State<AppState>) -> Result<Vec<Connection>, String> {
  ensure_storage(&app, &state)?;
  let mysql_config = {
    let data = state.data.lock().unwrap();
    current_mysql_config(&data)
  };
  if let Some(config) = mysql_config {
    init_mysql_schema(&config)?;
    return mysql_get_connections(&config);
  }
  Ok(state.data.lock().unwrap().connections.clone())
}

#[tauri::command]
fn save_connection(app: AppHandle, state: tauri::State<AppState>, mut conn: Connection) -> Result<Vec<Connection>, String> {
  let mysql_config = {
    ensure_storage(&app, &state)?;
    let data = state.data.lock().unwrap();
    current_mysql_config(&data)
  };
  if conn.id.is_empty() {
    conn.id = create_connection_id();
    if conn.created_at.is_empty() {
      conn.created_at = now_string();
    }
  }
  conn.updated_at = now_string();
  if conn.group.is_empty() {
    conn.group = "默认分组".to_string();
  }
  if conn.port == 0 {
    conn.port = 22;
  }
  if let Some(config) = mysql_config {
    init_mysql_schema(&config)?;
    return mysql_save_connection(&config, &conn);
  }
  with_data(&app, &state, |data| {
    if let Some(index) = data.connections.iter().position(|item| item.id == conn.id) {
      conn.sort_order = data.connections[index].sort_order;
      data.connections[index] = conn.clone();
    } else {
      if conn.sort_order == 0 {
        conn.sort_order = data.connections.len() as i64;
      }
      data.connections.push(conn.clone());
    }
    if !data.groups.iter().any(|group| group == &conn.group) {
      data.groups.push(conn.group.clone());
    }
    data.connections.sort_by(|a, b| a.sort_order.cmp(&b.sort_order).then(a.group.cmp(&b.group)).then(a.name.cmp(&b.name)));
    data.connections.clone()
  })
}

#[tauri::command]
fn delete_connection(app: AppHandle, state: tauri::State<AppState>, id: String) -> Result<Vec<Connection>, String> {
  let mysql_config = {
    ensure_storage(&app, &state)?;
    let data = state.data.lock().unwrap();
    current_mysql_config(&data)
  };
  if let Some(config) = mysql_config {
    init_mysql_schema(&config)?;
    return mysql_delete_connection(&config, &id);
  }
  with_data(&app, &state, |data| {
    data.connections.retain(|conn| conn.id != id);
    data.connections.clone()
  })
}

#[tauri::command]
fn reorder_connections(app: AppHandle, state: tauri::State<AppState>, ordered_ids: Vec<String>) -> Result<Vec<Connection>, String> {
  let mysql_config = {
    ensure_storage(&app, &state)?;
    let data = state.data.lock().unwrap();
    current_mysql_config(&data)
  };
  if let Some(config) = mysql_config {
    init_mysql_schema(&config)?;
    return mysql_reorder_connections(&config, &ordered_ids);
  }
  with_data(&app, &state, |data| {
    for (index, id) in ordered_ids.iter().enumerate() {
      if let Some(conn) = data.connections.iter_mut().find(|item| &item.id == id) {
        conn.sort_order = index as i64;
      }
    }
    data.connections.sort_by(|a, b| a.sort_order.cmp(&b.sort_order).then(a.group.cmp(&b.group)).then(a.name.cmp(&b.name)));
    data.connections.clone()
  })
}

#[tauri::command]
fn get_groups(app: AppHandle, state: tauri::State<AppState>) -> Result<Vec<String>, String> {
  ensure_storage(&app, &state)?;
  let mysql_config = {
    let data = state.data.lock().unwrap();
    current_mysql_config(&data)
  };
  if let Some(config) = mysql_config {
    init_mysql_schema(&config)?;
    return mysql_get_groups(&config);
  }
  let data = state.data.lock().unwrap();
  Ok(if data.groups.is_empty() { vec!["默认分组".to_string()] } else { data.groups.clone() })
}

#[tauri::command]
fn save_group(app: AppHandle, state: tauri::State<AppState>, group: String) -> Result<Vec<String>, String> {
  let mysql_config = {
    ensure_storage(&app, &state)?;
    let data = state.data.lock().unwrap();
    current_mysql_config(&data)
  };
  if let Some(config) = mysql_config {
    init_mysql_schema(&config)?;
    return mysql_save_group(&config, &group);
  }
  with_data(&app, &state, |data| {
    if !group.is_empty() && !data.groups.iter().any(|item| item == &group) {
      data.groups.push(group);
    }
    data.groups.clone()
  })
}

#[tauri::command]
fn delete_group(app: AppHandle, state: tauri::State<AppState>, group: String) -> Result<Vec<String>, String> {
  let mysql_config = {
    ensure_storage(&app, &state)?;
    let data = state.data.lock().unwrap();
    current_mysql_config(&data)
  };
  if let Some(config) = mysql_config {
    init_mysql_schema(&config)?;
    return mysql_delete_group(&config, &group);
  }
  with_data(&app, &state, |data| {
    if group != "默认分组" {
      data.groups.retain(|item| item != &group);
      for conn in &mut data.connections {
        if conn.group == group {
          conn.group = "默认分组".to_string();
        }
      }
    }
    if data.groups.is_empty() {
      data.groups.push("默认分组".to_string());
    }
    data.groups.clone()
  })
}

#[tauri::command]
fn get_quick_commands(app: AppHandle, state: tauri::State<AppState>) -> Result<Vec<QuickCommand>, String> {
  ensure_storage(&app, &state)?;
  let mysql_config = {
    let data = state.data.lock().unwrap();
    current_mysql_config(&data)
  };
  if let Some(config) = mysql_config {
    init_mysql_schema(&config)?;
    return mysql_get_quick_commands(&config);
  }
  Ok(state.data.lock().unwrap().quick_commands.clone())
}

#[tauri::command]
fn save_quick_command(app: AppHandle, state: tauri::State<AppState>, mut cmd: QuickCommand) -> Result<Vec<QuickCommand>, String> {
  let mysql_config = {
    ensure_storage(&app, &state)?;
    let data = state.data.lock().unwrap();
    current_mysql_config(&data)
  };
  if cmd.id.is_empty() {
    cmd.id = create_command_id();
    if cmd.created_at.is_empty() {
      cmd.created_at = now_string();
    }
  }
  if cmd.category.is_empty() {
    cmd.category = "常用".to_string();
  }
  if let Some(config) = mysql_config {
    init_mysql_schema(&config)?;
    return mysql_save_quick_command(&config, &cmd);
  }
  with_data(&app, &state, |data| {
    if let Some(index) = data.quick_commands.iter().position(|item| item.id == cmd.id) {
      cmd.sort_order = data.quick_commands[index].sort_order;
      data.quick_commands[index] = cmd.clone();
    } else {
      if cmd.sort_order == 0 {
        cmd.sort_order = data.quick_commands.len() as i64;
      }
      data.quick_commands.push(cmd.clone());
    }
    data.quick_commands.sort_by(|a, b| a.sort_order.cmp(&b.sort_order).then(a.category.cmp(&b.category)).then(a.name.cmp(&b.name)));
    data.quick_commands.clone()
  })
}

#[tauri::command]
fn delete_quick_command(app: AppHandle, state: tauri::State<AppState>, id: String) -> Result<Vec<QuickCommand>, String> {
  let mysql_config = {
    ensure_storage(&app, &state)?;
    let data = state.data.lock().unwrap();
    current_mysql_config(&data)
  };
  if let Some(config) = mysql_config {
    init_mysql_schema(&config)?;
    return mysql_delete_quick_command(&config, &id);
  }
  with_data(&app, &state, |data| {
    data.quick_commands.retain(|cmd| cmd.id != id);
    data.quick_commands.clone()
  })
}

#[tauri::command]
fn get_db_config(app: AppHandle, state: tauri::State<AppState>) -> Result<DbConfig, String> {
  ensure_storage(&app, &state)?;
  let data = state.data.lock().unwrap();
  Ok(DbConfig {
    db_type: data.settings.db_type.clone(),
    mysql_config: data.settings.mysql_config.clone(),
    winscp_path: data.settings.winscp_path.clone(),
  })
}

#[tauri::command]
fn save_winscp_path(app: AppHandle, state: tauri::State<AppState>, winscp_path: String) -> Result<serde_json::Value, String> {
  let config = with_data(&app, &state, |data| {
    data.settings.winscp_path = winscp_path.trim().to_string();
    DbConfig {
      db_type: data.settings.db_type.clone(),
      mysql_config: data.settings.mysql_config.clone(),
      winscp_path: data.settings.winscp_path.clone(),
    }
  })?;
  Ok(serde_json::json!({ "success": true, "config": config }))
}

#[tauri::command]
fn show_open_dialog(app: AppHandle, options: OpenDialogOptions) -> Result<serde_json::Value, String> {
  let mut file_dialog = app.dialog().file();
  if let Some(title) = options.title.as_deref() {
    file_dialog = file_dialog.set_title(title);
  }
  file_dialog = apply_default_dialog_path(file_dialog, options.default_path.as_deref());
  for filter in &options.filters {
    let extensions = filter.extensions.iter().map(String::as_str).collect::<Vec<_>>();
    file_dialog = file_dialog.add_filter(&filter.name, &extensions);
  }
  let paths = if options.directory {
    if options.multiple {
      file_dialog.blocking_pick_folders().unwrap_or_default()
    } else {
      file_dialog
        .blocking_pick_folder()
        .map(|path| vec![path])
        .unwrap_or_default()
    }
  } else if options.multiple {
    file_dialog.blocking_pick_files().unwrap_or_default()
  } else {
    file_dialog
      .blocking_pick_file()
      .map(|path| vec![path])
      .unwrap_or_default()
  };
  if paths.is_empty() {
    Ok(serde_json::json!({ "canceled": true, "filePaths": [] }))
  } else {
    let file_paths = paths.iter().map(dialog_file_path_to_string).collect::<Vec<_>>();
    Ok(serde_json::json!({ "canceled": false, "filePaths": file_paths }))
  }
}

#[tauri::command]
fn show_save_dialog(app: AppHandle, options: SaveDialogOptions) -> Result<serde_json::Value, String> {
  let mut file_dialog = app.dialog().file();
  if let Some(title) = options.title.as_deref() {
    file_dialog = file_dialog.set_title(title);
  }
  file_dialog = apply_default_dialog_path(file_dialog, options.default_path.as_deref());
  for filter in &options.filters {
    let extensions = filter.extensions.iter().map(String::as_str).collect::<Vec<_>>();
    file_dialog = file_dialog.add_filter(&filter.name, &extensions);
  }
  let path = file_dialog.blocking_save_file();
  if let Some(path) = path {
    Ok(serde_json::json!({ "canceled": false, "filePath": dialog_file_path_to_string(&path) }))
  } else {
    Ok(serde_json::json!({ "canceled": true, "filePath": null }))
  }
}

#[tauri::command]
fn get_encrypt_key_status() -> serde_json::Value {
  serde_json::json!({
    "hasEnvKey": std::env::var("SSH_CLIENT_ENCRYPT_KEY").is_ok(),
    "envKey": "SSH_CLIENT_ENCRYPT_KEY"
  })
}

#[tauri::command]
fn export_data(app: AppHandle, state: tauri::State<AppState>, file_path: String) -> Result<serde_json::Value, String> {
  ensure_storage(&app, &state)?;
  let data = state.data.lock().unwrap().clone();
  let export_data = if let Some(config) = current_mysql_config(&data) {
    init_mysql_schema(&config)?;
    mysql_export_data(&config, data.settings.clone())?
  } else {
    data
  };
  let export = serde_json::json!({
    "groups": export_data.groups,
    "connections": export_data.connections,
    "quickCommands": export_data.quick_commands,
    "exportTime": now_string(),
    "source": "tauri"
  });
  fs::write(&file_path, serde_json::to_string_pretty(&export).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
  Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
fn import_data(app: AppHandle, state: tauri::State<AppState>, file_path: String) -> Result<serde_json::Value, String> {
  ensure_storage(&app, &state)?;
  let text = fs::read_to_string(&file_path).map_err(|e| e.to_string())?;
  let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
  let mut imported = DataFile {
    settings: state.data.lock().unwrap().settings.clone(),
    ..DataFile::default()
  };
  if let Some(groups) = value.get("groups").and_then(|v| v.as_array()) {
    imported.groups = groups
      .iter()
      .filter_map(|item| item.as_str().map(|s| s.to_string()))
      .collect();
  }
  if imported.groups.is_empty() {
    imported.groups.push("默认分组".to_string());
  }
  if let Some(connections) = value.get("connections") {
    imported.connections = serde_json::from_value(connections.clone()).unwrap_or_default();
  }
  if let Some(commands) = value.get("quickCommands") {
    imported.quick_commands = serde_json::from_value(commands.clone()).unwrap_or_default();
  }
  if let Some(config) = current_mysql_config(&imported) {
    mysql_import_data(&config, &imported)?;
    return Ok(serde_json::json!({ "success": true }));
  }
  with_data(&app, &state, |data| {
    data.groups = imported.groups.clone();
    data.connections = imported.connections.clone();
    data.quick_commands = imported.quick_commands.clone();
    serde_json::json!({ "success": true })
  })
}

#[tauri::command]
fn test_mysql(config: MySqlConfig) -> Result<serde_json::Value, String> {
  let config = normalize_mysql_config(config)?;
  let mut conn = mysql_conn(&config, None)?;
  conn.query_drop("SELECT 1").map_err(|e| e.to_string())?;
  Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
fn switch_mysql(app: AppHandle, state: tauri::State<AppState>, config: MySqlConfig) -> Result<serde_json::Value, String> {
  let config = normalize_mysql_config(config)?;
  init_mysql_schema(&config)?;
  let mysql_config = serde_json::to_value(&config).map_err(|e| e.to_string())?;
  let db_config = with_data(&app, &state, |data| {
    data.settings.db_type = "mysql".to_string();
    data.settings.mysql_config = Some(mysql_config.clone());
    DbConfig {
      db_type: data.settings.db_type.clone(),
      mysql_config: data.settings.mysql_config.clone(),
      winscp_path: data.settings.winscp_path.clone(),
    }
  })?;
  Ok(serde_json::json!({ "success": true, "config": db_config }))
}

#[tauri::command]
fn switch_sqlite(app: AppHandle, state: tauri::State<AppState>) -> Result<serde_json::Value, String> {
  let db_config = with_data(&app, &state, |data| {
    data.settings.db_type = "sqlite".to_string();
    DbConfig {
      db_type: data.settings.db_type.clone(),
      mysql_config: data.settings.mysql_config.clone(),
      winscp_path: data.settings.winscp_path.clone(),
    }
  })?;
  Ok(serde_json::json!({ "success": true, "config": db_config }))
}

#[tauri::command]
fn sync_sqlite_to_mysql(app: AppHandle, state: tauri::State<AppState>) -> Result<serde_json::Value, String> {
  ensure_storage(&app, &state)?;
  let data = state.data.lock().unwrap().clone();
  let config = current_mysql_config(&data).ok_or_else(|| "请先连接并切换到 MySQL".to_string())?;
  let count = mysql_import_data(&config, &data)?;
  Ok(serde_json::json!({ "success": true, "count": count }))
}

#[tauri::command]
fn sync_mysql_to_sqlite(app: AppHandle, state: tauri::State<AppState>) -> Result<serde_json::Value, String> {
  ensure_storage(&app, &state)?;
  let data = state.data.lock().unwrap().clone();
  let config = current_mysql_config(&data).ok_or_else(|| "请先连接并切换到 MySQL".to_string())?;
  let imported = mysql_export_data(&config, data.settings.clone())?;
  let count = imported.connections.len();
  with_data(&app, &state, |data| {
    data.groups = imported.groups.clone();
    data.connections = imported.connections.clone();
    data.quick_commands = imported.quick_commands.clone();
    serde_json::json!({ "success": true, "count": count })
  })
}

#[tauri::command]
fn open_in_winscp(app: AppHandle, state: tauri::State<AppState>, conn: Connection) -> Result<serde_json::Value, String> {
  let config = get_db_config(app, state)?;
  let winscp_path = config.winscp_path.trim().to_string();
  if winscp_path.is_empty() {
    return Ok(serde_json::json!({ "success": false, "error": "请先在设置中配置 WinSCP 路径" }));
  }
  if conn.host.is_empty() || conn.username.is_empty() {
    return Ok(serde_json::json!({ "success": false, "error": "连接信息不完整" }));
  }
  let session_url = format!("sftp://{}@{}:{}/", urlencoding::encode(&conn.username), conn.host, if conn.port == 0 { 22 } else { conn.port });
  let mut args = vec![session_url, "/newinstance".to_string()];
  if conn.auth_type == "privateKey" {
    if conn.private_key.is_empty() {
      return Ok(serde_json::json!({ "success": false, "error": "当前连接未配置私钥内容" }));
    }
    let temp_dir = std::env::temp_dir().join("ssh-lite-client-winscp");
    fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
    let key_path = temp_dir.join(format!("winscp_key_{}.pem", Utc::now().timestamp_millis()));
    fs::write(&key_path, conn.private_key).map_err(|e| e.to_string())?;
    args.push(format!("/privatekey={}", key_path.display()));
    if !conn.passphrase.is_empty() {
      args.push(format!("/passphrase={}", conn.passphrase));
    }
  } else if !conn.password.is_empty() {
    args.push(format!("/password={}", conn.password));
  }
  Command::new(winscp_path)
    .args(args)
    .spawn()
    .map_err(|e| e.to_string())?;
  Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
fn open_new_window(app: AppHandle) -> Result<serde_json::Value, String> {
  let label = format!("child-{}", Utc::now().timestamp_millis());
  WebviewWindowBuilder::new(&app, label, WebviewUrl::App("index.html".into()))
    .title("SSH Client")
    .inner_size(1280.0, 800.0)
    .build()
    .map_err(|e| e.to_string())?;
  Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
fn detach_tab(app: AppHandle, session_id: String, config: Connection, title: String) -> Result<serde_json::Value, String> {
  let label = format!("terminal-{}", Utc::now().timestamp_millis());
  let init_payload = serde_json::json!({ "sessionId": session_id, "config": config, "title": title });
  WebviewWindowBuilder::new(&app, label, WebviewUrl::App("terminal.html".into()))
    .title("SSH Client")
    .inner_size(1280.0, 800.0)
    .decorations(false)
    .on_page_load(move |window, event| {
      if matches!(event.event(), PageLoadEvent::Finished) {
        let _ = window.emit("init-terminal", init_payload.clone());
      }
    })
    .build()
    .map_err(|e| e.to_string())?;
  Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
fn ssh_connect(app: AppHandle, state: tauri::State<AppState>, session_id: String, config: Connection) -> Result<serde_json::Value, String> {
  if config.x11_forwarding {
    return Ok(serde_json::json!({ "success": false, "error": "Tauri/Rust 版暂不支持 X11 转发，请关闭该连接的 X11 转发后再连接" }));
  }
  state.sftp_sessions.lock().unwrap().remove(&session_id);
  if let Some(record) = state.ssh_sessions.lock().unwrap().remove(&session_id) {
    record.alive.store(false, Ordering::SeqCst);
    let _ = record.channel.lock().unwrap().close();
    let _ = record.session.disconnect(None, "Reconnecting", None);
  }
  let (session, channel) = create_ssh_runtime(&config)?;
  let runtime_id = create_runtime_id();
  let alive = Arc::new(AtomicBool::new(true));
  let channel = Arc::new(Mutex::new(channel));
  let record = SshSessionRecord {
    runtime_id: runtime_id.clone(),
    config: config.clone(),
    title: if config.name.is_empty() { config.host.clone() } else { config.name.clone() },
    is_detached: false,
    connected_at: now_string(),
    session: session.clone(),
    channel: channel.clone(),
    alive: alive.clone(),
  };
  state.ssh_sessions.lock().unwrap().insert(session_id.clone(), record);
  spawn_ssh_reader(app, session_id, runtime_id, channel, alive);
  Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
fn ssh_input(state: tauri::State<AppState>, session_id: String, data: String) -> Result<serde_json::Value, String> {
  let channel = {
    let sessions = state.ssh_sessions.lock().unwrap();
    let record = sessions.get(&session_id).ok_or_else(|| "SSH 未连接".to_string())?;
    record.channel.clone()
  };
  let mut guard = channel.lock().unwrap();
  write_all_ssh(&mut *guard, data.as_bytes())?;
  guard.flush().map_err(|e| e.to_string())?;
  Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
fn ssh_resize(state: tauri::State<AppState>, session_id: String, cols: i64, rows: i64) -> Result<serde_json::Value, String> {
  let channel = {
    let sessions = state.ssh_sessions.lock().unwrap();
    let record = sessions.get(&session_id).ok_or_else(|| "SSH 未连接".to_string())?;
    record.channel.clone()
  };
  let mut guard = channel.lock().unwrap();
  let cols = cols.max(1) as u32;
  let rows = rows.max(1) as u32;
  wait_ssh(|| guard.request_pty_size(cols, rows, None, None))?;
  Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
fn ssh_disconnect(app: AppHandle, state: tauri::State<AppState>, session_id: String) -> Result<serde_json::Value, String> {
  state.sftp_sessions.lock().unwrap().remove(&session_id);
  let record = state.ssh_sessions.lock().unwrap().remove(&session_id);
  if let Some(record) = record {
    record.alive.store(false, Ordering::SeqCst);
    let _ = record.channel.lock().unwrap().close();
    let _ = record.session.disconnect(None, "Disconnected", None);
    let _ = app.emit(&format!("ssh-close-{}", session_id), true);
  }
  Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
fn sftp_connect(state: tauri::State<AppState>, session_id: String) -> Result<serde_json::Value, String> {
  if state.sftp_sessions.lock().unwrap().contains_key(&session_id) {
    return Ok(serde_json::json!({ "success": true }));
  }
  let (runtime_id, session) = {
    let sessions = state.ssh_sessions.lock().unwrap();
    let record = sessions.get(&session_id).ok_or_else(|| "无对应的 SSH 连接".to_string())?;
    (record.runtime_id.clone(), record.session.clone())
  };
  let sftp = wait_ssh(|| session.sftp())?;
  state.sftp_sessions.lock().unwrap().insert(session_id.clone(), SftpSessionRecord {
    runtime_id,
    session_id,
    connected_at: now_string(),
    sftp: Arc::new(Mutex::new(sftp)),
  });
  Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
fn sftp_list(state: tauri::State<AppState>, session_id: String, remote_path: String) -> Result<serde_json::Value, String> {
  let sftp = {
    let sessions = state.sftp_sessions.lock().unwrap();
    let record = sessions.get(&session_id).ok_or_else(|| "SFTP 未连接".to_string())?;
    record.sftp.clone()
  };
  let list = list_remote_dir(&sftp, &remote_path)?;
  Ok(serde_json::json!({ "success": true, "list": list }))
}

#[tauri::command]
fn sftp_download(state: tauri::State<AppState>, session_id: String, remote_path: String, local_path: String) -> Result<serde_json::Value, String> {
  let sftp = {
    let sessions = state.sftp_sessions.lock().unwrap();
    let record = sessions.get(&session_id).ok_or_else(|| "SFTP 未连接".to_string())?;
    record.sftp.clone()
  };
  read_remote_file_to_local(&sftp, &remote_path, Path::new(&local_path))?;
  Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
fn sftp_download_dir(state: tauri::State<AppState>, session_id: String, remote_path: String, local_path: String) -> Result<serde_json::Value, String> {
  let sftp = {
    let sessions = state.sftp_sessions.lock().unwrap();
    let record = sessions.get(&session_id).ok_or_else(|| "SFTP 未连接".to_string())?;
    record.sftp.clone()
  };
  let dirname = Path::new(&remote_path)
    .file_name()
    .map(|value| value.to_string_lossy().to_string())
    .filter(|value| !value.is_empty())
    .unwrap_or_else(|| "download".to_string());
  let local_dir = Path::new(&local_path).join(dirname);
  download_remote_dir(&sftp, &remote_path, &local_dir)?;
  Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
fn sftp_upload(state: tauri::State<AppState>, session_id: String, local_path: String, remote_path: String) -> Result<serde_json::Value, String> {
  let sftp = {
    let sessions = state.sftp_sessions.lock().unwrap();
    let record = sessions.get(&session_id).ok_or_else(|| "SFTP 未连接".to_string())?;
    record.sftp.clone()
  };
  write_local_file_to_remote(&sftp, Path::new(&local_path), &remote_path)?;
  Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
fn sftp_mkdir(state: tauri::State<AppState>, session_id: String, remote_path: String) -> Result<serde_json::Value, String> {
  let sftp = {
    let sessions = state.sftp_sessions.lock().unwrap();
    let record = sessions.get(&session_id).ok_or_else(|| "SFTP 未连接".to_string())?;
    record.sftp.clone()
  };
  let guard = sftp.lock().unwrap();
  wait_ssh(|| guard.mkdir(Path::new(&remote_path), 0o755))?;
  Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
fn sftp_delete(state: tauri::State<AppState>, session_id: String, remote_path: String, is_dir: bool) -> Result<serde_json::Value, String> {
  let sftp = {
    let sessions = state.sftp_sessions.lock().unwrap();
    let record = sessions.get(&session_id).ok_or_else(|| "SFTP 未连接".to_string())?;
    record.sftp.clone()
  };
  let guard = sftp.lock().unwrap();
  if is_dir {
    wait_ssh(|| guard.rmdir(Path::new(&remote_path)))?;
  } else {
    wait_ssh(|| guard.unlink(Path::new(&remote_path)))?;
  }
  Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
fn sftp_rename(state: tauri::State<AppState>, session_id: String, old_path: String, new_path: String) -> Result<serde_json::Value, String> {
  let sftp = {
    let sessions = state.sftp_sessions.lock().unwrap();
    let record = sessions.get(&session_id).ok_or_else(|| "SFTP 未连接".to_string())?;
    record.sftp.clone()
  };
  let guard = sftp.lock().unwrap();
  wait_ssh(|| guard.rename(Path::new(&old_path), Path::new(&new_path), None))?;
  Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
fn sftp_stat(state: tauri::State<AppState>, session_id: String, remote_path: String) -> Result<serde_json::Value, String> {
  let sftp = {
    let sessions = state.sftp_sessions.lock().unwrap();
    let record = sessions.get(&session_id).ok_or_else(|| "SFTP 未连接".to_string())?;
    record.sftp.clone()
  };
  let guard = sftp.lock().unwrap();
  let stat = wait_ssh(|| guard.lstat(Path::new(&remote_path)))?;
  Ok(serde_json::json!({
    "success": true,
    "stat": {
      "size": stat.size.unwrap_or(0),
      "mtime": stat.mtime.unwrap_or(0),
      "permissions": stat.perm,
      "isDir": file_kind(stat.perm).0,
      "isSymlink": file_kind(stat.perm).1
    }
  }))
}

#[tauri::command]
fn sftp_disconnect(state: tauri::State<AppState>, session_id: String) -> Result<serde_json::Value, String> {
  state.sftp_sessions.lock().unwrap().remove(&session_id);
  Ok(serde_json::json!({ "success": true }))
}

fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .manage(AppState::default())
    .invoke_handler(tauri::generate_handler![
      win_minimize,
      win_maximize,
      win_close,
      get_connections,
      save_connection,
      delete_connection,
      reorder_connections,
      get_groups,
      save_group,
      delete_group,
      get_quick_commands,
      save_quick_command,
      delete_quick_command,
      get_db_config,
      save_winscp_path,
      get_encrypt_key_status,
      export_data,
      import_data,
      show_open_dialog,
      show_save_dialog,
      test_mysql,
      switch_mysql,
      switch_sqlite,
      sync_sqlite_to_mysql,
      sync_mysql_to_sqlite,
      open_in_winscp,
      open_new_window,
      detach_tab,
      ssh_connect,
      ssh_input,
      ssh_resize,
      ssh_disconnect,
      sftp_connect,
      sftp_list,
      sftp_download,
      sftp_download_dir,
      sftp_upload,
      sftp_mkdir,
      sftp_delete,
      sftp_rename,
      sftp_stat,
      sftp_disconnect
    ])
    .setup(|app| {
      let Some(path) = storage_file(&app.handle()) else {
        return Ok(());
      };
      if !path.exists() {
        let _ = save_data(&path, &default_data());
      }
      let data = load_data(&path);
      let state = app.state::<AppState>();
      *state.data.lock().unwrap() = data;
      *state.storage_path.lock().unwrap() = Some(path);
      let windows = app.webview_windows();
      if windows.is_empty() {
        let _ = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
          .title("SSH Client")
          .inner_size(1280.0, 800.0)
          .min_inner_size(900.0, 600.0)
          .decorations(false)
          .build();
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
