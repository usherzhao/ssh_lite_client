# Electron SSH Client

一个基于 **Electron + JavaScript** 构建的跨平台 SSH 客户端，支持多标签、分屏、多窗口、SFTP 文件管理、快捷指令、服务器排序等功能。

---

## 功能特性

| 功能 | 说明 |
|------|------|
| SSH 连接 | 支持密码认证 / 私钥（PEM）+ 口令认证 |
| 登录后自动执行 | 连接成功后按行自动发送预设命令 |
| 分组管理 | 连接按分组归类，支持折叠/展开 |
| 多标签页 | 同时管理多个 SSH 会话 |
| 分屏显示 | 单窗口内水平并列所有会话 |
| 多窗口 | 将标签页弹出为独立窗口（多屏使用）|
| SFTP | 内置文件管理器，支持上传/下载/删除/重命名/新建目录/目录递归下载 |
| SFTP 拖拽上传 | 支持将本地文件或文件夹拖拽到 SFTP 面板进行上传 |
| SFTP 传输任务列表 | 显示上传下载进度，支持多任务管理和状态查看 |
| SFTP 路径输入 | 支持直接输入路径后按回车跳转，一键复制当前路径 |
| 终端 cd 同步 | 终端执行 cd 命令时自动同步 SFTP 目录，支持相对路径 |
| 安全编辑 | 编辑连接时不显示明文密码，保护敏感信息 |
| 数据同步确认 | 数据库同步操作前弹出二次确认，防止误操作 |
| 快捷指令 | 预存常用命令，一键发送到当前终端 |
| 指令发送窗口 | 支持多行输入、回车发送、Shift+Enter 换行，独立于终端的命令输入面板 |
| 历史记录 | 面板内持久显示命令历史，按时间顺序排列，支持点击插入、删除单条、清空所有 |
| 终端输入捕获 | 自动记录终端中直接输入的指令到历史列表，区分来源（终端/指令窗口） |
| 终端外观 | 字体、字号、行高、字符编码（UTF-8/GBK/Big5 等）实时切换 |
| 右键粘贴 | 终端输入窗口支持右键直接粘贴 |
| 服务器排序 | 已保存服务器支持拖拽自定义排序及按名称/主机/时间排序 |
| 全局搜索 | 按名称/主机/备注快速筛选连接 |
| 双数据库 | 本地 SQLite（默认）或远端 MySQL，支持双向同步 |
| 数据导入导出 | 一键导出 JSON 备份，跨机器迁移 |

---

## 技术框架

