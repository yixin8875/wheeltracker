#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backup;
mod commands;
mod import;
mod market;
mod restore;
mod store;
mod views;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use rusqlite::Connection;
use tauri::Manager;

pub struct AppState {
    pub conn: Mutex<Connection>,
    pub db_path: String,
    pub data_dir: String,
}

impl AppState {
    pub fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The database mutex is also held by dialogs and long commands. The
    /// scheduler must never block the UI, so it simply skips a turn instead.
    pub fn try_conn(&self) -> Option<std::sync::MutexGuard<'_, Connection>> {
        match self.conn.try_lock() {
            Ok(guard) => Some(guard),
            Err(std::sync::TryLockError::Poisoned(poisoned)) => Some(poisoned.into_inner()),
            Err(std::sync::TryLockError::WouldBlock) => None,
        }
    }
}

fn stamp() -> i128 {
    time::OffsetDateTime::now_utc().unix_timestamp_nanos()
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let db_path = dir.join("wheel.db");
            // A staged restore must replace the file before SQLite opens it.
            if let Some(result) = restore::apply_pending(&dir, stamp())? {
                eprintln!("restore finished: {}", result.message);
            }
            let conn = store::open(&db_path)?;
            store::ensure_account(&conn, "main", "默认账户")?;
            let today = store::today().to_string();
            if let Err(error) = backup::run_if_due(&conn, &db_path, &today, stamp()) {
                // A failed automatic snapshot must not prevent the app opening.
                eprintln!("automatic backup failed: {error:#}");
            }
            app.manage(AppState {
                conn: Mutex::new(conn),
                db_path: db_path.display().to_string(),
                data_dir: dir.display().to_string(),
            });

            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(30 * 60));
                let state = handle.state::<AppState>();
                let Some(conn) = state.try_conn() else {
                    continue;
                };
                let db_path = PathBuf::from(&state.db_path);
                let today = store::today().to_string();
                if let Err(error) = backup::run_if_due(&conn, &db_path, &today, stamp()) {
                    eprintln!("automatic backup failed: {error:#}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::dashboard,
            commands::campaign_detail,
            commands::ledger,
            commands::positions,
            commands::list_events,
            commands::add_events,
            commands::add_event,
            commands::delete_event,
            commands::set_price,
            commands::list_prices,
            commands::search_symbols,
            commands::fetch_quote,
            commands::refresh_quotes,
            commands::rebuild,
            commands::backup_now,
            commands::app_info,
            commands::get_settings,
            commands::set_settings,
            commands::set_preferences,
            commands::list_backups,
            commands::validate_backup,
            commands::stage_restore,
            commands::restore_status,
            commands::import_preview,
            commands::import_commit,
            commands::import_save_mapping,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Wheel Tracker");
}
