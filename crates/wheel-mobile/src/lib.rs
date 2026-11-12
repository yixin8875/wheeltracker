//! M0.5 Android spike: prove that Tauri, bundled SQLite and `wheel-core`
//! replay work together on a phone-sized screen.
//!
//! The probe deliberately uses a tiny dedicated table instead of the desktop
//! schema. Extracting the shared data layer is an M1 task; this crate only
//! validates the toolchain and the Rust/WebView boundary.

use std::path::Path;

use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::Manager;
use time::format_description::well_known::Rfc3339;
use time::macros::format_description;
use time::{Date, OffsetDateTime};
use wheel_core::{replay, Event, OptionContract, Right, Settings};

const ACCOUNT_ID: &str = "main";
const DATE_FORMAT: &[time::format_description::FormatItem<'static>] =
    format_description!("[year]-[month]-[day]");

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CampaignCard {
    symbol: String,
    shares: u32,
    cost_a: Option<f64>,
    cost_b: Option<f64>,
    cost_c: Option<f64>,
    premium_realized: f64,
    premium_open: f64,
    status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeView {
    db_path: String,
    sqlite_version: String,
    event_count: usize,
    campaigns: Vec<CampaignCard>,
    generated_at: String,
    note: String,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS probe_events (
  id           TEXT PRIMARY KEY,
  seq          INTEGER NOT NULL,
  occurred_at  TEXT NOT NULL,
  kind         TEXT NOT NULL,
  symbol       TEXT NOT NULL,
  expiry       TEXT,
  strike       REAL,
  right        TEXT,
  qty          INTEGER NOT NULL,
  price        REAL NOT NULL,
  fees         REAL NOT NULL
);
"#;

fn initialize(conn: &Connection) -> Result<()> {
    conn.execute_batch(SCHEMA)?;
    Ok(())
}

fn open_database(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)
        .with_context(|| format!("cannot open mobile database at {}", path.display()))?;
    conn.execute_batch("PRAGMA journal_mode = WAL;")?;
    initialize(&conn)?;
    Ok(conn)
}

fn seed_if_empty(conn: &Connection) -> Result<()> {
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM probe_events", [], |row| row.get(0))?;
    if count > 0 {
        return Ok(());
    }
    let rows = [
        ("m0-1", 1_i64, "2026-01-05", "sell_put", "AAPL", Some("2026-02-20"), Some(150.0), Some("put"), 1_i64, 2.0, 0.0),
        ("m0-2", 2, "2026-02-20", "expire_put", "AAPL", Some("2026-02-20"), Some(150.0), Some("put"), 1, 0.0, 0.0),
        ("m0-3", 3, "2026-02-23", "buy_shares", "AAPL", None, None, None, 100, 148.0, 0.0),
        ("m0-4", 4, "2026-02-24", "sell_call", "AAPL", Some("2026-03-20"), Some(160.0), Some("call"), 1, 1.5, 0.0),
    ];
    for row in rows {
        conn.execute(
            "INSERT INTO probe_events
               (id, seq, occurred_at, kind, symbol, expiry, strike, right, qty, price, fees)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                row.0, row.1, row.2, row.3, row.4, row.5, row.6, row.7, row.8, row.9, row.10
            ],
        )?;
    }
    Ok(())
}

fn load_events(conn: &Connection) -> Result<Vec<Event>> {
    let mut stmt = conn.prepare(
        "SELECT id, seq, occurred_at, kind, symbol, expiry, strike, right, qty, price, fees
         FROM probe_events ORDER BY seq",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, Option<f64>>(6)?,
            row.get::<_, Option<String>>(7)?,
            row.get::<_, i64>(8)?,
            row.get::<_, f64>(9)?,
            row.get::<_, f64>(10)?,
        ))
    })?;

    let mut events = Vec::new();
    for row in rows {
        let (
            id,
            seq,
            occurred_at,
            kind,
            symbol,
            expiry,
            strike,
            right,
            qty,
            price,
            fees,
        ) = row?;
        let at = Date::parse(&occurred_at, DATE_FORMAT)
            .with_context(|| format!("bad probe date {occurred_at}"))?;
        let expiry = expiry
            .as_deref()
            .map(|value| Date::parse(value, DATE_FORMAT))
            .transpose()
            .context("bad probe expiry")?;
        let right = match right.as_deref() {
            Some("put") => Some(Right::Put),
            Some("call") => Some(Right::Call),
            _ => None,
        };
        let contract = || -> Result<OptionContract> {
            let expiry = expiry.context("option row is missing expiry")?;
            let strike = strike.context("option row is missing strike")?;
            let right = right.context("option row is missing right")?;
            Ok(OptionContract::new(&symbol, expiry, strike, right))
        };
        let event = match kind.as_str() {
            "sell_put" | "sell_call" => Event::sell_option(
                ACCOUNT_ID,
                &id,
                seq as u64,
                at,
                contract()?,
                qty as u32,
                price,
                fees,
            ),
            "expire_put" | "expire_call" => Event::expire_option(
                ACCOUNT_ID,
                &id,
                seq as u64,
                at,
                contract()?,
                qty as u32,
            ),
            "buy_shares" => Event::buy_shares(
                ACCOUNT_ID,
                &id,
                seq as u64,
                at,
                &symbol,
                qty as u32,
                price,
                fees,
            ),
            other => bail!("unsupported probe event kind {other}"),
        };
        events.push(event);
    }
    Ok(events)
}

