//! WebDAV snapshot backup (v1).
//!
//! The ledger engine is untouched: a local snapshot (plain SQLite or
//! `.sqlite.enc`) is uploaded to a user-configured WebDAV directory, listed back
//! with `PROPFIND`, downloaded into `backups/` and then restored through the
//! existing validate/stage/apply pipeline.
//!
//! Security notes:
//! - HTTPS is required; plain HTTP is only accepted for localhost/LAN hosts and
//!   only when the user explicitly opts in.
//! - Redirects are followed only to the same host.
//! - Passwords live in the OS credential store (see [`crate::secrets`]), never
//!   in SQLite.
//! - Remote names and URLs are validated; only files created by this app are
//!   listed, deleted or pruned.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use quick_xml::events::Event;
use quick_xml::Reader;
use reqwest::header::{HeaderName, HeaderValue, CONTENT_TYPE};
use reqwest::{Method, StatusCode, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::{backup, crypto, secrets, store, AppState};

pub const DEFAULT_REMOTE_DIR: &str = "/wheel/";
pub const MAX_TRANSFER_BYTES: u64 = 512 * 1024 * 1024;
const MAX_LIST_BYTES: usize = 2 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(300);
const MANIFEST_NAME: &str = "latest.json";
const PROPFIND_BODY: &str = concat!(
    "<?xml version=\"1.0\" encoding=\"utf-8\"?>",
    "<d:propfind xmlns:d=\"DAV:\"><d:prop>",
    "<d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/>",
    "</d:prop></d:propfind>"
);

const KEY_URL: &str = "webdav.url";
const KEY_USERNAME: &str = "webdav.username";
const KEY_REMOTE_DIR: &str = "webdav.remoteDir";
const KEY_AUTO_UPLOAD: &str = "webdav.autoUpload";
const KEY_KEEP: &str = "webdav.keep";
const KEY_ENCRYPT: &str = "webdav.encrypt";
const KEY_ALLOW_INSECURE: &str = "webdav.allowInsecureHttp";
const KEY_LAST_UPLOAD_AT: &str = "webdav.lastUploadAt";
const KEY_LAST_UPLOAD_FILE: &str = "webdav.lastUploadFile";
const KEY_LAST_ERROR: &str = "webdav.lastError";
const KEY_PENDING_UPLOAD: &str = "webdav.pendingUpload";
const MAX_ERROR_CHARS: usize = 500;

static BUSY: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct WebDavConfig {
    pub url: String,
    pub username: String,
    pub remote_dir: String,
    pub auto_upload: bool,
    pub keep: u32,
    pub encrypt: bool,
    pub allow_insecure_http: bool,
}

impl Default for WebDavConfig {
    fn default() -> Self {
        Self {
            url: String::new(),
            username: String::new(),
            remote_dir: DEFAULT_REMOTE_DIR.to_string(),
            auto_upload: true,
            keep: 10,
            encrypt: true,
            allow_insecure_http: false,
        }
    }
}

impl WebDavConfig {
    pub fn validate(&self) -> Result<()> {
        let raw = self.url.trim();
        if raw.is_empty() {
            bail!("请填写 WebDAV 服务器地址");
        }
        let url = Url::parse(raw).map_err(|_| {
            anyhow!("服务器地址格式无效，请填写完整 URL，例如 https://dav.jianguoyun.com/dav/")
        })?;
        match url.scheme() {
            "https" => {}
            "http" => {
                if !self.allow_insecure_http {
                    bail!("WebDAV 只允许 HTTPS；如需使用局域网 HTTP，请勾选“允许不安全连接”");
                }
                if !is_local_http_host(url.host_str().unwrap_or_default()) {
                    bail!("HTTP 仅允许 localhost 或局域网地址；公网地址必须使用 HTTPS");
                }
            }
            _ => bail!("服务器地址必须以 https:// 或 http:// 开头"),
        }
        if !url.username().is_empty() || url.password().is_some() {
            bail!("请不要把账号或密码写在服务器地址里");
        }
        if url.host_str().unwrap_or_default().is_empty() {
            bail!("服务器地址缺少主机名");
        }
        if url.query().is_some() || url.fragment().is_some() {
            bail!("服务器地址不能包含查询参数或锚点");
        }
        if self.username.trim().is_empty() {
            bail!("请填写 WebDAV 账号");
        }
        if !(1..=100).contains(&self.keep) {
            bail!("远端保留份数必须在 1 到 100 之间");
        }
        self.remote_segments()?;
        Ok(())
    }

    pub fn configured(&self) -> bool {
        !self.url.trim().is_empty() && !self.username.trim().is_empty()
    }

    fn remote_segments(&self) -> Result<Vec<String>> {
        normalize_remote_segments(&self.remote_dir)
    }

    fn url_for(&self, file_name: Option<&str>) -> Result<Url> {
        let mut url = Url::parse(self.url.trim()).map_err(|_| anyhow!("服务器地址格式无效"))?;
        let segments = self.remote_segments()?;
        {
            let mut path = url
                .path_segments_mut()
                .map_err(|_| anyhow!("服务器地址不能用作 WebDAV 目录基址"))?;
            path.pop_if_empty();
            for segment in &segments {
                path.push(segment);
            }
            match file_name {
                Some(name) => {
                    path.push(name);
                }
                None => {
                    path.push("");
                }
            }
        }
        Ok(url)
    }
}

/// Normalize the user-supplied remote directory into decoded path segments.
/// Percent-encoded dots are decoded before validation so `%2e%2e` cannot slip
/// through as a traversal.
pub fn normalize_remote_segments(raw: &str) -> Result<Vec<String>> {
    let mut segments = Vec::new();
    for raw_segment in raw.trim().split('/') {
        let segment =
            percent_decode(raw_segment).map_err(|_| anyhow!("远程目录包含无效的百分号编码"))?;
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            bail!("远程目录不能包含 ..");
        }
        if segment.contains('\\') || segment.contains(':') || segment.chars().any(char::is_control)
        {
            bail!("远程目录包含无效字符（不能包含反斜杠、冒号或控制字符）");
        }
        if segment.len() > 120 {
            bail!("远程目录的单个层级不能超过 120 个字符");
        }
        segments.push(segment);
    }
    Ok(segments)
}

pub fn display_remote_dir(segments: &[String]) -> String {
    if segments.is_empty() {
        "/".to_string()
    } else {
        format!("/{}/", segments.join("/"))
    }
}

fn is_local_http_host(host: &str) -> bool {
    let host = host.trim().trim_matches(['[', ']']).to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
        return true;
    }
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(address)) => {
            address.is_loopback() || address.is_private() || address.is_link_local()
        }
        Ok(std::net::IpAddr::V6(address)) => {
            address.is_loopback() || address.is_unique_local() || address.is_unicast_link_local()
        }
        Err(_) => false,
    }
}

fn percent_decode(input: &str) -> Result<String> {
    let bytes = input.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                bail!("truncated percent escape");
            }
            let high = hex_value(bytes[index + 1]).ok_or_else(|| anyhow!("bad escape"))?;
            let low = hex_value(bytes[index + 2]).ok_or_else(|| anyhow!("bad escape"))?;
            output.push(high * 16 + low);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output).map_err(|_| anyhow!("percent escape is not UTF-8"))
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Remote names this app is willing to list, download or delete.
pub fn is_app_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && (name.starts_with("wheel-") || name.starts_with("auto-"))
        && (name.ends_with(".sqlite") || name.ends_with(".sqlite.enc"))
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains(':')
        && !name.contains("..")
        && name.bytes().all(|byte| byte.is_ascii_graphic())
}

