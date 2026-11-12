# P10 WebDAV 备份与导入

> 状态：v1 已实现（桌面端）· 2026-11-12 · 实现记录见文末第 11 节
> 适用端：Windows 桌面端（现有）+ Android 客户端（见 [P11 安卓端设计](P11-android.md)）

## 结论

**可以支持，而且不需要改账本引擎。**

现有备份链路已经把最难的部分做好了：`VACUUM INTO` 生成完整 SQLite 快照、可选 AES-256-GCM 加密、恢复前完整性校验、暂存恢复标记、启动前归档与失败回滚。WebDAV 只是把 `backups/` 目录从本机搬到远端，再加上网络传输、凭据管理、失败重试和远端列表。

建议分两层：

1. **v1 快照备份 / 恢复（推荐先做）**：上传、列出、下载、校验、恢复。语义与现有本地备份完全一致，风险低。
2. **v2 多设备同步（另立方案）**：不要把 SQLite 文件当同步协议。若需要手机和桌面同时记账，应改为事件日志增量合并；见本文第 10 节。

---

## 1. 现有基础

| 能力 | 位置 | 可直接复用 |
|---|---|---|
| 快照生成 | `crates/wheel-app/src/backup.rs` · `create` / `create_encrypted` | ✅ 先在本机生成，再上传 |
| 加密格式 | `crates/wheel-app/src/crypto.rs` · PBKDF2-HMAC-SHA256 + AES-256-GCM | ✅ `.sqlite.enc` 原样上传 |
| 校验 | `backup::validate_with_password` | ✅ 下载后先校验 |
| 暂存恢复 | `restore::stage_with_password` | ✅ 下载到 `backups/` 后复用 |
| 启动替换 | `restore::apply_pending` | ✅ 不变 |
| 安全快照 | `backup::create(..., "pre-restore-", ...)` | ✅ 恢复前自动创建 |
| 自动备份 | `backup::run_if_due` | ✅ 成功后追加一次上传 |
| 设置 | `settings` 表 + `commands.rs` | ✅ 新增 WebDAV 配置 |

因此 v1 的改动集中在：一个 `webdav.rs` 传输模块、一组 Tauri command、一个设置区块和 UI。

---

## 2. 范围与非目标

### v1 做

- 配置 WebDAV 服务器、账号、远程目录。
- 测试连接、列出远端快照、手动上传、从远端下载并恢复。
- 每日自动备份成功后自动上传（可关闭）。
- 远端保留份数、手动删除远端快照。
- 加密上传（默认开启），密码不落库。
- 失败可恢复：网络失败不阻断本地备份，不自动恢复，不覆盖本机账本。

### v1 不做

- ❌ 实时双向同步、多主写入。
- ❌ 把 SQLite 文件当作同步协议做增量 diff。
- ❌ 自动恢复远端文件（必须用户确认 + 校验 + 本地安全快照）。
- ❌ 明文保存 WebDAV 密码到 SQLite。
- ❌ 支持 Digest 认证之外的冷门认证（先 Basic + HTTPS，文档说明）。

---

## 3. v1 快照备份 / 恢复

### 3.1 上传

```
本地 backup::create / create_encrypted
        │
        ▼
PUT  <remoteDir>/wheel-<unix-nanos>-<rand>.sqlite[.enc].tmp
        │
        ▼
MOVE <remoteDir>/<final-name>        （服务器不支持 MOVE 时退化为直接 PUT）
        │
        ▼
可选：PUT latest.json（清单最后写，作为“提交点”）
```

- 文件名只使用 ASCII、时间戳与随机后缀，避免远端编码差异。
- 先写临时名再 `MOVE`，避免同步客户端/其他设备读到半个文件。
- 上传前记录本地文件的 SHA-256；上传后可用 `HEAD` / `PROPFIND` 校验大小。
- 上传失败只记录状态，不删除本地快照，不阻塞应用启动。

### 3.2 列出远端

使用 `PROPFIND`，`Depth: 1`：

