//! Wheel Tracker Mobile shell (M1/M2).
//!
//! The shell owns the SQLite connection and the app data directory; every
//! ledger rule lives in `wheel-store` and `wheel-core`, exactly as on desktop.
//! Commands below return the same camelCase views the desktop uses, plus a few
//! mobile-only fields (account list, demo flag, database path).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use rusqlite::Connection;
use serde::Serialize;
use tauri::{Manager, State};
use time::{Duration, OffsetDateTime};
use wheel_core::DerivedState;
use wheel_store::webdav::{
    Credential, RemoteBackup, ServerInfo, UploadOutcome, WebDavConfig, WebDavSettingsView,
    WebDavStatus,
};
use wheel_store::{backup, events, restore, store, views, webdav};

const DEMO_ACCOUNT: &str = "main";
const DEMO_ACCOUNT_NAME: &str = "主账户";
const DATABASE_FILE: &str = "wheel.db";

struct MobileState {
    conn: Mutex<Connection>,
    db_path: PathBuf,
    demo: bool,
    /// WebDAV password for this run only. Nothing here is written to disk: the
    /// Android Keystore-backed store is not wired up yet, and the ledger
    /// database must never hold a password.
    webdav: Mutex<Option<WebDavSession>>,
}

#[derive(Debug, Clone)]
struct WebDavSession {
    target: String,
    password: String,
}

fn session_target(config: &WebDavConfig) -> String {
    format!("{}\n{}", config.url.trim(), config.username.trim())
}

impl MobileState {
    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn data_dir(&self) -> &Path {
        self.db_path.parent().unwrap_or(Path::new("."))
    }

    fn backups_dir(&self) -> PathBuf {
        self.data_dir().join(backup::BACKUP_DIR)
    }

    fn webdav_credential(&self, config: &WebDavConfig) -> Option<Credential> {
        let session = self
            .webdav
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        session
            .as_ref()
            .filter(|session| session.target == session_target(config))
            .map(|session| Credential::new(session.password.clone(), "session"))
    }

    fn remember_webdav_password(&self, config: &WebDavConfig, password: Option<String>) {
        let mut session = self
            .webdav
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *session = match password {
            Some(password) if !password.is_empty() => Some(WebDavSession {
                target: session_target(config),
                password,
            }),
            Some(_) => None,
            None => session
                .take()
                .filter(|session| session.target == session_target(config)),
        };
    }
}

fn stamp() -> i128 {
    OffsetDateTime::now_utc().unix_timestamp_nanos()
}