fn validate_remote_name(name: &str) -> Result<()> {
    if !is_app_file_name(name) {
        bail!("无效的远程备份文件名");
    }
    Ok(())
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| OffsetDateTime::now_utc().to_string())
}

fn timestamp_iso(timestamp: std::time::SystemTime) -> String {
    OffsetDateTime::from(timestamp)
        .format(&Rfc3339)
        .unwrap_or_else(|_| OffsetDateTime::from(timestamp).to_string())
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBackup {
    pub file_name: String,
    pub size_bytes: u64,
    pub modified_at: Option<String>,
    pub etag: Option<String>,
    pub encrypted: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub server: Option<String>,
    pub snapshot_count: usize,
    pub writable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadOutcome {
    pub remote: RemoteBackup,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavSettingsView {
    #[serde(flatten)]
    pub config: WebDavConfig,
    pub configured: bool,
    pub has_password: bool,
    pub password_source: String,
    pub password_hint: String,
    pub last_upload_at: Option<String>,
    pub last_upload_file: Option<String>,
    pub last_error: Option<String>,
    pub auto_upload_ready: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavStatus {
    pub configured: bool,
    pub has_password: bool,
    pub password_source: String,
    pub last_upload_at: Option<String>,
    pub last_upload_file: Option<String>,
    pub last_error: Option<String>,
    pub auto_upload_ready: bool,
    pub busy: bool,
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

fn setting_bool(conn: &rusqlite::Connection, key: &str, fallback: bool) -> Result<bool> {
    Ok(match store::get_setting_value(conn, key)? {
        Some(value) => match value.as_str() {
            "true" => true,
            "false" => false,
            _ => bail!("已保存的 WebDAV 设置无效：{key}={value}"),
        },
        None => fallback,
    })
}

pub fn load(conn: &rusqlite::Connection) -> Result<WebDavConfig> {
    let defaults = WebDavConfig::default();
    let remote_dir =
        store::get_setting_value(conn, KEY_REMOTE_DIR)?.unwrap_or(defaults.remote_dir);
    let keep = match store::get_setting_value(conn, KEY_KEEP)? {
        Some(value) => value
            .parse::<u32>()
            .with_context(|| format!("已保存的 WebDAV 保留份数无效：{value}"))?,
        None => defaults.keep,
    };
    Ok(WebDavConfig {
        url: store::get_setting_value(conn, KEY_URL)?.unwrap_or_default(),
        username: store::get_setting_value(conn, KEY_USERNAME)?.unwrap_or_default(),
        remote_dir,
        auto_upload: setting_bool(conn, KEY_AUTO_UPLOAD, defaults.auto_upload)?,
        keep,
        encrypt: setting_bool(conn, KEY_ENCRYPT, defaults.encrypt)?,
        allow_insecure_http: setting_bool(conn, KEY_ALLOW_INSECURE, defaults.allow_insecure_http)?,
    })
}

pub fn save(conn: &rusqlite::Connection, config: &WebDavConfig) -> Result<WebDavConfig> {
    config.validate()?;
    let normalized = display_remote_dir(&config.remote_segments()?);
    store::set_setting_value(conn, KEY_URL, config.url.trim())?;
    store::set_setting_value(conn, KEY_USERNAME, config.username.trim())?;
    store::set_setting_value(conn, KEY_REMOTE_DIR, &normalized)?;
    store::set_setting_value(conn, KEY_AUTO_UPLOAD, bool_str(config.auto_upload))?;
    store::set_setting_value(conn, KEY_KEEP, &config.keep.to_string())?;
    store::set_setting_value(conn, KEY_ENCRYPT, bool_str(config.encrypt))?;
    store::set_setting_value(conn, KEY_ALLOW_INSECURE, bool_str(config.allow_insecure_http))?;
    let mut saved = config.clone();
    saved.url = config.url.trim().to_string();
    saved.username = config.username.trim().to_string();
    saved.remote_dir = normalized;
    Ok(saved)
}

fn bool_str(value: bool) -> &'static str {
    if value {
        "true"
    } else {
        "false"
    }
}

pub fn stored_password(config: &WebDavConfig) -> Option<(String, secrets::Source)> {
    if !config.configured() {
        return None;
    }
    secrets::get(&secrets::target(&config.url, &config.username))
}

pub fn store_password(config: &WebDavConfig, password: &str) -> secrets::Source {
    secrets::store(
        &secrets::target(&config.url, &config.username),
        &config.username,
        password,
    )
}

/// Remove the credential for a previous URL/account pair.
pub fn forget_password(config: &WebDavConfig) {
    if config.configured() {
        secrets::delete(&secrets::target(&config.url, &config.username));
    }
}

pub fn resolve_password(config: &WebDavConfig, supplied: Option<String>) -> Result<String> {
    if let Some(password) = supplied.filter(|value| !value.is_empty()) {
        return Ok(password);
    }
    stored_password(config)
        .map(|(password, _)| password)
        .ok_or_else(|| anyhow!("请输入 WebDAV 应用密码（密码不会写入账本）"))
}

pub fn password_hint(password: &str) -> String {
    let count = password.chars().count();
    if count <= 4 {
        "••••".to_string()
    } else {
        let tail: String = password.chars().skip(count - 4).collect();
        format!("••••{tail}")
    }
}

fn auto_ready(config: &WebDavConfig, has_password: bool) -> bool {
    config.auto_upload
        && config.configured()
        && has_password
        && (!config.encrypt || backup_password().is_some())
}

pub fn status(conn: &rusqlite::Connection, config: &WebDavConfig) -> Result<WebDavStatus> {
    let stored = stored_password(config);
    Ok(WebDavStatus {
        configured: config.configured(),
        has_password: stored.is_some(),
        password_source: stored
            .as_ref()
            .map(|(_, source)| source.as_str().to_string())
            .unwrap_or_else(|| "none".to_string()),
        last_upload_at: store::get_setting_value(conn, KEY_LAST_UPLOAD_AT)?,
        last_upload_file: store::get_setting_value(conn, KEY_LAST_UPLOAD_FILE)?,
        last_error: store::get_setting_value(conn, KEY_LAST_ERROR)?,
        auto_upload_ready: auto_ready(config, stored.is_some()),
        busy: BUSY.load(Ordering::Relaxed),
    })
}

pub fn settings_view(
    conn: &rusqlite::Connection,
    config: &WebDavConfig,
) -> Result<WebDavSettingsView> {
    let stored = stored_password(config);
    Ok(WebDavSettingsView {
        configured: config.configured(),
        has_password: stored.is_some(),
        password_source: stored
            .as_ref()
            .map(|(_, source)| source.as_str().to_string())
            .unwrap_or_else(|| "none".to_string()),
        password_hint: stored
            .as_ref()
            .map(|(password, _)| password_hint(password))
            .unwrap_or_default(),
        last_upload_at: store::get_setting_value(conn, KEY_LAST_UPLOAD_AT)?,
        last_upload_file: store::get_setting_value(conn, KEY_LAST_UPLOAD_FILE)?,
        last_error: store::get_setting_value(conn, KEY_LAST_ERROR)?,
        auto_upload_ready: auto_ready(config, stored.is_some()),
        config: config.clone(),
    })
}

pub fn record_upload_success(conn: &rusqlite::Connection, file_name: &str) -> Result<()> {
    let at = now_iso();
    store::set_setting_value(conn, KEY_LAST_UPLOAD_AT, &at)?;
    store::set_setting_value(conn, KEY_LAST_UPLOAD_FILE, file_name)?;
    store::set_setting_value(conn, KEY_LAST_ERROR, "")?;
    Ok(())
}

pub fn record_error(conn: &rusqlite::Connection, message: &str) -> Result<()> {
    let mut text: String = message.chars().take(MAX_ERROR_CHARS).collect();
    if text.is_empty() {
        text = "未知错误".to_string();
    }
    store::set_setting_value(conn, KEY_LAST_ERROR, &text)
}

/// Remember which local snapshot still needs uploading; the next launch tries
/// again without creating a second snapshot.
pub fn record_pending_upload(conn: &rusqlite::Connection, path: &Path) -> Result<()> {
    store::set_setting_value(conn, KEY_PENDING_UPLOAD, &path.to_string_lossy())
}

pub fn clear_pending_upload(conn: &rusqlite::Connection) -> Result<()> {
    store::set_setting_value(conn, KEY_PENDING_UPLOAD, "")
}

// ---------------------------------------------------------------------------
// Session-only backup encryption password
// ---------------------------------------------------------------------------

fn backup_password_cell() -> &'static Mutex<Option<String>> {
    static CELL: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(None))
}

/// Remember the snapshot encryption password for automatic uploads. It is kept
/// in memory only: a lost password must never be recoverable from the app.
pub fn remember_backup_password(password: Option<&str>) {
    let mut cell = backup_password_cell()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *cell = password
        .filter(|value| !value.is_empty())
        .map(str::to_string);
}

pub fn backup_password() -> Option<String> {
    backup_password_cell()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

fn propfind_method() -> Method {
    Method::from_bytes(b"PROPFIND").expect("PROPFIND is a valid method")
}

fn move_method() -> Method {
    Method::from_bytes(b"MOVE").expect("MOVE is a valid method")
}

fn destination_header() -> HeaderName {
    HeaderName::from_static("destination")
}

fn overwrite_header() -> HeaderName {
    HeaderName::from_static("overwrite")
}

fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .user_agent(format!("WheelTracker/{}", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let original = attempt.previous().first().and_then(Url::host_str);
            let same_host = original == attempt.url().host_str();
            if same_host && attempt.previous().len() < 5 {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .context("无法初始化 WebDAV 网络连接")
}

fn status_error(status: StatusCode, action: &str) -> anyhow::Error {
    let code = status.as_u16();
    let reason = match code {
        400 => "服务器拒绝了请求格式",
        401 => "账号或应用密码错误",
        403 => "服务器拒绝访问，请检查目录权限",
        404 => "远程目录或快照不存在",
        405 | 501 => "服务器不支持该 WebDAV 操作",
        409 => "远程目录不存在或存在冲突",
        423 => "文件被服务器锁定",
        507 => "云端空间不足",
        500..=599 => "WebDAV 服务器内部错误",
        _ => "WebDAV 请求失败",
    };
    anyhow!("{action}失败（HTTP {code}）：{reason}")
}

fn network_error(action: &str, error: reqwest::Error) -> anyhow::Error {
    if error.is_timeout() {
        return anyhow!("{action}超时：服务器响应过慢或网络不可达，请稍后重试");
    }
    if error.is_redirect() {
        return anyhow!("{action}失败：服务器重定向到了其他主机，出于安全原因已拒绝");
    }
    if error.is_connect() {
        let text = error.to_string();
        let lower = text.to_ascii_lowercase();
        if lower.contains("certificate") || lower.contains("tls") || lower.contains("handshake") {
            return anyhow!(
                "{action}失败：HTTPS 证书校验失败。请检查服务器证书是否有效，或改用受信任的地址"
            );
        }
        return anyhow!("{action}失败：无法连接服务器（{text}）");
    }
    anyhow!("{action}失败：{error}")
}

async fn propfind(
    client: &reqwest::Client,
    config: &WebDavConfig,
    password: &str,
) -> Result<(String, Option<String>)> {
    let url = config.url_for(None)?;
    let response = client
        .request(propfind_method(), url)
        .basic_auth(&config.username, Some(password))
        .header("depth", "1")
        .header(CONTENT_TYPE, "application/xml; charset=utf-8")
        .body(PROPFIND_BODY)
        .send()
        .await
        .map_err(|error| network_error("列出远程快照", error))?;
    let status = response.status();
    if status != StatusCode::MULTI_STATUS {
        return Err(status_error(status, "列出远程目录"));
    }
    if let Some(length) = response.content_length() {
        if length > MAX_LIST_BYTES as u64 {
            bail!("WebDAV 目录列表过大（{length} 字节），已拒绝解析");
        }
    }
    let server = response
        .headers()
        .get("server")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let bytes = response
        .bytes()
        .await
        .map_err(|error| network_error("读取远程目录列表", error))?;
    if bytes.len() > MAX_LIST_BYTES {
        bail!("WebDAV 目录列表过大，已拒绝解析");
    }
    Ok((String::from_utf8_lossy(&bytes).into_owned(), server))
}

async fn remote_list(
    client: &reqwest::Client,
    config: &WebDavConfig,
    password: &str,
) -> Result<Vec<RemoteBackup>> {
    let (xml, _) = propfind(client, config, password).await?;
    parse_multistatus(&xml)
}

pub async fn test(config: &WebDavConfig, password: &str) -> Result<ServerInfo> {
    config.validate()?;
    let client = client()?;
    let (xml, server) = propfind(&client, config, password).await?;
    let entries = parse_multistatus(&xml)?;
    let writable = probe_write(&client, config, password).await.is_ok();
    Ok(ServerInfo {
        server,
        snapshot_count: entries.len(),
        writable,
    })
}

async fn probe_write(
    client: &reqwest::Client,
    config: &WebDavConfig,
    password: &str,
) -> Result<()> {
    let probe = format!(
        ".wheel-probe-{}",
        OffsetDateTime::now_utc().unix_timestamp_nanos()
    );
    let url = config.url_for(Some(&probe))?;
    let response = client
        .put(url.clone())
        .basic_auth(&config.username, Some(password))
        .body("wheel-tracker")
        .send()
        .await
        .map_err(|error| network_error("测试目录写入", error))?;
    if !response.status().is_success() {
        return Err(status_error(response.status(), "测试目录写入"));
    }
    let _ = client
        .delete(url)
        .basic_auth(&config.username, Some(password))
        .send()
        .await;
    Ok(())
}

pub async fn list(config: &WebDavConfig, password: &str) -> Result<Vec<RemoteBackup>> {
    config.validate()?;
    let client = client()?;
    remote_list(&client, config, password).await
}

pub async fn delete(config: &WebDavConfig, password: &str, file_name: &str) -> Result<()> {
    config.validate()?;
    validate_remote_name(file_name)?;
    let client = client()?;
    delete_entry(&client, config, password, file_name).await
}

async fn delete_entry(
    client: &reqwest::Client,
    config: &WebDavConfig,
    password: &str,
    file_name: &str,
) -> Result<()> {
    let url = config.url_for(Some(file_name))?;
    let response = client
        .delete(url)
        .basic_auth(&config.username, Some(password))
        .send()
        .await
        .map_err(|error| network_error("删除远程快照", error))?;
    match response.status() {
        status if status.is_success() => Ok(()),
        // Already gone is the outcome the caller wanted.
        StatusCode::NOT_FOUND => Ok(()),
        status => Err(status_error(status, "删除远程快照")),
    }
}

/// Upload, write the `latest.json` commit marker and apply remote retention.
/// `encrypt_with` encrypts a plain snapshot on the fly for automatic uploads.
pub async fn publish(
    config: &WebDavConfig,
    password: &str,
    local: &Path,
    encrypt_with: Option<&str>,
) -> Result<UploadOutcome> {
    config.validate()?;
    let client = client()?;
    let outcome = upload_snapshot(&client, config, password, local, encrypt_with).await?;
    write_manifest(&client, config, password, &outcome).await?;
    if let Err(error) = prune_remote(&client, config, password, config.keep).await {
        // The snapshot is safely uploaded; retention can be retried later.
        eprintln!("remote snapshot retention failed: {error:#}");
    }
    Ok(outcome)
}

async fn upload_snapshot(
    client: &reqwest::Client,
    config: &WebDavConfig,
    password: &str,
    local: &Path,
    encrypt_with: Option<&str>,
) -> Result<UploadOutcome> {
    let file_name = local
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| anyhow!("本地快照缺少文件名"))?;
    if !file_name.ends_with(".sqlite") && !file_name.ends_with(".sqlite.enc") {
        bail!("只能上传 SQLite 快照文件");
    }
    let metadata = std::fs::metadata(local)
        .with_context(|| format!("无法读取本地快照 {}", local.display()))?;
    if metadata.len() > MAX_TRANSFER_BYTES {
        bail!("本地快照超过 512 MB，已拒绝上传");
    }
    let plaintext =
        std::fs::read(local).with_context(|| format!("无法读取本地快照 {}", local.display()))?;
    let (remote_name, payload, encrypted) = match encrypt_with {
        Some(secret) => {
            if file_name.ends_with(".enc") {
                bail!("快照已经是加密文件，不能再次加密");
            }
            let payload = crypto::encrypt(&plaintext, secret)?;
            (format!("{file_name}.enc"), payload, true)
        }
        None => (
            file_name.clone(),
            plaintext,
            file_name.ends_with(".sqlite.enc"),
        ),
    };
    validate_remote_name(&remote_name)?;
    let sha256 = sha256_hex(&payload);
    let size_bytes = payload.len() as u64;

    let final_url = config.url_for(Some(&remote_name))?;
    let temp_name = format!("{remote_name}.tmp");
    let temp_url = config.url_for(Some(&temp_name))?;
    let response = client
        .put(temp_url.clone())
        .basic_auth(&config.username, Some(password))
        .header(CONTENT_TYPE, "application/octet-stream")
        .timeout(TRANSFER_TIMEOUT)
        .body(payload.clone())
        .send()
        .await
        .map_err(|error| network_error("上传远程快照", error))?;
    if !response.status().is_success() {
        return Err(status_error(response.status(), "上传远程快照"));
    }

    let destination = HeaderValue::from_str(final_url.as_str())
        .map_err(|_| anyhow!("远程快照地址无法写入 MOVE 请求头"))?;
    let moved = client
        .request(move_method(), temp_url.clone())
        .basic_auth(&config.username, Some(password))
        .header(destination_header(), destination)
        .header(overwrite_header(), "T")
        .timeout(TRANSFER_TIMEOUT)
        .send()
        .await;
    match moved {
        Ok(response) if response.status().is_success() => {}
        // Some servers do not implement MOVE on files; upload straight to the
        // final name instead and try to clean up the temporary object.
        Ok(response) if matches!(response.status().as_u16(), 405 | 501) => {
            let retry = client
                .put(final_url)
                .basic_auth(&config.username, Some(password))
                .header(CONTENT_TYPE, "application/octet-stream")
                .timeout(TRANSFER_TIMEOUT)
                .body(payload.clone())
                .send()
                .await
                .map_err(|error| network_error("上传远程快照", error))?;
            if !retry.status().is_success() {
                return Err(status_error(retry.status(), "上传远程快照"));
            }
            let _ = client
                .delete(temp_url)
                .basic_auth(&config.username, Some(password))
                .send()
                .await;
        }
        Ok(response) => return Err(status_error(response.status(), "重命名远程快照")),
        Err(error) => {
            let _ = client
                .delete(temp_url)
                .basic_auth(&config.username, Some(password))
                .send()
                .await;
            return Err(network_error("重命名远程快照", error));
        }
    }

    Ok(UploadOutcome {
        remote: RemoteBackup {
            file_name: remote_name,
            size_bytes,
            modified_at: Some(now_iso()),
            etag: None,
            encrypted,
        },
        sha256,
    })
}

pub async fn download(
    config: &WebDavConfig,
    password: &str,
    file_name: &str,
    target: &Path,
) -> Result<u64> {
    config.validate()?;
    validate_remote_name(file_name)?;
    let client = client()?;
    let url = config.url_for(Some(file_name))?;
    let mut response = client
        .get(url)
        .basic_auth(&config.username, Some(password))
        .timeout(TRANSFER_TIMEOUT)
        .send()
        .await
        .map_err(|error| network_error("下载远程快照", error))?;
    if !response.status().is_success() {
        return Err(status_error(response.status(), "下载远程快照"));
    }
    if let Some(length) = response.content_length() {
        if length > MAX_TRANSFER_BYTES {
            bail!("远程快照超过 512 MB，已拒绝下载");
        }
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let part = target.with_file_name(format!(
        ".{}.part",
        target
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "wheel-download".to_string())
    ));
    let mut file =
        std::fs::File::create(&part).with_context(|| format!("无法写入 {}", part.display()))?;
    let mut total: u64 = 0;
    loop {
        let chunk = response
            .chunk()
            .await
            .map_err(|error| network_error("下载远程快照", error))?;
        let Some(chunk) = chunk else { break };
        total += chunk.len() as u64;
        if total > MAX_TRANSFER_BYTES {
            drop(file);
            let _ = std::fs::remove_file(&part);
            bail!("远程快照超过 512 MB，已中止下载");
        }
        file.write_all(&chunk)
            .with_context(|| format!("无法写入 {}", part.display()))?;
    }
    file.flush()?;
    drop(file);
    if target.exists() {
        let _ = std::fs::remove_file(target);
    }
    std::fs::rename(&part, target)
        .with_context(|| format!("无法完成下载 {}", target.display()))?;
    Ok(total)
}

async fn prune_remote(
    client: &reqwest::Client,
    config: &WebDavConfig,
    password: &str,
    keep: u32,
) -> Result<usize> {
    let entries = remote_list(client, config, password).await?;
    let mut automatic: Vec<RemoteBackup> = entries
        .into_iter()
        .filter(|entry| entry.file_name.starts_with("auto-"))
        .collect();
    automatic.sort_by(|left, right| {
        right
            .modified_at
            .cmp(&left.modified_at)
            .then_with(|| remote_stamp(&right.file_name).cmp(&remote_stamp(&left.file_name)))
            .then_with(|| right.file_name.cmp(&left.file_name))
    });
    let keep = keep.max(1) as usize;
    let mut removed = 0usize;
    for entry in automatic.into_iter().skip(keep) {
        match delete_entry(client, config, password, &entry.file_name).await {
            Ok(()) => removed += 1,
            Err(error) => eprintln!("cannot delete remote snapshot: {error:#}"),
        }
    }
    Ok(removed)
}

fn remote_stamp(name: &str) -> Option<i128> {
    let rest = name
        .strip_prefix("wheel-")
        .or_else(|| name.strip_prefix("auto-"))?;
    let rest = rest
        .strip_suffix(".sqlite.enc")
        .or_else(|| rest.strip_suffix(".sqlite"))?;
    let (stamp, suffix) = rest.split_once('-')?;
    if suffix.is_empty() || !suffix.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    stamp.parse::<i128>().ok()
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

// ---------------------------------------------------------------------------
// PROPFIND parsing
// ---------------------------------------------------------------------------

#[derive(Default)]
struct PendingEntry {
    href: String,
    size: Option<u64>,
    modified: Option<String>,
    etag: Option<String>,
    collection: bool,
}

fn local_name(name: quick_xml::name::QName<'_>) -> String {
    name.local_name().into_inner().to_ascii_lowercase()
}

pub fn parse_multistatus(xml: &str) -> Result<Vec<RemoteBackup>> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut pending: Option<PendingEntry> = None;
    let mut stack: Vec<String> = Vec::new();
    let mut text = String::new();
    let mut saw_root = false;
    let mut entries: Vec<RemoteBackup> = Vec::new();
    loop {
        let event = reader
            .read_event()
            .map_err(|error| anyhow!("WebDAV 目录列表 XML 解析失败：{error}"))?;
        match event {
            Event::Start(element) => {
                let name = local_name(element.name());
                if !saw_root {
                    saw_root = true;
                    if name != "multistatus" {
                        bail!("服务器返回的不是 WebDAV 目录列表（缺少 multistatus）");
                    }
                    continue;
                }
                if name == "response" {
                    pending = Some(PendingEntry::default());
                    stack.clear();
                    text.clear();
                } else if pending.is_some() {
                    if name == "collection" {
                        if let Some(entry) = pending.as_mut() {
                            entry.collection = true;
                        }
                    }
                    stack.push(name);
                    text.clear();
                }
            }
            Event::Empty(element) => {
                let name = local_name(element.name());
                if pending.is_some() && name == "collection" {
                    if let Some(entry) = pending.as_mut() {
                        entry.collection = true;
                    }
                }
            }
            Event::Text(value) => {
                if pending.is_some() && !stack.is_empty() {
                    text.push_str(&value.into_inner());
                }
            }
            Event::CData(value) => {
                if pending.is_some() && !stack.is_empty() {
                    text.push_str(&value.into_inner());
                }
            }
            Event::GeneralRef(reference) => {
                if pending.is_some() && !stack.is_empty() {
                    match reference.resolve_char_ref() {
                        Ok(Some(character)) => text.push(character),
                        _ => match reference.as_ref() {
                            "amp" => text.push('&'),
                            "lt" => text.push('<'),
                            "gt" => text.push('>'),
                            "quot" => text.push('"'),
                            "apos" => text.push('\''),
                            _ => {}
                        },
                    }
                }
            }
            Event::End(element) => {
                let name = local_name(element.name());
                if name == "response" {
                    if let Some(entry) = pending.take() {
                        if let Some(remote) = finish_entry(entry)? {
                            entries.push(remote);
                        }
                    }
                    stack.clear();
                    text.clear();
                } else if pending.is_some() {
                    if let Some(entry) = pending.as_mut() {
                        apply_field(entry, &name, text.trim());
                    }
                    text.clear();
                    stack.pop();
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if !saw_root {
        bail!("服务器返回了空的 WebDAV 目录列表");
    }
    entries.sort_by(|left, right| {
        right
            .modified_at
            .cmp(&left.modified_at)
            .then_with(|| remote_stamp(&right.file_name).cmp(&remote_stamp(&left.file_name)))
            .then_with(|| right.file_name.cmp(&left.file_name))
    });
    Ok(entries)
}

fn apply_field(entry: &mut PendingEntry, name: &str, value: &str) {
    match name {
        "href" if entry.href.is_empty() => entry.href = value.to_string(),
        "getcontentlength" => entry.size = value.parse::<u64>().ok(),
        "getlastmodified" if !value.is_empty() => entry.modified = Some(value.to_string()),
        "getetag" => entry.etag = Some(value.trim_matches('"').to_string()),
        _ => {}
    }
}

fn finish_entry(mut entry: PendingEntry) -> Result<Option<RemoteBackup>> {
    if entry.collection || entry.href.is_empty() {
        return Ok(None);
    }
    let path = entry.href.split(['?', '#']).next().unwrap_or_default();
    let raw_name = path.rsplit('/').next().unwrap_or_default();
    let file_name =
        percent_decode(raw_name).map_err(|_| anyhow!("远程目录返回了无法解码的文件名"))?;
    if !is_app_file_name(&file_name) {
        return Ok(None);
    }
    if let Some(modified) = entry.modified.as_deref() {
        if let Ok(timestamp) = httpdate::parse_http_date(modified) {
            entry.modified = Some(timestamp_iso(timestamp));
        }
    }
    Ok(Some(RemoteBackup {
        encrypted: file_name.ends_with(".sqlite.enc"),
        file_name,
        size_bytes: entry.size.unwrap_or(0),
        modified_at: entry.modified,
        etag: entry.etag.filter(|value| !value.is_empty()),
    }))
}

// ---------------------------------------------------------------------------
// Busy guard
// ---------------------------------------------------------------------------

pub fn begin() -> Result<()> {
    if BUSY
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        Ok(())
    } else {
        bail!("已有 WebDAV 任务在进行，请稍后再试")
    }
}

pub fn finish() {
    BUSY.store(false, Ordering::SeqCst);
}

// ---------------------------------------------------------------------------
// Automatic upload
// ---------------------------------------------------------------------------

/// Upload an automatic snapshot in the background after `run_if_due` created
/// it. Failures are recorded in settings and never touch the local backup.
pub fn spawn_auto_upload(app: tauri::AppHandle, snapshot: PathBuf) {
    use tauri::Manager;

    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let (config, password) = {
            let conn = state.conn();
            let config = match load(&conn) {
                Ok(config) => config,
                Err(error) => {
                    let _ = record_error(&conn, &format!("{error:#}"));
                    return;
                }
            };
            if !config.auto_upload || !config.configured() {
                return;
            }
            let Some((password, _)) = stored_password(&config) else {
                let _ = record_error(&conn, "自动上传已跳过：未找到已保存的 WebDAV 密码");
                return;
            };
            (config, password)
        };

        let encrypt_with = match encryption_password_for(&config) {
            Ok(value) => value,
            Err(error) => {
                let conn = state.conn();
                let _ = record_error(&conn, &format!("{error:#}"));
                return;
            }
        };

        if begin().is_err() {
            return;
        }
        let result = tauri::async_runtime::block_on(publish(
            &config,
            &password,
            &snapshot,
            encrypt_with.as_deref(),
        ));
        finish();
        let conn = state.conn();
        match result {
            Ok(outcome) => {
                let _ = clear_pending_upload(&conn);
                let _ = record_upload_success(&conn, &outcome.remote.file_name);
            }
            Err(error) => {
                // Retry this exact snapshot on the next launch.
                let _ = record_pending_upload(&conn, &snapshot);
                let _ = record_error(&conn, &format!("{error:#}"));
            }
        }
    });
}

fn encryption_password_for(config: &WebDavConfig) -> Result<Option<String>> {
    if !config.encrypt {
        return Ok(None);
    }
    backup_password().map(Some).ok_or_else(|| {
        anyhow!(
            "自动上传已跳过：加密上传已开启，但本次运行尚未提供备份密码。请在 WebDAV 面板执行一次手动备份。"
        )
    })
}

/// Retry the snapshot recorded by a failed automatic or manual upload. Runs in
/// the background at launch; a missing file or disabled auto-upload clears the
/// pending marker instead of retrying forever.
pub fn spawn_retry_upload(app: tauri::AppHandle) {
    use tauri::Manager;

    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let (config, password, pending, encrypt_with) = {
            let conn = state.conn();
            let config = match load(&conn) {
                Ok(config) => config,
                Err(_) => return,
            };
            if !config.auto_upload || !config.configured() {
                return;
            }
            let Some(pending) = store::get_setting_value(&conn, KEY_PENDING_UPLOAD)
                .ok()
                .flatten()
                .filter(|value| !value.trim().is_empty())
            else {
                return;
            };
            let path = PathBuf::from(pending);
            let expected_directory = backup::dir_for(Path::new(&state.db_path)).ok();
            let safe_name = path
                .file_name()
                .and_then(|name| name.to_str())
                .map(backup::is_safe_file_name)
                .unwrap_or(false);
            if !safe_name || expected_directory.as_deref() != path.parent() || !path.is_file() {
                let _ = clear_pending_upload(&conn);
                return;
            }
            let Some((password, _)) = stored_password(&config) else {
                return;
            };
            let encrypt_with = if path.to_string_lossy().ends_with(".enc") {
                None
            } else {
                match encryption_password_for(&config) {
                    Ok(value) => value,
                    Err(_) => return,
                }
            };
            (config, password, path, encrypt_with)
        };

        if begin().is_err() {
            return;
        }
        let result = tauri::async_runtime::block_on(publish(
            &config,
            &password,
            &pending,
            encrypt_with.as_deref(),
        ));
        finish();
        let conn = state.conn();
        match result {
            Ok(outcome) => {
                let _ = clear_pending_upload(&conn);
                let _ = record_upload_success(&conn, &outcome.remote.file_name);
            }
            Err(error) => {
                let _ = record_error(&conn, &format!("{error:#}"));
            }
        }
    });
}

pub fn manifest_json(outcome: &UploadOutcome) -> Result<String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Manifest<'a> {
        version: u32,
        file: &'a str,
        created_at: String,
        size: u64,
        sha256: &'a str,
        encrypted: bool,
        schema: i64,
        app_version: &'a str,
        device: String,
    }
    let manifest = Manifest {
        version: 1,
        file: &outcome.remote.file_name,
        created_at: now_iso(),
        size: outcome.remote.size_bytes,
        sha256: &outcome.sha256,
        encrypted: outcome.remote.encrypted,
        schema: store::SCHEMA_VERSION,
        app_version: env!("CARGO_PKG_VERSION"),
        device: format!("{}-desktop", std::env::consts::OS),
    };
    serde_json::to_string_pretty(&manifest).context("无法生成 latest.json")
}

async fn write_manifest(
    client: &reqwest::Client,
    config: &WebDavConfig,
    password: &str,
    outcome: &UploadOutcome,
) -> Result<()> {
    let body = manifest_json(outcome)?;
    let url = config.url_for(Some(MANIFEST_NAME))?;
    let response = client
        .put(url)
        .basic_auth(&config.username, Some(password))
        .header(CONTENT_TYPE, "application/json; charset=utf-8")
        .body(body)
        .send()
        .await
        .map_err(|error| network_error("写入 latest.json", error))?;
    if !response.status().is_success() {
        return Err(status_error(response.status(), "写入 latest.json"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::Arc;

    #[test]
    fn propfind_parses_filters_and_sorts_remote_snapshots() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/wheel/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/wheel/wheel-1762903800-0.sqlite.enc</D:href>
    <D:propstat><D:prop>
      <D:resourcetype/><D:getcontentlength>2411724</D:getcontentlength>
      <D:getlastmodified>Thu, 12 Nov 2026 08:30:00 GMT</D:getlastmodified>
      <D:getetag>"abc123"</D:getetag>
    </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/wheel/wheel-1762903900-2.sqlite</D:href>
    <D:propstat><D:prop>
      <D:resourcetype/><D:getcontentlength>1024</D:getcontentlength>
      <D:getlastmodified>Thu, 12 Nov 2026 08:30:00 GMT</D:getlastmodified>
      <D:getetag>no-quotes</D:getetag>
    </D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/wheel/auto-1762817400-1.sqlite</D:href>
    <D:propstat><D:prop>
      <D:resourcetype/><D:getcontentlength>2048</D:getcontentlength>
      <D:getlastmodified>Wed, 11 Nov 2026 08:30:00 GMT</D:getlastmodified>
    </D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/wheel/other.sqlite</D:href>
    <D:propstat><D:prop><D:getcontentlength>9</D:getcontentlength></D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/wheel/wheel-%E4%B8%AD%E6%96%87.sqlite</D:href>
    <D:propstat><D:prop><D:getcontentlength>9</D:getcontentlength></D:prop></D:propstat>
  </D:response>
</D:multistatus>"#;
        let list = parse_multistatus(xml).unwrap();
        let names: Vec<&str> = list.iter().map(|entry| entry.file_name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "wheel-1762903900-2.sqlite",
                "wheel-1762903800-0.sqlite.enc",
                "auto-1762817400-1.sqlite",
            ]
        );
        let encrypted = list
            .iter()
            .find(|entry| entry.file_name.ends_with(".enc"))
            .unwrap();
        assert!(encrypted.encrypted);
        assert_eq!(encrypted.size_bytes, 2_411_724);
        assert_eq!(encrypted.etag.as_deref(), Some("abc123"));
        assert_eq!(
            encrypted.modified_at.as_deref(),
            Some("2026-11-12T08:30:00Z")
        );
        assert_eq!(
            list.iter()
                .find(|entry| entry.file_name.ends_with("-2.sqlite"))
                .unwrap()
                .etag
                .as_deref(),
            Some("no-quotes")
        );
    }

    #[test]
    fn propfind_rejects_non_webdav_documents() {
        assert!(parse_multistatus("<html><body>not dav</body></html>").is_err());
        assert!(parse_multistatus("<D:multistatus xmlns:D=\"DAV:\"></D:multistatus>")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn remote_directories_and_names_are_hardened() {
        assert_eq!(normalize_remote_segments("/wheel/").unwrap(), vec!["wheel"]);
        assert_eq!(normalize_remote_segments("/").unwrap(), Vec::<String>::new());
        assert_eq!(
            normalize_remote_segments("/备份//轮子/").unwrap(),
            vec!["备份", "轮子"]
        );
        for bad in ["/../x/", "/%2e%2e/x/", "/a\\b/", "/a:b/", "/a\u{0}b/"] {
            assert!(normalize_remote_segments(bad).is_err(), "{bad} must fail");
        }
        assert!(is_app_file_name("wheel-1762903800-0.sqlite"));
        assert!(is_app_file_name("auto-1762903800-0.sqlite.enc"));
        for bad in [
            "pre-restore-1.sqlite",
            "other.sqlite",
            "wheel-../evil.sqlite",
            "wheel-1.sqlite/..",
            "wheel-中文.sqlite",
            "wheel-1.txt",
            "",
        ] {
            assert!(!is_app_file_name(bad), "{bad} must be rejected");
        }
    }

    #[test]
    fn config_requires_https_except_explicit_local_http() {
        let https = WebDavConfig {
            url: "https://dav.jianguoyun.com/dav/".into(),
            username: "me@example.com".into(),
            ..WebDavConfig::default()
        };
        assert!(https.validate().is_ok());

        let public_http = WebDavConfig {
            url: "http://example.com/dav/".into(),
            username: "me".into(),
            allow_insecure_http: true,
            ..WebDavConfig::default()
        };
        assert!(public_http
            .validate()
            .unwrap_err()
            .to_string()
            .contains("公网"));

        let local_http = WebDavConfig {
            url: "http://127.0.0.1:8080/dav/".into(),
            username: "me".into(),
            allow_insecure_http: true,
            ..WebDavConfig::default()
        };
        assert!(local_http.validate().is_ok());

        let local_without_flag = WebDavConfig {
            allow_insecure_http: false,
            ..local_http.clone()
        };
        assert!(local_without_flag
            .validate()
            .unwrap_err()
            .to_string()
            .contains("HTTPS"));

        let traversal = WebDavConfig {
            remote_dir: "/../secret/".into(),
            ..https.clone()
        };
        assert!(traversal.validate().is_err());
        let bad_keep = WebDavConfig {
            keep: 0,
            ..https.clone()
        };
        assert!(bad_keep.validate().is_err());
        let credentials_in_url = WebDavConfig {
            url: "https://user:pass@dav.example.com/dav/".into(),
            ..https
        };
        assert!(credentials_in_url.validate().is_err());
    }

    #[test]
    fn manifest_records_the_committed_snapshot() {
        let outcome = UploadOutcome {
            remote: RemoteBackup {
                file_name: "wheel-1762903800-0.sqlite.enc".into(),
                size_bytes: 2048,
                modified_at: Some(now_iso()),
                etag: None,
                encrypted: true,
            },
            sha256: "ab".repeat(32),
        };
        let value: serde_json::Value =
            serde_json::from_str(&manifest_json(&outcome).unwrap()).unwrap();
        assert_eq!(value["version"], 1);
        assert_eq!(value["file"], "wheel-1762903800-0.sqlite.enc");
        assert_eq!(value["encrypted"], true);
        assert_eq!(value["schema"], store::SCHEMA_VERSION);
        assert!(value["device"].as_str().unwrap().ends_with("-desktop"));
        assert_eq!(value["sha256"].as_str().unwrap().len(), 64);
    }

    struct MockServer {
        base: String,
        store: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    }

    impl MockServer {
        fn start() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let store = Arc::new(Mutex::new(HashMap::new()));
            let shared = store.clone();
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(stream) = stream else { continue };
                    let state = shared.clone();
                    std::thread::spawn(move || {
                        let _ = handle_request(stream, state);
                    });
                }
            });
            Self {
                base: format!("http://127.0.0.1:{port}/dav/"),
                store,
            }
        }

        fn contains(&self, path: &str) -> bool {
            self.store
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .contains_key(path)
        }
    }

    fn respond(
        stream: &mut TcpStream,
        status: u16,
        content_type: &str,
        body: &[u8],
    ) -> std::io::Result<()> {
        let head = format!(
            "HTTP/1.1 {status} X\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(head.as_bytes())?;
        stream.write_all(body)?;
        stream.flush()
    }

    fn propfind_xml(store: &Arc<Mutex<HashMap<String, Vec<u8>>>>, dir: &str) -> String {
        let mut xml = format!(
            "<?xml version=\"1.0\" encoding=\"utf-8\"?><D:multistatus xmlns:D=\"DAV:\">\
             <D:response><D:href>{dir}</D:href><D:propstat><D:prop><D:resourcetype>\
             <D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status>\
             </D:propstat></D:response>"
        );
        let map = store
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for (path, body) in map.iter() {
            if !path.starts_with(dir) {
                continue;
            }
            xml.push_str(&format!(
                "<D:response><D:href>{path}</D:href><D:propstat><D:prop>\
                 <D:resourcetype/><D:getcontentlength>{}</D:getcontentlength>\
                 <D:getlastmodified>Thu, 12 Nov 2026 08:30:00 GMT</D:getlastmodified>\
                 <D:getetag>\"tag\"</D:getetag></D:prop>\
                 <D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>",
                body.len()
            ));
        }
        xml.push_str("</D:multistatus>");
        xml
    }

    fn handle_request(
        mut stream: TcpStream,
        store: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    ) -> std::io::Result<()> {
        let mut reader = BufReader::new(stream.try_clone()?);
        let mut request_line = String::new();
        reader.read_line(&mut request_line)?;
        let mut parts = request_line.split_whitespace();
        let method = parts.next().unwrap_or_default().to_string();
        let target = parts.next().unwrap_or_default().to_string();
        let mut headers: HashMap<String, String> = HashMap::new();
        loop {
            let mut line = String::new();
            reader.read_line(&mut line)?;
            if line == "\r\n" || line == "\n" || line.is_empty() {
                break;
            }
            if let Some((name, value)) = line.split_once(':') {
                headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
            }
        }
        let length = headers
            .get("content-length")
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);
        let mut body = vec![0u8; length];
        reader.read_exact(&mut body)?;
        // tester:secret
        if headers.get("authorization").map(String::as_str)
            != Some("Basic dGVzdGVyOnNlY3JldA==")
        {
            return respond(&mut stream, 401, "text/plain", b"unauthorized");
        }
        let path = target.split('?').next().unwrap_or(&target).to_string();
        match method.as_str() {
            "PROPFIND" => {
                let xml = propfind_xml(&store, &path);
                respond(&mut stream, 207, "application/xml", xml.as_bytes())
            }
            "PUT" => {
                store
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .insert(path, body);
                respond(&mut stream, 201, "text/plain", b"created")
            }
            "MOVE" => {
                let destination = headers.get("destination").cloned().unwrap_or_default();
                let destination_path = Url::parse(&destination)
                    .map(|url| url.path().to_string())
                    .unwrap_or(destination);
                let mut map = store
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                match map.remove(&path) {
                    Some(value) => {
                        map.insert(destination_path, value);
                        respond(&mut stream, 201, "text/plain", b"moved")
                    }
                    None => respond(&mut stream, 404, "text/plain", b"missing"),
                }
            }
            "GET" => {
                let map = store
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                match map.get(&path) {
                    Some(value) => {
                        let value = value.clone();
                        drop(map);
                        respond(&mut stream, 200, "application/octet-stream", &value)
                    }
                    None => respond(&mut stream, 404, "text/plain", b"missing"),
                }
            }
            "DELETE" => {
                let removed = store
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .remove(&path)
                    .is_some();
                if removed {
                    respond(&mut stream, 204, "text/plain", b"")
                } else {
                    respond(&mut stream, 404, "text/plain", b"missing")
                }
            }
            _ => respond(&mut stream, 405, "text/plain", b"unsupported"),
        }
    }

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "wheel-webdav-{label}-{}-{}",
            std::process::id(),
            OffsetDateTime::now_utc().unix_timestamp_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[tokio::test]
    async fn upload_list_download_and_delete_round_trip() {
        // The developer machine may define a system proxy; keep loopback direct.
        std::env::set_var("NO_PROXY", "127.0.0.1,localhost");
        std::env::set_var("no_proxy", "127.0.0.1,localhost");

        let server = MockServer::start();
        let config = WebDavConfig {
            url: server.base.clone(),
            username: "tester".into(),
            remote_dir: "/wheel/".into(),
            auto_upload: false,
            keep: 10,
            encrypt: false,
            allow_insecure_http: true,
        };
        let directory = temp_dir("round-trip");
        let local = directory.join("wheel-1-0.sqlite");
        std::fs::write(&local, b"sqlite-bytes").unwrap();

        let outcome = publish(&config, "secret", &local, None).await.unwrap();
        assert_eq!(outcome.remote.file_name, "wheel-1-0.sqlite");
        assert!(!outcome.remote.encrypted);
        assert_eq!(outcome.remote.size_bytes, 12);
        assert!(server.contains("/dav/wheel/wheel-1-0.sqlite"));
        assert!(server.contains("/dav/wheel/latest.json"));

        let listed = list(&config, "secret").await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].file_name, "wheel-1-0.sqlite");

        let target = directory.join("downloaded.sqlite");
        let bytes = download(&config, "secret", "wheel-1-0.sqlite", &target)
            .await
            .unwrap();
        assert_eq!(bytes, 12);
        assert_eq!(std::fs::read(&target).unwrap(), b"sqlite-bytes");
        assert!(!target.with_file_name(".downloaded.sqlite.part").exists());

        delete(&config, "secret", "wheel-1-0.sqlite").await.unwrap();
        assert!(!server.contains("/dav/wheel/wheel-1-0.sqlite"));

        let error = list(&config, "wrong").await.unwrap_err();
        assert!(format!("{error:#}").contains("401"));
        // Traversal-shaped names never reach the server.
        assert!(delete(&config, "secret", "../wheel-1-0.sqlite")
            .await
            .is_err());

        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn fallback_put_is_used_when_move_is_unsupported() {
        std::env::set_var("NO_PROXY", "127.0.0.1,localhost");
        std::env::set_var("no_proxy", "127.0.0.1,localhost");

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let store: Arc<Mutex<HashMap<String, Vec<u8>>>> = Arc::new(Mutex::new(HashMap::new()));
        let shared = store.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let state = shared.clone();
                std::thread::spawn(move || {
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    let method = line.split_whitespace().next().unwrap_or("").to_string();
                    let target = line
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or("")
                        .split('?')
                        .next()
                        .unwrap_or("")
                        .to_string();
                    let mut length = 0usize;
                    loop {
                        let mut header = String::new();
                        reader.read_line(&mut header).unwrap();
                        if header == "\r\n" || header.is_empty() {
                            break;
                        }
                        if let Some((name, value)) = header.split_once(':') {
                            if name.eq_ignore_ascii_case("content-length") {
                                length = value.trim().parse().unwrap_or(0);
                            }
                        }
                    }
                    let mut body = vec![0u8; length];
                    reader.read_exact(&mut body).unwrap();
                    if method == "MOVE" {
                        let _ = respond(&mut stream, 405, "text/plain", b"no move");
                        return;
                    }
                    if method == "PUT" {
                        state.lock().unwrap().insert(target, body);
                        let _ = respond(&mut stream, 201, "text/plain", b"created");
                    } else if method == "PROPFIND" {
                        let xml = propfind_xml(&state, "/dav/wheel/");
                        let _ = respond(&mut stream, 207, "application/xml", xml.as_bytes());
                    } else if method == "DELETE" {
                        state.lock().unwrap().remove(&target);
                        let _ = respond(&mut stream, 204, "text/plain", b"");
                    } else {
                        let _ = respond(&mut stream, 404, "text/plain", b"");
                    }
                });
            }
        });

        let config = WebDavConfig {
            url: format!("http://127.0.0.1:{port}/dav/"),
            username: "tester".into(),
            remote_dir: "/wheel/".into(),
            auto_upload: false,
            keep: 10,
            encrypt: false,
            allow_insecure_http: true,
        };
        let directory = temp_dir("move-fallback");
        let local = directory.join("auto-1-0.sqlite");
        std::fs::write(&local, b"auto-bytes").unwrap();
        let outcome = publish(&config, "secret", &local, None).await.unwrap();
        assert_eq!(outcome.remote.file_name, "auto-1-0.sqlite");
        let map = store.lock().unwrap();
        assert!(map.contains_key("/dav/wheel/auto-1-0.sqlite"));
        assert!(!map.contains_key("/dav/wheel/auto-1-0.sqlite.tmp"));
        drop(map);

        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn automatic_retention_only_removes_old_auto_snapshots() {
        std::env::set_var("NO_PROXY", "127.0.0.1,localhost");
        std::env::set_var("no_proxy", "127.0.0.1,localhost");

        let server = MockServer::start();
        let config = WebDavConfig {
            url: server.base.clone(),
            username: "tester".into(),
            remote_dir: "/wheel/".into(),
            auto_upload: false,
            keep: 2,
            encrypt: false,
            allow_insecure_http: true,
        };
        let directory = temp_dir("retention");
        // Newest first by filename stamp: these all share the mock's modified time.
        for stamp in 1..=4 {
            let local = directory.join(format!("auto-{stamp}-0.sqlite"));
            std::fs::write(&local, b"x").unwrap();
            publish(&config, "secret", &local, None).await.unwrap();
        }
        let local = directory.join("wheel-9-0.sqlite");
        std::fs::write(&local, b"x").unwrap();
        publish(&config, "secret", &local, None).await.unwrap();

        assert!(server.contains("/dav/wheel/auto-4-0.sqlite"));
        assert!(server.contains("/dav/wheel/auto-3-0.sqlite"));
        assert!(!server.contains("/dav/wheel/auto-2-0.sqlite"));
        assert!(!server.contains("/dav/wheel/auto-1-0.sqlite"));
        assert!(server.contains("/dav/wheel/wheel-9-0.sqlite"));

        std::fs::remove_dir_all(directory).unwrap();
    }
}