- 只接受 `207 Multi-Status`。
- 解析 `d:response` 中的 `d:href`、`getcontentlength`、`getlastmodified`、`getetag`。
- 只展示以 `wheel-` / `auto-` 开头、以 `.sqlite` / `.sqlite.enc` 结尾的文件。
- 对 href 做 percent-decode，禁止 `..`、分隔符和绝对路径逃逸。
- 按修改时间倒序；同名冲突以 ETag 区分。

### 3.3 下载与恢复

```
选择远端快照
   │
   ▼
GET → 本地 backups/download-<stamp>.sqlite[.enc]
   │
   ▼
backup::validate_with_password（完整性 + 必需表 + schema 版本）
   │
   ▼
restore::stage_with_password（创建 pre-restore 安全快照 + 写 pending 标记）
   │
   ▼
下次启动：restore::apply_pending（归档当前库 → 替换 → 失败回滚）
```

- 下载文件先落到 `backups/`，与本地备份并列，便于用户二次确认。
- 加密快照在下载后仍保持 `.enc`；只有暂存恢复时才解密出临时副本，替换后立即删除。
- 下载有大小上限（建议 512 MB）与超时（连接 10s、整体 5min），防止异常服务器拖垮应用。
- 恢复流程完全复用现有校验/暂存/启动替换，不新增一套替换逻辑。

### 3.4 自动备份

现有 `backup::run_if_due` 每天最多生成一份 `auto-*.sqlite`。在其成功返回后：

1. 在主线程之外异步上传；
2. 上传成功更新 `last_upload_at` / `last_upload_file`；
3. 上传失败记录错误，下次启动或下次手动备份时重试；
4. 自动上传不创建新的本地快照，避免重复。

移动端没有可靠的常驻后台，v1 在应用启动、回到前台、手动备份时检查；真正的后台任务用 Android `WorkManager`（见 P11）。

### 3.5 保留策略

- 远端只清理由本应用创建、且匹配前缀的文件。
- 默认保留最近 10 份；手动备份与 `pre-restore-` 不自动删除。
- 删除前二次确认；删除失败不影响本地。
- `latest.json` 永远指向最后一次成功上传的快照，包含：

```json
{
  "version": 1,
  "file": "wheel-1762903800-0.sqlite.enc",
  "createdAt": "2026-11-12T08:30:00Z",
  "size": 2411724,
  "sha256": "…",
  "encrypted": true,
  "schema": 4,
  "appVersion": "0.7.0",
  "device": "windows-desktop"
}
```

### 3.6 冲突与多设备

快照恢复是**整库替换**，不是合并。必须明确告诉用户：

- 同一时间只建议一台设备写入；
- 若云端 `latest.json` 比本机上次恢复/上传更新，界面提示“云端有更新的备份”，但**不自动恢复**；
- 恢复永远先创建本机安全快照，失败可回滚；
- 如果两台设备都写入，后恢复的一方会覆盖前一方。需要真正的多设备编辑，请走第 10 节的事件日志方案。

---

## 4. 安全