| 层级 | 技术 |
|------|------|
| 桌面框架 | [Electron](https://www.electronjs.org/) `^27.3.11` |
| 主进程 | Node.js（内置）|
| 渲染进程 | 原生 HTML + CSS + 纯 JS（无前端框架）|
| 终端模拟 | [xterm.js](https://xtermjs.org/) `^5.3.0` |
| SSH/SFTP 协议 | [ssh2](https://github.com/mscdex/ssh2) `^1.17.0` |
| 本地数据库 | [sql.js](https://github.com/sql-js/sql.js)（纯 JS SQLite）`^1.10.3` |
| 远端数据库 | [mysql2](https://github.com/sidorares/node-mysql2) `^3.22.0` |
| 配置持久化 | [electron-store](https://github.com/sindresorhus/electron-store) `^8.2.0` |
| 打包工具 | [electron-builder](https://www.electron.build/) `^26.8.1` |

### 前端插件

| 包 | 版本 | 用途 |
|----|------|------|
| `xterm-addon-fit` | `^0.8.0` | 终端自适应容器尺寸 |
| `xterm-addon-web-links` | `^0.9.0` | 终端内超链接识别与跳转 |

---

## 目录结构

```
electron-ssh-client/
├── main.js              # Electron 主进程
│                        #   - 窗口管理（BrowserWindow）
│                        #   - IPC 处理（SSH 连接/断开、SFTP 上传下载、数据库读写）
│                        #   - SSH 会话生命周期管理
│                        #   - SFTP 递归目录下载
├── preload.js           # 上下文桥接（contextBridge / contextIsolation）
│                        #   - 将主进程 IPC 安全暴露给渲染进程
├── db.js                # 数据库抽象层
│                        #   - SQLite（sql.js）/ MySQL（mysql2）双引擎
│                        #   - AES-256-CBC 对称加密敏感字段
│                        #   - 自动建表 / ALTER TABLE 兼容旧库
│                        #   - 连接自定义排序（sort_order）
├── renderer/
│   ├── index.html       # 主界面 HTML（侧边栏 + 标签页 + SFTP 面板）
│   ├── terminal.html    # 独立终端窗口 HTML（多屏弹出）
│   ├── app.js           # 渲染进程主逻辑
│   │                    #   - 连接列表渲染、拖拽排序
│   │                    #   - xterm.js 终端挂载 / resize / 右键粘贴
│   │                    #   - SFTP 文件管理器（列目录、上传、下载目录/文件）
│   │                    #   - 快捷指令面板
│   │                    #   - 终端外观设置
│   └── style.css        # 全局样式
│                        #   - 深色主题、侧边栏、标签页、SFTP 面板
│                        #   - 排序工具栏、拖拽高亮
├── assets/
│   └── icon.ico         # 应用图标（Windows）
├── dist/                # electron-builder 打包输出目录（构建产物）
├── package.json         # 项目配置 & 依赖声明
├── package-lock.json    # 依赖锁定文件
└── ssh-client-backup.json  # 连接配置备份示例（JSON 导出格式）
```

---

## 安装 & 运行

### 环境要求

- **Node.js** >= 18.x
- **npm** >= 9.x
- Windows 平台需安装 [Visual C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)（原生模块编译依赖）

### 安装依赖

```bash
npm install
```

### 开发模式启动

```bash
npm start
# 等价于：electron .
```

### 打包（Windows x64）

```bash
# 完整打包（生成可执行文件到 dist/）
npm run build
# 等价于：electron-builder --win --x64

# 仅解包目录（不生成安装包，速度更快，用于调试打包结果）
npm run build:dir
# 等价于：electron-builder --win --x64 --dir
```

> 打包产物输出至 `dist/` 目录，同时生成 **NSIS 安装包** 和 **便携版 exe**，架构为 **x64**。

---

## 数据库设计

### 存储引擎

- **默认**：[sql.js](https://github.com/sql-js/sql.js)（纯 JS 实现的 SQLite，数据库文件存于 Electron `userData` 目录，无需安装额外驱动）
- **可选**：MySQL（在应用设置界面配置连接信息后切换，支持与 SQLite 双向同步）

### 加密密钥状态

数据库设置页面会显示加密密钥的当前状态：
- **已设置环境变量**：使用 `SSH_CLIENT_ENCRYPT_KEY` 环境变量中指定的密钥
- **未设置环境变量**：使用内置默认密钥

### 建表语句

#### SQLite

```sql
-- 分组表
CREATE TABLE IF NOT EXISTS groups (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT UNIQUE NOT NULL
);

-- 连接配置表
CREATE TABLE IF NOT EXISTS connections (
  id            TEXT    PRIMARY KEY,
  name          TEXT    NOT NULL,
  host          TEXT    NOT NULL,
  port          INTEGER DEFAULT 22,
  username      TEXT    NOT NULL,
  auth_type     TEXT    DEFAULT 'password',   -- 'password' | 'privateKey'
  password      TEXT,                         -- AES-256-CBC 加密存储
  private_key   TEXT,                         -- AES-256-CBC 加密存储
  passphrase    TEXT,                         -- AES-256-CBC 加密存储
  group_name    TEXT    DEFAULT '默认分组',
  note          TEXT,
  init_commands TEXT,                         -- 登录后自动执行命令（每行一条）
  created_at    TEXT,
  updated_at    TEXT,
  sort_order    INTEGER DEFAULT 0             -- 自定义排序权重
);

-- 快捷指令表
CREATE TABLE IF NOT EXISTS quick_commands (
  id         TEXT    PRIMARY KEY,
  name       TEXT    NOT NULL,
  command    TEXT    NOT NULL,
  category   TEXT    DEFAULT '常用',
  sort_order INTEGER DEFAULT 0,
  created_at TEXT
);
```

#### MySQL

```sql
CREATE TABLE IF NOT EXISTS groups (
  id   INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL
) CHARACTER SET utf8mb4;

CREATE TABLE IF NOT EXISTS connections (
  id            VARCHAR(64)  PRIMARY KEY,
  name          VARCHAR(200) NOT NULL,
  host          VARCHAR(200) NOT NULL,
  port          INT          DEFAULT 22,
  username      VARCHAR(100) NOT NULL,
  auth_type     VARCHAR(20)  DEFAULT 'password',
  password      TEXT,
  private_key   TEXT,
  passphrase    TEXT,
  group_name    VARCHAR(100) DEFAULT '默认分组',
  note          TEXT,
  init_commands TEXT,
  created_at    VARCHAR(30),
  updated_at    VARCHAR(30),
  sort_order    INT          DEFAULT 0
) CHARACTER SET utf8mb4;

CREATE TABLE IF NOT EXISTS quick_commands (
  id         VARCHAR(64)  PRIMARY KEY,
  name       VARCHAR(200) NOT NULL,
  command    TEXT         NOT NULL,
  category   VARCHAR(100) DEFAULT '常用',
  sort_order INT          DEFAULT 0,
  created_at VARCHAR(30)
) CHARACTER SET utf8mb4;
```

---

## 数据加密

敏感字段（`password`、`private_key`、`passphrase`）在写入数据库前全部加密，读取后解密，**明文从不落盘**。

| 项目 | 值 |
|------|----|
| 算法 | AES-256-CBC |
| 密钥长度 | 256 bit（32 字节） |
| IV 长度 | 128 bit（16 字节），每次加密随机生成 |
| 编码 | 密文以 `hex` 编码；存储格式：`<IV_hex>:<ciphertext_hex>` |
| Node.js API | `crypto.createCipheriv` / `crypto.createDecipheriv` |

### 密钥管理

- **默认密钥**：内置 32 字节固定密钥（适用于本地单机场景）
- **环境变量**：支持通过 `SSH_CLIENT_ENCRYPT_KEY` 环境变量注入自定义密钥
- **状态显示**：数据库设置页面会显示当前密钥来源（环境变量 / 默认）

> **安全提示**：生产/团队环境建议通过环境变量注入密钥，避免源码泄露导致密钥暴露。

> **注意**：修改密钥后，已存储的加密数据将无法解密，请谨慎操作。

---

## 前端持久化

以下配置存储在渲染进程 `localStorage`（非敏感偏好数据，不加密）：

| Key | 内容 |
|-----|------|
| `termSettings` | 终端字体、字号、行高、字符编码 |
| `collapsedGroups` | 侧边栏已折叠的分组名列表 |

---

## IPC 通信一览

| 频道名 | 方向 | 说明 |
|--------|------|------|
| `ssh-connect` | R→M | 建立 SSH 连接 |
| `ssh-disconnect` | R→M | 断开连接 |
| `ssh-input` | R→M | 发送键盘输入 |
| `ssh-output` | M→R | 接收终端输出 |
| `ssh-resize` | R→M | 终端尺寸变更 |
| `sftp-list` | R→M | 列出远程目录 |
| `sftp-upload` | R→M | 上传本地文件 |
| `sftp-download` | R→M | 下载单个文件 |
| `sftp-download-dir` | R→M | 递归下载整个目录 |
| `sftp-delete` | R→M | 删除远程文件/目录 |
| `sftp-rename` | R→M | 重命名远程条目 |
| `sftp-mkdir` | R→M | 创建远程目录 |
| `get-connections` | R→M | 读取连接列表 |
| `save-connection` | R→M | 保存/更新连接 |
| `delete-connection` | R→M | 删除连接 |
| `reorder-connections` | R→M | 更新连接排序 |
| `get-quick-commands` | R→M | 读取快捷指令 |
| `save-quick-command` | R→M | 保存快捷指令 |
| `delete-quick-command` | R→M | 删除快捷指令 |
| `get-encrypt-key-status` | R→M | 获取加密密钥状态（环境变量是否设置） |

> R→M：渲染进程发起，主进程响应（`ipcRenderer.invoke` / `ipcMain.handle`）
> M→R：主进程推送（`webContents.send` / `ipcRenderer.on`）

---

## 多屏使用

1. 点击标签栏右侧 **⬛** 按钮开启分屏模式（所有会话并列显示）
2. 点击 **🗗** 按钮将当前连接弹出为独立窗口，拖到第二块屏幕
3. 右键标签页 → **在新窗口打开**

---

## SFTP 文件管理

### 基本操作
- **打开/关闭**：点击主界面右侧 **📁** 按钮切换 SFTP 面板
- **导航**：双击目录进入，点击 **↑** 按钮返回上级目录
- **上传**：点击 **⬆** 按钮选择文件上传
- **下载**：右键文件选择 **⬇ 下载**，右键目录选择 **⬇ 下载目录**
- **新建目录**：点击 **📂+** 按钮创建新目录
- **重命名/删除**：右键文件或目录进行操作

### 拖拽上传
- **单个文件**：直接拖拽本地文件到 SFTP 面板
- **整个文件夹**：拖拽本地文件夹到 SFTP 面板，会自动创建同名目录并上传所有内容
- **拖拽反馈**：拖拽过程中 SFTP 面板会显示虚线边框和背景高亮

### 传输任务列表
- **自动显示**：有上传或下载任务时自动显示
- **任务状态**：显示 pending（等待）、progress（进行中）、success（成功）、error（失败）四种状态
- **进度显示**：每个任务都有实时进度条和百分比
- **任务管理**：
  - **🗑**：清空已完成的任务
  - **✕**：关闭任务列表
- **多任务支持**：同时显示多个传输任务的状态

---

## 指令发送窗口

### 打开/关闭
- 点击主界面底部 **⌨ 指令发送** 按钮打开面板
- 点击面板右上角 **✕** 按钮关闭

### 功能说明
- **多行输入**：支持输入多行命令，每行自动发送
- **快捷操作**：
  - **Enter**：发送命令
  - **Shift+Enter**：换行
  - **⊘**：清空输入框
  - **🗑**：清空历史记录
  - **▼**：折叠/展开面板

### 历史记录
- 面板中间区域显示历史命令列表（按时间顺序，最新在底部）
- 每条记录包含：序号、来源标识（⌨ 终端输入 / ▶ 面板发送）、命令内容、发送时间、删除按钮
- **点击命令**：自动插入到输入框
- **点击删除**：移除单条历史记录
- **双击历史区**：无操作（保持简洁）

### 终端输入捕获
- 自动记录在终端窗口直接输入的命令到历史列表
- 实时更新，无需手动添加
- 与面板发送的命令统一管理

---

## License

MIT

---

## 更新记录

- **2026-04-13**：
  - 新增 SFTP 路径输入功能：支持直接输入路径跳转，一键复制路径
  - 新增终端 cd 同步功能：终端执行 cd 命令时自动同步 SFTP 目录
  - 新增安全编辑功能：编辑连接时不显示明文密码
  - 新增数据同步确认：数据库同步前弹出二次确认
  - 修复 SFTP 路径显示问题：正确处理相对路径
  - 修复首次连接 cd 命令同步问题：缓存 cd 命令并在 SFTP 连接后执行
  - 优化打包配置：支持 NSIS 安装包和便携版双模式生成，图标配置优化确保正确显示
