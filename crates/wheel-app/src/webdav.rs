//! Desktop bindings for the shared WebDAV layer.
//!
//! The protocol, config, parsing and retention rules live in
//! [`wheel_store::webdav`]. This module adds the two things only the desktop
//! shell can provide: OS credential storage (Windows Credential Manager, with a
//! session-only fallback elsewhere) and the background upload workers that need
//! `AppState`.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};

use crate::{backup, secrets, AppState};

pub use wheel_store::webdav::{
    begin, clear_pending_upload, delete, download, finish, list, load, pending_upload, publish,
    record_error, record_pending_upload, record_upload_success, remember_backup_password, save,
    test, Credential, RemoteBackup, ServerInfo, UploadOutcome, WebDavConfig, WebDavSettingsView,
    WebDavStatus,
};

/// The credential the desktop has stored for this server/account pair.
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

fn credential(config: &WebDavConfig) -> Option<Credential> {
    stored_password(config).map(|(password, source)| Credential::new(password, source.as_str()))
}

pub fn resolve_password(config: &WebDavConfig, supplied: Option<String>) -> Result<String> {
    wheel_store::webdav::resolve_password(credential(config).as_ref(), supplied)
}

pub fn status(conn: &rusqlite::Connection, config: &WebDavConfig) -> Result<WebDavStatus> {
    wheel_store::webdav::status(conn, config, credential(config).as_ref())
}

pub fn settings_view(
    conn: &rusqlite::Connection,
    config: &WebDavConfig,
) -> Result<WebDavSettingsView> {
    wheel_store::webdav::settings_view(conn, config, credential(config).as_ref())
}

fn encryption_password_for(config: &WebDavConfig) -> Result<Option<String>> {
    if !config.encrypt {
        return Ok(None);
    }
    wheel_store::webdav::backup_password()
        .map(Some)
        .ok_or_else(|| {
            anyhow!(
                "自动上传已跳过：加密上传已开启，但本次运行尚未提供备份密码。请在 WebDAV 面板执行一次手动备份。"
            )
        })
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
            let Some(path) = pending_upload(&conn).ok().flatten() else {
                return;
            };
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