| 项 | 方案 |
|---|---|
| 传输 | 只允许 HTTPS；HTTP 仅允许 localhost / 局域网，并需显式勾选“不安全连接” |
| 认证 | Basic Auth + 应用专用密码（坚果云、Nextcloud、群晖均支持） |
| 密码存储 | 系统凭据库：Windows Credential Manager / macOS Keychain / Linux Secret Service / Android Keystore；**不写入 SQLite** |
| 备份加密 | 默认开启，复用 PBKDF2 + AES-256-GCM；密码不保存，遗失不可恢复 |
| 重定向 | 禁止跨域重定向；仅允许同 host 的 301/302 |
| 路径 | 规范化远程目录；文件名白名单；禁止 `..`、`/`、`\`、`:` |
| 响应 | 限制响应体大小；`PROPFIND` XML 解析设置深度/实体限制，禁用外部实体 |
| 日志 | 不打印 Authorization、密码、完整 URL query；错误信息脱敏 |
| 明文风险 | 提示用户：未加密快照可被 WebDAV 服务商读取；SQLite 内含 AI API Key |

---

## 5. 接口设计

新增 `crates/wheel-app/src/webdav.rs`：

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavConfig {
    pub url: String,
    pub username: String,
    pub remote_dir: String,
    pub auto_upload: bool,
    pub keep: u32,
    pub encrypt: bool,
    pub allow_insecure_http: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBackup {
    pub file_name: String,
    pub size_bytes: u64,
    pub modified_at: Option<String>,
    pub etag: Option<String>,
    pub encrypted: bool,
}

pub fn test(config: &WebDavConfig, password: &str) -> Result<ServerInfo>;
pub fn list(config: &WebDavConfig, password: &str) -> Result<Vec<RemoteBackup>>;
pub fn upload(config: &WebDavConfig, password: &str, local: &Path, remote_name: &str) -> Result<()>;
pub fn download(config: &WebDavConfig, password: &str, remote_name: &str, target: &Path) -> Result<()>;
pub fn delete(config: &WebDavConfig, password: &str, remote_name: &str) -> Result<()>;
```

Tauri commands：

```
webdav_get_settings() -> WebDavSettingsView       // 不含密码，只返回 hasPassword / keyHint
webdav_save_settings(config, password: Option<String>) -> WebDavSettingsView
webdav_test(config, password) -> ServerInfo
webdav_list() -> Vec<RemoteBackup>
webdav_backup_now(password: Option<String>) -> RemoteBackup
webdav_restore(fileName, backupPassword: Option<String>) -> BackupValidation
webdav_stage_restore(fileName, backupPassword: Option<String>) -> PendingRestore
webdav_delete(fileName) -> bool
webdav_status() -> WebDavStatus                  // lastSuccess / lastError / lastFile / busy
```

实现要点：

- 复用现有 `reqwest`（`rustls-tls`），无需新增 HTTP 客户端。
- `PROPFIND` 用 `reqwest::Method::from_bytes(b"PROPFIND")`；XML 用 `quick-xml`（命名空间按 `DAV:` 匹配）。
- `MOVE` 的 `Destination` 必须是完整 URL，且做 percent-encode。
- 客户端设置 `timeout(30s)`、`redirect(Policy::none())`、`user_agent("WheelTracker/<version>")`。
- 下载先写 `*.part`，完成后原子改名；失败删除残片。
- 所有网络函数返回 `anyhow::Result`，commands 层转成中文错误。

### 配置存储

新增 schema v5 表（或 `settings` 的独立键）：

```sql
CREATE TABLE IF NOT EXISTS webdav_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  url TEXT NOT NULL,
  username TEXT NOT NULL,
  remote_dir TEXT NOT NULL,
  auto_upload INTEGER NOT NULL DEFAULT 1,
  keep_count INTEGER NOT NULL DEFAULT 10,
  encrypt INTEGER NOT NULL DEFAULT 1,
  allow_insecure_http INTEGER NOT NULL DEFAULT 0,
  last_upload_at TEXT,
  last_upload_file TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);
```

密码通过系统凭据库保存，键为 `wheel-tracker/webdav/<url>/<username>`。首次保存时写入，修改 URL/账号时清理旧键。

---

## 6. UI（桌面端）

在“设置 → 备份与维护”新增 **WebDAV 备份** 区块：

```
┌ WebDAV 备份 ───────────────────────────────┐
│ ● 已连接  dav.jianguoyun.com               │
│ 上次上传：今天 08:30 · wheel-…sqlite.enc   │
│ [立即备份] [测试连接] [编辑]               │
│ 自动上传  [开]   保留 [10] 份   加密 [开]  │
│ 云端快照                                    │
│  今天 08:30   2.4 MB  已加密   [恢复] [删除]│
│  昨天 08:30   2.3 MB  已加密   [恢复] [删除]│
└────────────────────────────────────────────┘
```

