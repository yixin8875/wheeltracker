#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backup;
mod commands;
mod crypto;
mod import;
mod market;
mod notifications;
mod restore;
mod secrets;
mod store;
mod trade_text;
mod views;
mod vision;
mod webdav;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use rusqlite::Connection;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WindowEvent};

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

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Tray menu and icon. Left-click restores the window; the menu offers an
/// explicit expiry check and a real quit path while the window is hidden.
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开主窗口", true, None::<&str>)?;
    let check = MenuItem::with_id(app, "check_expiry", "检查到期", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &check, &separator, &quit])?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Wheel Tracker")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "check_expiry" => {
                let state = app.state::<AppState>();
                let Some(conn) = state.try_conn() else {
                    return;
                };
                match notifications::check_and_notify(&conn, |title, body| {
                    notifications::send(app, title, body)
                }) {
                    Ok(summary) => {
                        notifications::update_tray_tooltip(app, &summary);
                        if summary.notified == 0 {
                            let body = if summary.total == 0 {
                                "当前没有到期提醒。".to_string()
                            } else {
                                format!(
                                    "{} 个到期提醒（{} 个已过期，{} 个今天到期）。",
                                    summary.total, summary.overdue, summary.today
                                )
                            };
                            let _ = notifications::send(app, "Wheel Tracker · 到期检查", &body);
                        }
                    }
                    Err(error) => eprintln!("expiry check failed: {error:#}"),
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                let hide = state
                    .try_conn()
                    .map(|conn| {
                        store::get_preferences(&conn)
                            .map(|preferences| preferences.close_to_tray)
                            .unwrap_or(false)
                    })
                    .unwrap_or(false);
                if hide {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
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
            let backup_day = store::utc_today().to_string();
            let pending_upload = match backup::run_if_due(&conn, &db_path, &backup_day, stamp()) {
                // A failed automatic snapshot must not prevent the app opening.
                Err(error) => {
                    eprintln!("automatic backup failed: {error:#}");
                    None
                }
                Ok(Some(path)) => Some(path),
                Ok(None) => None,
            };
            app.manage(AppState {
                conn: Mutex::new(conn),
                db_path: db_path.display().to_string(),
                data_dir: dir.display().to_string(),
            });
            if let Some(path) = pending_upload {
                // Upload after state is managed so a slow server never delays
                // the window and the worker can always read the settings.
                webdav::spawn_auto_upload(app.handle().clone(), path);
            } else {
                // A failed upload left a snapshot queued; retry it quietly.
                webdav::spawn_retry_upload(app.handle().clone());
            }

            setup_tray(app)?;

            let expiry_handle = app.handle().clone();
            std::thread::spawn(move || {
                // Give the window and database a moment to settle, then check
                // hourly. Notifications are deduplicated inside the scanner.
                std::thread::sleep(Duration::from_secs(5));
                loop {
                    let state = expiry_handle.state::<AppState>();
                    if let Some(conn) = state.try_conn() {
                        match notifications::check_and_notify(&conn, |title, body| {
                            notifications::send(&expiry_handle, title, body)
                        }) {
                            Ok(summary) => {
                                notifications::update_tray_tooltip(&expiry_handle, &summary)
                            }
                            Err(error) => eprintln!("expiry check failed: {error:#}"),
                        }
                    }
                    std::thread::sleep(Duration::from_secs(60 * 60));
                }
            });

            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(30 * 60));
                let state = handle.state::<AppState>();
                let Some(conn) = state.try_conn() else {
                    continue;
                };
                let db_path = PathBuf::from(&state.db_path);
                let backup_day = store::utc_today().to_string();
                match backup::run_if_due(&conn, &db_path, &backup_day, stamp()) {
                    Err(error) => eprintln!("automatic backup failed: {error:#}"),
                    Ok(Some(path)) => webdav::spawn_auto_upload(handle.clone(), path),
                    Ok(None) => {}
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::dashboard,
            commands::all_accounts_overview,
            commands::all_holdings_overview,
            commands::cash_movements,
            commands::check_expiries,
            commands::send_test_notification,
            commands::campaign_detail,
            commands::ledger,
            commands::monthly_income,
            commands::annual_report,
            commands::positions,
            commands::list_events,
            commands::add_events,
            commands::add_event,
            commands::update_event,
            commands::delete_event,
            commands::set_price,
            commands::list_prices,
            commands::search_symbols,
            commands::fetch_quote,
            commands::refresh_quotes,
            commands::rebuild,
            commands::backup_now,
            commands::export_json,
            commands::app_info,
            commands::list_accounts,
            commands::create_account,
            commands::rename_account,
            commands::set_account_archived,
            commands::delete_account,
            commands::get_settings,
            commands::set_settings,
            commands::set_preferences,
            commands::list_backups,
            commands::validate_backup,
            commands::stage_restore,
            commands::restore_status,
            commands::webdav_get_settings,
            commands::webdav_save_settings,
            commands::webdav_test,
            commands::webdav_list,
            commands::webdav_backup_now,
            commands::webdav_restore,
            commands::webdav_stage_restore,
            commands::webdav_delete,
            commands::webdav_status,
            commands::import_preview,
            commands::import_commit,
            commands::import_save_mapping,
            commands::list_import_batches,
            commands::undo_import_batch,
            commands::get_vision_settings,
            commands::set_vision_settings,
            commands::vision_import_preview,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Wheel Tracker");
}