/// A staged restore replaces the database on the next launch; until then the
/// restored snapshot would lose any row written now.
fn ensure_no_pending_restore(state: &MobileState) -> Result<(), String> {
    if restore::is_pending(state.data_dir()).map_err(|error| format!("{error:#}"))? {
        Err("已安排恢复，请完全退出并重启应用后再修改账本。".to_string())
    } else {
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountView {
    id: String,
    name: String,
    broker: Option<String>,
    event_count: usize,
    archived: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapView {
    account_id: String,
    today: String,
    db_path: String,
    demo: bool,
    accounts: Vec<AccountView>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OverviewView {
    account_id: String,
    as_of: String,
    db_path: String,
    demo: bool,
    summary: views::SummaryView,
    campaigns: Vec<views::CampaignCardView>,
    positions: Vec<views::PositionView>,
    lots: Vec<views::LotView>,
    accounts: Vec<AccountView>,
}

fn open_database(path: &Path) -> Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("cannot create {}", parent.display()))?;
    }
    store::open(path).with_context(|| format!("cannot open {}", path.display()))
}

fn accounts(conn: &Connection) -> Result<Vec<AccountView>> {
    Ok(store::list_accounts(conn)?
        .into_iter()
        .map(|account| AccountView {
            id: account.id,
            name: account.name,
            broker: account.broker,
            event_count: account.event_count,
            archived: account.archived_at.is_some(),
        })
        .collect())
}

fn derive(conn: &Connection, account_id: &str) -> Result<DerivedState> {
    let events = store::list_events(conn, account_id)?;
    let settings = store::get_settings(conn)?;
    store::replay_checked(account_id, &events, settings)
}

fn day(offset: i64) -> String {
    (store::today() + Duration::days(offset)).to_string()
}

/// A small, coherent ledger so a fresh install shows a real campaign instead of
/// an empty screen. Dates are relative to the install day so the expiry tab has
/// something to show. Never seeded once the account has any event.
fn seed_demo(conn: &Connection) -> Result<bool> {
    store::ensure_account(conn, DEMO_ACCOUNT, DEMO_ACCOUNT_NAME)?;
    if store::count_events(conn, DEMO_ACCOUNT)? > 0 {
        return Ok(false);
    }
    let request = |kind: &str,
                   date: String,
                   qty: u32,
                   price: f64,
                   amount: f64,
                   expiry: Option<String>,
                   strike: Option<f64>,
                   right: Option<&str>| events::NewEventReq {
        account_id: Some(DEMO_ACCOUNT.to_string()),
        date,
        kind: kind.to_string(),
        symbol: "AAPL".to_string(),
        qty,
        price,
        fees: 0.0,
        amount,
        expiry,
        strike,
        right: right.map(str::to_string),
        multiplier: None,
        split_numerator: None,
        split_denominator: None,
        split_cash_in_lieu: None,
        note: Some("演示数据".to_string()),
    };
    let reqs = vec![
        request("cash_deposit", day(-60), 0, 0.0, 20_000.0, None, None, None),
        request(
            "option_open_short",
            day(-60),
            1,
            2.0,
            0.0,
            Some(day(-45)),
            Some(150.0),
            Some("P"),
        ),
        request(
            "option_expire",
            day(-45),
            1,
            0.0,
            0.0,
            Some(day(-45)),
            Some(150.0),
            Some("P"),
        ),
        request("shares_buy", day(-45), 100, 148.0, 0.0, None, None, None),
        request(
            "option_open_short",
            day(-20),
            1,
            1.5,
            0.0,
            Some(day(20)),
            Some(160.0),
            Some("C"),
        ),
    ];
    events::append_requests(conn, reqs).map_err(anyhow::Error::msg)?;
    Ok(true)
}

#[tauri::command]
fn mobile_bootstrap(state: State<'_, MobileState>) -> Result<BootstrapView, String> {
    bootstrap(&state).map_err(|error| format!("{error:#}"))
}

fn bootstrap(state: &MobileState) -> Result<BootstrapView> {
    let conn = state.conn();
    Ok(BootstrapView {
        account_id: DEMO_ACCOUNT.to_string(),
        today: store::today().to_string(),
        db_path: state.db_path.display().to_string(),
        demo: state.demo,
        accounts: accounts(&conn)?,
    })
}

#[tauri::command]
fn mobile_overview(
    state: State<'_, MobileState>,
    account_id: Option<String>,
) -> Result<OverviewView, String> {
    overview(&state, account_id).map_err(|error| format!("{error:#}"))
}

fn overview(state: &MobileState, account_id: Option<String>) -> Result<OverviewView> {
    let account_id = events::account_or_default(account_id);
    let conn = state.conn();
    let derived = derive(&conn, &account_id)?;
    let prices = store::latest_prices(&conn)?;
    let today = store::today();

    let mut campaigns: Vec<views::CampaignCardView> = derived
        .campaigns
        .iter()
        .map(|campaign| {
            views::campaign_card(
                campaign,
                &derived,
                prices.get(&campaign.symbol).copied(),
                today,
            )
        })
        .collect();
    campaigns.sort_by(|a, b| {
        let rank = |status: &str| if status == "active" { 0 } else { 1 };
        rank(&a.status)
            .cmp(&rank(&b.status))
            .then_with(|| a.symbol.cmp(&b.symbol))
    });

    let mut positions: Vec<views::PositionView> = derived
        .positions
        .iter()
        .map(|position| views::position(position, today))
        .collect();
    positions.sort_by(|a, b| {
        a.days_left
            .cmp(&b.days_left)
            .then_with(|| a.symbol.cmp(&b.symbol))
    });

    let lots = derived.lots.iter().map(views::lot).collect();

    Ok(OverviewView {
        account_id,
        as_of: today.to_string(),
        db_path: state.db_path.display().to_string(),
        demo: state.demo,
        summary: views::summary(&derived),
        campaigns,
        positions,
        lots,
        accounts: accounts(&conn)?,
    })
}

#[tauri::command]
fn mobile_add_event(
    state: State<'_, MobileState>,
    req: events::NewEventReq,
) -> Result<String, String> {
    ensure_no_pending_restore(&state)?;
    let conn = state.conn();
    let mut ids = events::append_requests(&conn, vec![req])?;
    Ok(ids.remove(0))
}

// ---------------------------------------------------------------------------
// WebDAV backup and restore
// ---------------------------------------------------------------------------

#[tauri::command]
fn mobile_webdav_settings(state: State<'_, MobileState>) -> Result<WebDavSettingsView, String> {
    let conn = state.conn();
    let config = webdav::load(&conn).map_err(|error| format!("{error:#}"))?;
    webdav::settings_view(&conn, &config, state.webdav_credential(&config).as_ref())
        .map_err(|error| format!("{error:#}"))
}

#[tauri::command]
fn mobile_webdav_status(state: State<'_, MobileState>) -> Result<WebDavStatus, String> {
    let conn = state.conn();
    let config = webdav::load(&conn).map_err(|error| format!("{error:#}"))?;
    webdav::status(&conn, &config, state.webdav_credential(&config).as_ref())
        .map_err(|error| format!("{error:#}"))
}

#[tauri::command]
fn mobile_webdav_save(
    state: State<'_, MobileState>,
    config: WebDavConfig,
    password: Option<String>,
) -> Result<WebDavSettingsView, String> {
    config.validate().map_err(|error| format!("{error:#}"))?;
    let conn = state.conn();
    let previous = webdav::load(&conn).map_err(|error| format!("{error:#}"))?;
    let saved = webdav::save(&conn, &config).map_err(|error| format!("{error:#}"))?;
    if previous.configured()
        && (previous.url.trim() != saved.url || previous.username.trim() != saved.username)
    {
        // Never leave a password behind for an address the user moved away from.
        state.remember_webdav_password(&previous, Some(String::new()));
    }
    state.remember_webdav_password(&saved, password);
    webdav::settings_view(&conn, &saved, state.webdav_credential(&saved).as_ref())
        .map_err(|error| format!("{error:#}"))
}

#[tauri::command]
async fn mobile_webdav_test(
    state: State<'_, MobileState>,
    config: WebDavConfig,
    password: Option<String>,
) -> Result<ServerInfo, String> {
    config.validate().map_err(|error| format!("{error:#}"))?;
    let password = webdav::resolve_password(state.webdav_credential(&config).as_ref(), password)
        .map_err(|error| format!("{error:#}"))?;
    webdav::test(&config, &password)
        .await
        .map_err(|error| format!("{error:#}"))
}

#[tauri::command]
async fn mobile_webdav_list(
    state: State<'_, MobileState>,
    server_password: Option<String>,
) -> Result<Vec<RemoteBackup>, String> {
    let (config, password) = {
        let conn = state.conn();
        let config = webdav::load(&conn).map_err(|error| format!("{error:#}"))?;
        config.validate().map_err(|error| format!("{error:#}"))?;
        let password =
            webdav::resolve_password(state.webdav_credential(&config).as_ref(), server_password)
                .map_err(|error| format!("{error:#}"))?;
        (config, password)
    };
    webdav::list(&config, &password)
        .await
        .map_err(|error| format!("{error:#}"))
}

#[tauri::command]
async fn mobile_webdav_backup(
    state: State<'_, MobileState>,
    server_password: Option<String>,
    backup_password: Option<String>,
) -> Result<UploadOutcome, String> {
    let (config, password, local) = {
        let conn = state.conn();
        let config = webdav::load(&conn).map_err(|error| format!("{error:#}"))?;
        config.validate().map_err(|error| format!("{error:#}"))?;
        let password =
            webdav::resolve_password(state.webdav_credential(&config).as_ref(), server_password)
                .map_err(|error| format!("{error:#}"))?;
        let backup_password = backup_password.filter(|value| !value.is_empty());
        if config.encrypt && backup_password.is_none() {
            return Err("已开启加密上传：请填写备份密码（至少 8 位）。密码不会保存。".to_string());
        }
        let directory = state.backups_dir();
        let stamp = stamp();
        let path = match &backup_password {
            Some(secret) => backup::create_encrypted(&conn, &directory, "wheel-", stamp, secret),
            None => backup::create(&conn, &directory, "wheel-", stamp),
        }
        .map_err(|error| format!("{error:#}"))?;
        (config, password, path)
    };

    webdav::begin().map_err(|error| error.to_string())?;
    let result = webdav::publish(&config, &password, &local, None).await;
    webdav::finish();
    let conn = state.conn();
    match result {
        Ok(outcome) => {
            let _ = webdav::clear_pending_upload(&conn);
            let _ = webdav::record_upload_success(&conn, &outcome.remote.file_name);
            Ok(outcome)
        }
        Err(error) => {
            let text = format!("{error:#}");
            // Keep the local snapshot recorded so a later retry can send it.
            let _ = webdav::record_pending_upload(&conn, &local);
            let _ = webdav::record_error(&conn, &text);
            Err(text)
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WebDavDownload {
    validation: backup::BackupValidation,
    local_file: String,
}

#[tauri::command]
async fn mobile_webdav_download(
    state: State<'_, MobileState>,
    file_name: String,
    server_password: Option<String>,
    backup_password: Option<String>,
) -> Result<WebDavDownload, String> {
    ensure_no_pending_restore(&state)?;
    let (config, password, directory, local_file) = {
        let conn = state.conn();
        let config = webdav::load(&conn).map_err(|error| format!("{error:#}"))?;
        config.validate().map_err(|error| format!("{error:#}"))?;
        let password =
            webdav::resolve_password(state.webdav_credential(&config).as_ref(), server_password)
                .map_err(|error| format!("{error:#}"))?;
        let suffix = if file_name.ends_with(".sqlite.enc") {
            "sqlite.enc"
        } else {
            "sqlite"
        };
        (
            config,
            password,
            state.backups_dir(),
            format!("download-{}-0.{suffix}", stamp()),
        )
    };
    let target = directory.join(&local_file);

    webdav::begin().map_err(|error| error.to_string())?;
    let downloaded = webdav::download(&config, &password, &file_name, &target).await;
    webdav::finish();
    downloaded.map_err(|error| format!("{error:#}"))?;

    let backup_password = backup_password.filter(|value| !value.is_empty());
    let validation =
        backup::validate_with_password(&directory, &local_file, backup_password.as_deref())
            .map_err(|error| format!("{error:#}"))?;
    if !validation.valid {
        // A corrupt download must not linger as a restore candidate.
        let _ = std::fs::remove_file(&target);
    }
    Ok(WebDavDownload {
        validation,
        local_file,
    })
}

#[tauri::command]
fn mobile_webdav_stage_restore(
    state: State<'_, MobileState>,
    file_name: String,
    password: Option<String>,
) -> Result<restore::PendingRestore, String> {
    ensure_no_pending_restore(&state)?;
    if !file_name.starts_with("download-") || !backup::is_safe_file_name(&file_name) {
        return Err("只能恢复刚从云端下载到本机的快照".to_string());
    }
    let conn = state.conn();
    restore::stage_with_password(
        &conn,
        state.data_dir(),
        &file_name,
        stamp(),
        password.as_deref().filter(|value| !value.is_empty()),
    )
    .map_err(|error| format!("{error:#}"))
}

#[tauri::command]
fn mobile_restore_status(state: State<'_, MobileState>) -> Result<restore::RestoreStatus, String> {
    restore::status(state.data_dir()).map_err(|error| format!("{error:#}"))
}

#[tauri::command]
async fn mobile_webdav_delete(
    state: State<'_, MobileState>,
    file_name: String,
    server_password: Option<String>,
) -> Result<bool, String> {
    let (config, password) = {
        let conn = state.conn();
        let config = webdav::load(&conn).map_err(|error| format!("{error:#}"))?;
        config.validate().map_err(|error| format!("{error:#}"))?;
        let password =
            webdav::resolve_password(state.webdav_credential(&config).as_ref(), server_password)
                .map_err(|error| format!("{error:#}"))?;
        (config, password)
    };
    webdav::delete(&config, &password, &file_name)
        .await
        .map_err(|error| format!("{error:#}"))?;
    Ok(true)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app
                .path()
                .app_data_dir()
                .context("no writable app data directory")?;
            let db_path = dir.join(DATABASE_FILE);
            // A staged restore must replace the file before SQLite opens it.
            if let Some(result) = restore::apply_pending(&dir, stamp())? {
                eprintln!("restore finished: {}", result.message);
            }
            let conn = open_database(&db_path)?;
            let demo = seed_demo(&conn)?;
            app.manage(MobileState {
                conn: Mutex::new(conn),
                db_path,
                demo,
                webdav: Mutex::new(None),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            mobile_bootstrap,
            mobile_overview,
            mobile_add_event,
            mobile_webdav_settings,
            mobile_webdav_status,
            mobile_webdav_save,
            mobile_webdav_test,
            mobile_webdav_list,
            mobile_webdav_backup,
            mobile_webdav_download,
            mobile_webdav_stage_restore,
            mobile_restore_status,
            mobile_webdav_delete
        ])
        .run(tauri::generate_context!())
        .expect("error while running Wheel Tracker Mobile");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_state(name: &str) -> MobileState {
        let path = std::env::temp_dir().join(format!(
            "wheel-mobile-test-{}-{name}.db",
            std::process::id()
        ));
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
        let conn = open_database(&path).unwrap();
        MobileState {
            conn: Mutex::new(conn),
            db_path: path,
            demo: false,
            webdav: Mutex::new(None),
        }
    }

    #[test]
    fn demo_ledger_replays_and_is_idempotent() {
        let state = memory_state("seed");
        let conn = state.conn();
        assert!(seed_demo(&conn).unwrap());
        assert!(!seed_demo(&conn).unwrap(), "second seed must be a no-op");

        let derived = derive(&conn, DEMO_ACCOUNT).unwrap();
        let campaign = derived
            .campaigns
            .iter()
            .find(|campaign| campaign.shares == 100)
            .expect("seeded share campaign");
        assert_eq!(campaign.cost_a(), Some(148.0));
        assert!((campaign.cost_b(false).unwrap() - 146.0).abs() < 1e-9);
        assert!((campaign.premium_realized - 200.0).abs() < 1e-9);
        assert!((campaign.premium_open - 150.0).abs() < 1e-9);
        assert_eq!(derived.positions.len(), 1, "one open call");
        let summary = views::summary(&derived);
        assert_eq!(summary.open_contracts, 1);
        assert!(
            !summary.collateral.is_sign_negative(),
            "no Put means +0 collateral"
        );
    }

    #[test]
    fn session_credential_is_scoped_to_one_server_and_never_written_to_sqlite() {
        let state = memory_state("webdav");
        let conn = state.conn();
        let config = WebDavConfig {
            url: "https://dav.example.com/dav/".into(),
            username: "tester".into(),
            auto_upload: false,
            ..WebDavConfig::default()
        };
        let saved = webdav::save(&conn, &config).unwrap();
        state.remember_webdav_password(&saved, Some("hunter2-secret".into()));

        let credential = state.webdav_credential(&saved).expect("session credential");
        assert_eq!(credential.password, "hunter2-secret");
        assert_eq!(credential.source, "session");
        let view = webdav::settings_view(&conn, &saved, Some(&credential)).unwrap();
        assert!(view.has_password);
        assert_eq!(view.password_source, "session");

        let other = WebDavConfig {
            username: "someone-else".into(),
            ..saved.clone()
        };
        assert!(state.webdav_credential(&other).is_none());

        let leaked: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM settings WHERE value LIKE '%hunter2%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(leaked, 0, "the WebDAV password must never reach SQLite");

        state.remember_webdav_password(&saved, Some(String::new()));
        assert!(state.webdav_credential(&saved).is_none());
    }

    #[test]
    fn adding_an_event_writes_through_the_shared_validator() {
        let state = memory_state("add");
        let conn = state.conn();
        seed_demo(&conn).unwrap();
        let before = store::count_events(&conn, DEMO_ACCOUNT).unwrap();
        let request = events::NewEventReq {
            account_id: None,
            date: store::today().to_string(),
            kind: "option_close".into(),
            symbol: "AAPL".into(),
            qty: 1,
            price: 0.5,
            fees: 0.0,
            amount: 0.0,
            expiry: Some(day(20)),
            strike: Some(160.0),
            right: Some("C".into()),
            multiplier: None,
            split_numerator: None,
            split_denominator: None,
            split_cash_in_lieu: None,
            note: None,
        };
        let id = events::append_requests(&conn, vec![request])
            .unwrap()
            .remove(0);
        assert!(id.starts_with("ev-"));
        assert_eq!(
            store::count_events(&conn, DEMO_ACCOUNT).unwrap(),
            before + 1
        );
        assert!(derive(&conn, DEMO_ACCOUNT).unwrap().positions.is_empty());
    }
}