- “恢复”复用现有校验面板与恢复确认弹窗，只是文件来源变为远端。
- 恢复前明确提示：会创建本机安全快照、需要重启、暂存期间只读。
- 失败状态在面板顶部展示中文错误与“重试”。

移动端入口见 P11 的“我的 → 备份与同步”，交互为底部抽屉 + 全屏恢复流程。

---

## 7. 测试与验收

### 单元 / 集成测试

新增 dev-dependency：`axum` 或轻量 `hyper` 测试服务器，模拟 WebDAV：

- `PROPFIND` 返回 207 + 多个 `d:response`，含中文/空格文件名（percent-encoded）。
- `PUT` 临时文件 → `MOVE` 成功；服务器不支持 `MOVE`（405）时回退直接 PUT。
- 401/403/404/500/超时/响应体过大。
- 下载后 `validate` 通过；损坏文件校验失败且暂存被拒绝。
- 加密上传后远端仍是 `.enc`；恢复时临时明文在成功后删除。
- 保留策略只删匹配前缀，不动用户其他文件。
- `latest.json` 最后写入；ETag 不匹配时提示冲突。
- URL/目录/文件名注入：`..`、`/`、`\`、`%2e%2e`、超长名。

### 手工验收矩阵

| 服务 | 认证 | 必测 |
|---|---|---|
| 坚果云 | 应用密码 + Basic | 连接、上传、列表、恢复 |
| Nextcloud | 应用密码 + Basic | 同上 + 中文目录 |
| 群晖 WebDAV Server | Basic | 同上 + 自签证书报错提示 |
| 本地 rclone serve webdav | Basic | 断网/超时/恢复重试 |

### 验收口径

- 断网时本地备份仍成功，界面明确显示“云端上传失败，将于下次重试”。
- 远端列表不显示非本应用文件；删除只影响本应用前缀。
- 恢复加密快照需要密码；密码错误不暂存、不替换。
- 恢复后重启，事件数、账户数、报价数与远端快照一致。
- 任何失败都不会丢失本机当前账本。

---

## 8. 工作量

| 阶段 | 内容 | 预估 |
|---|---|---|
| 1 | `webdav.rs`：配置、PROPFIND/PUT/GET/MOVE、测试服务器 | 1 天 |
| 2 | 配置表、凭据库、Tauri commands、错误映射 | 0.5–1 天 |
| 3 | 桌面 UI：设置区块、远端列表、上传/恢复流程 | 1 天 |
| 4 | 自动上传、保留策略、冲突提示、验收与文档 | 1 天 |
| 合计 | 生产可用 v1 | **3–4 天** |

---

## 9. 风险

1. **服务器差异**：PROPFIND 命名空间、`MOVE` 支持、URL 编码、自签证书。先支持坚果云/Nextcloud/群晖，其余按错误提示降级。
2. **Digest 认证**：部分旧 NAS 只支持 Digest。v1 明确只支持 Basic + HTTPS；如有需求再加 `digest_auth`。
3. **密码管理**：系统凭据库在 Linux 无 Secret Service 时可能不可用。需提供“仅本次会话”降级，并明确提示。
4. **多设备误用**：用户可能把快照恢复当成同步。必须在 UI 与文档中反复说明“整库替换”。

---

## 10. 如果要做真正的多设备同步（v2，另立方案）

事件溯源让增量同步可行，但**不要**同步 SQLite 文件：

- 每条事件已有稳定 `id`；新增 `device_id` 与全局 `occurred_at`。
- 远端按设备保存 `events/<device-id>.jsonl`，每行一个事件或一次修改/撤销。
- 拉取 = 读取所有设备的 jsonl，按 `id` 去重，按 `occurred_at + id` 稳定排序，重放整本账。
- 本地保存每台设备的 `last_seq` / 文件游标，避免重复拉取。
- 冲突：同一事件被两台设备修改时，保留两版并让用户选择；新事件天然不冲突。
- 成本、持仓、报表全部由重放得出，不需要合并“计算结果”。
- 代价：需要重新审视 `seq` 的口径（当前是账户内顺序），并处理删除/撤销的因果顺序。

这是比快照备份大一个数量级的工程，建议在 v1 稳定、手机端确实需要同时写入后再启动。

---

## 11. v1 实现记录（2026-11-12）

### 已落地

| 项 | 实现 |
|---|---|
| 传输模块 | `crates/wheel-app/src/webdav.rs`：PROPFIND Depth:1、PUT 临时名 + MOVE、GET、DELETE、`latest.json` 提交标记 |
| 凭据 | `crates/wheel-app/src/secrets.rs`：Windows 凭据管理器（`CRED_TYPE_GENERIC`，键 `wheel-tracker/webdav/<url>/<username>`）；凭据库不可用时仅保存在本次运行内存，UI 明确提示 |
| 配置 | 复用 `settings` 表键 `webdav.url / username / remoteDir / autoUpload / keep / encrypt / allowInsecureHttp`，以及 `lastUploadAt / lastUploadFile / lastError`；**不需要 schema v5** |
| 命令 | `webdav_get_settings / save_settings / test / list / backup_now / restore / stage_restore / delete / status` |
| 上传 | 手动上传先在本机生成 `wheel-*.sqlite[.enc]`，再上传；`MOVE` 返回 405/501 时回退为直接 PUT 最终文件名 |
| 恢复 | `webdav_restore` 下载到 `backups/download-<stamp>-<n>.sqlite[.enc]` 并校验，随后 `webdav_stage_restore` 复用 `restore::stage_with_password`；启动替换逻辑完全未改 |
| 自动上传 | `backup::run_if_due` 成功创建 `auto-*` 后，由后台线程在启动与每 30 分钟检查时上传；失败只记录状态并把本地快照记为待重试，下次启动自动重试，不影响本地备份 |
| 加密 | 手动上传可选 AES-256-GCM（密码不保存）；自动上传的加密密码只在本次运行内存中（手动上传一次后供自动任务复用），未提供时跳过并记录中文原因 |
| 保留 | 只清理远端 `auto-*` 且保留最近 `keep` 份；`wheel-*` 与 `pre-restore-*` 不自动删除 |
| 安全 | 仅 HTTPS；HTTP 仅 localhost/局域网且需显式勾选；同主机重定向上限 5 次；列表 2 MB、传输 512 MB 上限；连接 10 s、请求 30 s、传输 5 min；文件名白名单与目录 `..` 拒绝 |
| 测试 | `cargo test -p wheel-app --offline webdav`：PROPFIND 解析/过滤/排序、非 DAV 文档拒绝、路径与文件名注入、HTTPS/HTTP 策略、`latest.json`、上传/列出/下载/删除往返、MOVE 405 回退、远端保留策略；`secrets`：Windows 凭据管理器写入 / 读取 / 删除往返（测试键写入后立即清理） |

### 与设计的差异

1. `webdav_restore` 返回 `{ validation, localFile }` 而不是单独的 `BackupValidation`，因为暂存需要下载后的本地文件名；`webdav_stage_restore` 只接受 `download-` 前缀的本地文件。
2. 命令额外接受可选的 `serverPassword`（已保存凭据时留空），避免为了换服务器而先保存配置才能测试。
3. 未引入 schema v5 表，减少迁移面；设置键与 `settings` 的 KV 机制一致。
4. 未实现 Digest 认证、HEAD 后置大小校验和自动恢复；与 v1 非目标一致。

### 已知限制

- Linux/macOS 未接入 Secret Service / Keychain：当前降级为“仅本次运行”内存凭据，重启后需重新输入。
- 自动上传的加密密码无法跨重启保存（按设计不落库）；若加密开启且本次运行未手动上传过，自动上传会跳过并在面板显示原因。
- 恢复仍是整库替换；跨设备同时写入的冲突不会被合并，UI 与文档均明确提示。
