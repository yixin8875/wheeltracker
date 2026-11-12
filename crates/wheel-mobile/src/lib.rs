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
use time::Duration;
use wheel_core::DerivedState;
use wheel_store::{events, store, views};

const DEMO_ACCOUNT: &str = "main";
const DEMO_ACCOUNT_NAME: &str = "主账户";
const DATABASE_FILE: &str = "wheel.db";

struct MobileState {
    conn: Mutex<Connection>,
    db_path: PathBuf,
    demo: bool,
}

impl MobileState {
    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
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
        request(
            "cash_deposit",
            day(-60),
            0,
            0.0,
            20_000.0,
            None,
            None,
            None,
        ),
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
    let conn = state.conn();
    let mut ids = events::append_requests(&conn, vec![req])?;
    Ok(ids.remove(0))
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
            let conn = open_database(&db_path)?;
            let demo = seed_demo(&conn)?;
            app.manage(MobileState {
                conn: Mutex::new(conn),
                db_path,
                demo,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            mobile_bootstrap,
            mobile_overview,
            mobile_add_event
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
        assert!(!summary.collateral.is_sign_negative(), "no Put means +0 collateral");
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
        assert_eq!(store::count_events(&conn, DEMO_ACCOUNT).unwrap(), before + 1);
        assert!(derive(&conn, DEMO_ACCOUNT).unwrap().positions.is_empty());
    }
}