#[tauri::command]
fn mobile_probe(app: tauri::AppHandle) -> Result<ProbeView, String> {
    probe(&app).map_err(|error| format!("{error:#}"))
}

fn probe(app: &tauri::AppHandle) -> Result<ProbeView> {
    let dir = app
        .path()
        .app_data_dir()
        .context("no writable app data directory")?;
    std::fs::create_dir_all(&dir)?;
    let db_path = dir.join("wheel-mobile.db");
    let conn = open_database(&db_path)?;
    seed_if_empty(&conn)?;
    let events = load_events(&conn)?;
    let state = replay(ACCOUNT_ID, &events, Settings::default())?;
    let sqlite_version: String =
        conn.query_row("SELECT sqlite_version()", [], |row| row.get(0))?;

    let campaigns = state
        .campaigns
        .iter()
        .map(|campaign| CampaignCard {
            symbol: campaign.symbol.clone(),
            shares: campaign.shares,
            cost_a: campaign.cost_a(),
            cost_b: campaign.cost_b(state.settings.include_dividends_in_cost),
            cost_c: campaign.cost_c(state.settings.include_dividends_in_cost),
            premium_realized: campaign.premium_realized,
            premium_open: campaign.premium_open,
            status: format!("{:?}", campaign.status),
        })
        .collect();

    Ok(ProbeView {
        db_path: db_path.display().to_string(),
        sqlite_version,
        event_count: events.len(),
        campaigns,
        generated_at: OffsetDateTime::now_utc().format(&Rfc3339)?,
        note: "M0.5 探针数据：用于验证 Android 上的 SQLite、wheel-core 重放与前端渲染，不是真实账本。".into(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![mobile_probe])
        .run(tauri::generate_context!())
        .expect("error while running Wheel Tracker Mobile");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_seeds_and_replays_a_campaign() {
        let conn = Connection::open_in_memory().unwrap();
        initialize(&conn).unwrap();
        seed_if_empty(&conn).unwrap();
        // Re-running the seed must not duplicate rows.
        seed_if_empty(&conn).unwrap();

        let events = load_events(&conn).unwrap();
        assert_eq!(events.len(), 4);
        let state = replay(ACCOUNT_ID, &events, Settings::default()).unwrap();
        let campaign = state
            .campaigns
            .iter()
            .find(|campaign| campaign.shares == 100)
            .expect("seeded share campaign");

        assert_eq!(campaign.cost_a(), Some(148.0));
        assert!((campaign.cost_b(false).unwrap() - 146.0).abs() < 1e-9);
        assert!((campaign.premium_realized - 200.0).abs() < 1e-9);
        assert!((campaign.premium_open - 150.0).abs() < 1e-9);
    }
}
