//! SQLite persistence for the immutable event log and manual price quotes.
//! Derived state is never stored: every read replays the events through
//! `wheel-core`, which keeps the database small and always consistent.

use std::collections::HashMap;
use std::path::Path;

use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use time::macros::format_description;
use time::Date;
use wheel_core::{
    replay, DerivedState, Event, EventKind, OptionAction, OptionContract, Right, Settings,
    SplitTerms,
};

/// Bumped when the persisted event schema changes. A database written by a
/// newer build is refused rather than silently read with missing columns.
pub const SCHEMA_VERSION: i64 = 4;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO settings (key, value) VALUES ('includeDividendsInCost', 'false');

CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  broker        TEXT,
  currency      TEXT NOT NULL DEFAULT 'USD',
  created_at    TEXT NOT NULL,
  archived_at   TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  occurred_at  TEXT NOT NULL,
  kind         TEXT NOT NULL,
  symbol       TEXT NOT NULL,
  expiry       TEXT,
  strike       REAL,
  right        TEXT,
  multiplier   INTEGER,
  split_numerator   INTEGER,
  split_denominator INTEGER,
  split_cash_in_lieu REAL,
  qty          INTEGER NOT NULL,
  price        REAL NOT NULL DEFAULT 0,
  fees         REAL NOT NULL DEFAULT 0,
  amount       REAL NOT NULL DEFAULT 0,
  note         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  deleted_at   TEXT,
  UNIQUE (account_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_account ON events (account_id, occurred_at, seq);

CREATE TABLE IF NOT EXISTS prices (
  symbol TEXT NOT NULL,
  date   TEXT NOT NULL,
  close  REAL NOT NULL,
  PRIMARY KEY (symbol, date)
);
"#;

pub fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)
        .with_context(|| format!("cannot open database at {}", path.display()))?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
    initialize(&conn)?;
    Ok(conn)
}

fn initialize(conn: &Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version > SCHEMA_VERSION {
        bail!(
            "数据库由更新版本创建（schema {version}），请升级应用后再打开；当前最多支持 {SCHEMA_VERSION}"
        );
    }
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    tx.execute_batch(SCHEMA)?;
    let has_deleted_at = {
        let mut stmt = tx.prepare("PRAGMA table_info(events)")?;
        let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
        names
            .collect::<rusqlite::Result<Vec<_>>>()?
            .iter()
            .any(|name| name == "deleted_at")
    };
    if !has_deleted_at {
        tx.execute_batch("ALTER TABLE events ADD COLUMN deleted_at TEXT;")?;
    }
    let event_columns = {
        let mut stmt = tx.prepare("PRAGMA table_info(events)")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    if !event_columns.iter().any(|name| name == "split_numerator") {
        tx.execute_batch(
            "ALTER TABLE events ADD COLUMN split_numerator INTEGER;
             ALTER TABLE events ADD COLUMN split_denominator INTEGER;
             ALTER TABLE events ADD COLUMN split_cash_in_lieu REAL;",
        )?;
    }
    let columns = {
        let mut stmt = tx.prepare("PRAGMA table_info(prices)")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    if !columns.iter().any(|name| name == "source") {
        tx.execute_batch("ALTER TABLE prices ADD COLUMN source TEXT NOT NULL DEFAULT '手动';")?;
    }
    if !columns.iter().any(|name| name == "quoted_at") {
        tx.execute_batch("ALTER TABLE prices ADD COLUMN quoted_at TEXT;")?;
    }
    let account_columns = {
        let mut stmt = tx.prepare("PRAGMA table_info(accounts)")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    if !account_columns.iter().any(|name| name == "archived_at") {
        tx.execute_batch("ALTER TABLE accounts ADD COLUMN archived_at TEXT;")?;
    }
    tx.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))?;
    tx.commit()?;
    Ok(())
}

pub fn get_settings(conn: &Connection) -> Result<Settings> {
    let value: String = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'includeDividendsInCost'",
            [],
            |row| row.get(0),
        )
        .context("读取分红成本设置失败")?;
    let include_dividends_in_cost = match value.as_str() {
        "true" => true,
        "false" => false,
        _ => bail!("已保存的分红成本设置无效 `{value}`"),
    };
    Ok(Settings {
        include_dividends_in_cost,
    })
}

pub fn set_settings(conn: &Connection, include_dividends_in_cost: bool) -> Result<Settings> {
    // Refuse to silently overwrite corrupt persisted state.
    get_settings(conn)?;
    conn.execute(
        "UPDATE settings SET value = ?1 WHERE key = 'includeDividendsInCost'",
        params![if include_dividends_in_cost {
            "true"
        } else {
            "false"
        }],
    )?;
    get_settings(conn)
}

/// Read one arbitrary settings key. Missing keys are not an error, so new
/// features (such as saved import mappings) never need a schema migration.
pub fn get_setting_value(conn: &Connection, key: &str) -> Result<Option<String>> {
    let mut statement = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
    let mut rows = statement.query(params![key])?;
    match rows.next()? {
        Some(row) => Ok(Some(row.get(0)?)),
        None => Ok(None),
    }
}

pub fn set_setting_value(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// User-facing preferences that are not accounting inputs. `lastAutoBackupDay`
/// is scheduler bookkeeping and deliberately not part of this struct, so a
/// settings save can never invent a backup date.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Preferences {
    pub reminder_lead_days: i64,
    pub auto_backup_enabled: bool,
    pub auto_backup_keep: u32,
}

pub const DEFAULT_REMINDER_LEAD_DAYS: i64 = 7;
pub const DEFAULT_AUTO_BACKUP_KEEP: u32 = 7;
pub const LAST_AUTO_BACKUP_DAY: &str = "lastAutoBackupDay";

impl Default for Preferences {
    fn default() -> Self {
        Self {
            reminder_lead_days: DEFAULT_REMINDER_LEAD_DAYS,
            auto_backup_enabled: true,
            auto_backup_keep: DEFAULT_AUTO_BACKUP_KEEP,
        }
    }
}

pub fn get_preferences(conn: &Connection) -> Result<Preferences> {
    let defaults = Preferences::default();
    let reminder_lead_days = match get_setting_value(conn, "reminderLeadDays")? {
        Some(value) => value
            .parse::<i64>()
            .with_context(|| format!("invalid persisted reminderLeadDays `{value}`"))?,
        None => defaults.reminder_lead_days,
    };
    if !(0..=60).contains(&reminder_lead_days) {
        bail!("提醒提前天数必须在 0 到 60 之间");
    }
    let auto_backup_enabled = match get_setting_value(conn, "autoBackupEnabled")? {
        Some(value) => match value.as_str() {
            "true" => true,
            "false" => false,
            _ => bail!("已保存的自动备份开关无效 `{value}`"),
        },
        None => defaults.auto_backup_enabled,
    };
    let auto_backup_keep = match get_setting_value(conn, "autoBackupKeep")? {
        Some(value) => value
            .parse::<u32>()
            .with_context(|| format!("invalid persisted autoBackupKeep `{value}`"))?,
        None => defaults.auto_backup_keep,
    };
    if !(1..=100).contains(&auto_backup_keep) {
        bail!("自动备份保留数量必须在 1 到 100 之间");
    }
    Ok(Preferences {
        reminder_lead_days,
        auto_backup_enabled,
        auto_backup_keep,
    })
}

pub fn set_preferences(conn: &Connection, preferences: Preferences) -> Result<Preferences> {
    if !(0..=60).contains(&preferences.reminder_lead_days) {
        bail!("提醒提前天数必须在 0 到 60 之间");
    }
    if !(1..=100).contains(&preferences.auto_backup_keep) {
        bail!("自动备份保留数量必须在 1 到 100 之间");
    }
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    set_setting_value(
        &tx,
        "reminderLeadDays",
        &preferences.reminder_lead_days.to_string(),
    )?;
    set_setting_value(
        &tx,
        "autoBackupEnabled",
        if preferences.auto_backup_enabled {
            "true"
        } else {
            "false"
        },
    )?;
    set_setting_value(
        &tx,
        "autoBackupKeep",
        &preferences.auto_backup_keep.to_string(),
    )?;
    tx.commit()?;
    Ok(preferences)
}

pub fn get_last_auto_backup_day(conn: &Connection) -> Result<Option<String>> {
    get_setting_value(conn, LAST_AUTO_BACKUP_DAY)
}

pub fn set_last_auto_backup_day(conn: &Connection, day: &str) -> Result<()> {
    set_setting_value(conn, LAST_AUTO_BACKUP_DAY, day)
}

pub fn ensure_account(conn: &Connection, id: &str, name: &str) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO accounts (id, name, broker, currency, created_at)
         VALUES (?1, ?2, NULL, 'USD', ?3)",
        params![id, name, format_date(today())],
    )?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountRecord {
    pub id: String,
    pub name: String,
    pub broker: Option<String>,
    pub currency: String,
    pub created_at: String,
    pub archived_at: Option<String>,
    pub event_count: usize,
}

pub fn list_accounts(conn: &Connection) -> Result<Vec<AccountRecord>> {
    let mut statement = conn.prepare(
        "SELECT a.id, a.name, a.broker, a.currency, a.created_at, a.archived_at,
                (SELECT COUNT(*) FROM events e WHERE e.account_id = a.id)
         FROM accounts a ORDER BY a.created_at, a.name, a.id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(AccountRecord {
            id: row.get(0)?,
            name: row.get(1)?,
            broker: row.get(2)?,
            currency: row.get(3)?,
            created_at: row.get(4)?,
            archived_at: row.get(5)?,
            event_count: row.get::<_, i64>(6)? as usize,
        })
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .context("无法读取账户列表")
}

pub fn account_record(conn: &Connection, id: &str) -> Result<Option<AccountRecord>> {
    Ok(list_accounts(conn)?
        .into_iter()
        .find(|account| account.id == id))
}

pub fn count_active_accounts(conn: &Connection) -> Result<usize> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM accounts WHERE archived_at IS NULL",
        [],
        |row| row.get::<_, i64>(0),
    )? as usize)
}

pub fn set_account_archived(conn: &Connection, id: &str, archived: bool) -> Result<bool> {
    let archived_at = if archived {
        Some(format_date(today()))
    } else {
        None
    };
    let changed = conn
        .execute(
            "UPDATE accounts SET archived_at = ?2 WHERE id = ?1",
            params![id, archived_at],
        )
        .with_context(|| format!("cannot archive account `{id}`"))?;
    Ok(changed > 0)
}

pub fn delete_account(conn: &Connection, id: &str) -> Result<bool> {
    let changed = conn
        .execute("DELETE FROM accounts WHERE id = ?1", params![id])
        .with_context(|| format!("cannot delete account `{id}`"))?;
    Ok(changed > 0)
}

pub fn insert_account(conn: &Connection, id: &str, name: &str, created_at: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO accounts (id, name, broker, currency, created_at)
         VALUES (?1, ?2, NULL, 'USD', ?3)",
        params![id, name, created_at],
    )
    .with_context(|| format!("cannot create account `{id}`"))?;
    Ok(())
}

pub fn rename_account(conn: &Connection, id: &str, name: &str) -> Result<bool> {
    let changed = conn
        .execute(
            "UPDATE accounts SET name = ?2 WHERE id = ?1",
            params![id, name],
        )
        .with_context(|| format!("cannot rename account `{id}`"))?;
    Ok(changed > 0)
}

pub fn account_exists(conn: &Connection, id: &str) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM accounts WHERE id = ?1)",
        params![id],
        |row| row.get::<_, bool>(0),
    )?)
}

pub fn account_name_taken(conn: &Connection, name: &str, exclude_id: Option<&str>) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM accounts
            WHERE lower(name) = lower(?1) AND (?2 IS NULL OR id <> ?2)
         )",
        params![name.trim(), exclude_id],
        |row| row.get::<_, bool>(0),
    )?)
}

/// Ledger dates are US trading dates. The app has no timezone database, so the
/// current US Eastern date is derived from the current UTC instant using the
/// post-2007 DST rules: second Sunday in March 07:00 UTC through first Sunday
/// in November 06:00 UTC.
pub fn today() -> Date {
    eastern_date(time::OffsetDateTime::now_utc())
}

/// Timestamps that are not trading dates (for example the once-per-day
/// automatic backup marker) stay on UTC.
pub fn utc_today() -> Date {
    time::OffsetDateTime::now_utc().date()
}

fn eastern_date(now: time::OffsetDateTime) -> Date {
    let offset = if is_us_eastern_dst(now) {
        time::UtcOffset::from_hms(-4, 0, 0).expect("valid UTC offset")
    } else {
        time::UtcOffset::from_hms(-5, 0, 0).expect("valid UTC offset")
    };
    now.to_offset(offset).date()
}

fn is_us_eastern_dst(now: time::OffsetDateTime) -> bool {
    let year = now.year();
    let start = nth_weekday(year, time::Month::March, time::Weekday::Sunday, 2)
        .with_hms(7, 0, 0)
        .expect("valid DST start time")
        .assume_utc();
    let end = nth_weekday(year, time::Month::November, time::Weekday::Sunday, 1)
        .with_hms(6, 0, 0)
        .expect("valid DST end time")
        .assume_utc();
    now >= start && now < end
}

fn nth_weekday(
    year: i32,
    month: time::Month,
    weekday: time::Weekday,
    occurrence: u8,
) -> Date {
    let first = Date::from_calendar_date(year, month, 1).expect("valid first of month");
    let delta = (weekday.number_days_from_monday() + 7
        - first.weekday().number_days_from_monday())
        % 7;
    Date::from_calendar_date(year, month, 1 + delta + 7 * (occurrence - 1))
        .expect("valid nth weekday")
}

pub fn parse_date(value: &str) -> Result<Date> {
    Date::parse(value, format_description!("[year]-[month]-[day]"))
        .with_context(|| format!("日期 `{value}` 格式无效，应为 YYYY-MM-DD"))
}

pub fn format_date(date: Date) -> String {
    date.format(format_description!("[year]-[month]-[day]"))
        .unwrap_or_else(|_| date.to_string())
}

pub fn list_events(conn: &Connection, account_id: &str) -> Result<Vec<Event>> {
    let mut stmt = conn.prepare(
        "SELECT id, seq, occurred_at, kind, symbol, expiry, strike, right, multiplier,
                qty, price, fees, amount, note,
                split_numerator, split_denominator, split_cash_in_lieu
         FROM events
         WHERE account_id = ?1 AND deleted_at IS NULL
         ORDER BY occurred_at, seq",
    )?;

    let rows = stmt.query_map(params![account_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, Option<f64>>(6)?,
            row.get::<_, Option<String>>(7)?,
            row.get::<_, Option<i64>>(8)?,
            row.get::<_, i64>(9)?,
            row.get::<_, f64>(10)?,
            row.get::<_, f64>(11)?,
            row.get::<_, f64>(12)?,
            row.get::<_, String>(13)?,
            row.get::<_, Option<i64>>(14)?,
            row.get::<_, Option<i64>>(15)?,
            row.get::<_, Option<f64>>(16)?,
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
            multiplier,
            qty,
            price,
            fees,
            amount,
            note,
            split_numerator,
            split_denominator,
            split_cash_in_lieu,
        ) = row?;
        let split = match (split_numerator, split_denominator) {
            (Some(numerator), Some(denominator)) => Some(SplitTerms {
                numerator: u32::try_from(numerator).context("拆股分子无效")?,
                denominator: u32::try_from(denominator).context("拆股分母无效")?,
                cash_in_lieu: split_cash_in_lieu,
            }),
            _ => None,
        };
        let contract = match (expiry, strike, right) {
            (Some(expiry), Some(strike), Some(right)) => Some(OptionContract {
                underlying: symbol.clone(),
                expiry: parse_date(&expiry)?,
                strike,
                right: parse_right(&right)?,
                multiplier: u32::try_from(multiplier.unwrap_or(100))
                    .context("每手股数无效")?,
            }),
            _ => None,
        };
        events.push(Event {
            account_id: account_id.to_string(),
            id,
            seq: u64::try_from(seq).context("交易序号无效")?,
            occurred_at: parse_date(&occurred_at)?,
            kind: parse_kind(&kind)?,
            symbol,
            contract,
            qty: u32::try_from(qty).context("交易数量无效")?,
            price,
            fees,
            amount,
            split,
            note,
        });
    }
    Ok(events)
}

/// Read one live event by id, including events outside the current account view.
pub fn get_event(conn: &Connection, event_id: &str) -> Result<Option<Event>> {
    let account_id: Option<String> = conn
        .query_row(
            "SELECT account_id FROM events WHERE id = ?1 AND deleted_at IS NULL",
            params![event_id],
            |row| row.get(0),
        )
        .optional()?;
    match account_id {
        Some(account_id) => Ok(list_events(conn, &account_id)?
            .into_iter()
            .find(|event| event.id == event_id)),
        None => Ok(None),
    }
}

pub fn insert_event(conn: &Connection, event: &Event) -> Result<()> {
    insert_events(conn, std::slice::from_ref(event))
}

/// Validate every account's complete proposed history before writing any batch leg.
pub fn insert_events(conn: &Connection, batch: &[Event]) -> Result<()> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let mut histories: HashMap<&str, Vec<Event>> = HashMap::new();
    for event in batch {
        validate_event(event)?;
        if !histories.contains_key(event.account_id.as_str()) {
            histories.insert(&event.account_id, list_events(&tx, &event.account_id)?);
        }
        histories
            .get_mut(event.account_id.as_str())
            .unwrap()
            .push(event.clone());
    }
    for (account, events) in histories {
        replay_checked(account, &events, get_settings(&tx)?)?;
    }
    for event in batch {
        write_event(&tx, event)?;
    }
    tx.commit()?;
    Ok(())
}

fn contract_columns(event: &Event) -> (Option<String>, Option<f64>, Option<String>, Option<i64>) {
    match &event.contract {
        Some(contract) => (
            Some(format_date(contract.expiry)),
            Some(contract.strike),
            Some(contract.right.as_str().to_string()),
            Some(contract.multiplier as i64),
        ),
        None => (None, None, None, None),
    }
}

fn split_columns(event: &Event) -> (Option<i64>, Option<i64>, Option<f64>) {
    match event.split {
        Some(terms) => (
            Some(i64::from(terms.numerator)),
            Some(i64::from(terms.denominator)),
            terms.cash_in_lieu,
        ),
        None => (None, None, None),
    }
}

fn write_event(conn: &Connection, event: &Event) -> Result<()> {
    let (expiry, strike, right, multiplier) = contract_columns(event);
    let (split_numerator, split_denominator, split_cash_in_lieu) = split_columns(event);

    conn.execute(
        "INSERT INTO events (id, account_id, seq, occurred_at, kind, symbol, expiry, strike,
                             right, multiplier, qty, price, fees, amount, note, created_at,
                             split_numerator, split_denominator, split_cash_in_lieu)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                 ?17, ?18, ?19)",
        params![
            event.id,
            event.account_id,
            event.seq as i64,
            format_date(event.occurred_at),
            kind_to_str(event.kind),
            event.symbol,
            expiry,
            strike,
            right,
            multiplier,
            event.qty as i64,
            event.price,
            event.fees,
            event.amount,
            event.note,
            format_date(today()),
            split_numerator,
            split_denominator,
            split_cash_in_lieu,
        ],
    )
    .context("写入交易")?;
    Ok(())
}

/// Replace one live event's fields while keeping its id, sequence and account.
/// The account history is replayed before the row is written, so an edit that
/// would invalidate later events is refused and the database stays unchanged.
pub fn update_event(conn: &Connection, event: &Event) -> Result<bool> {
    validate_event(event)?;
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let account_id: Option<String> = tx
        .query_row(
            "SELECT account_id FROM events WHERE id = ?1 AND deleted_at IS NULL",
            params![event.id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(account_id) = account_id else {
        return Ok(false);
    };
    if account_id != event.account_id {
        bail!("不能把交易改到其他账户");
    }
    let mut events = list_events(&tx, &account_id)?;
    let Some(current) = events.iter_mut().find(|current| current.id == event.id) else {
        return Ok(false);
    };
    *current = event.clone();
    replay_checked(&account_id, &events, get_settings(&tx)?)
        .context("修改后的事件历史无效；如果后续交易依赖这条记录，请先撤销后续交易")?;

    let (expiry, strike, right, multiplier) = contract_columns(event);
    let (split_numerator, split_denominator, split_cash_in_lieu) = split_columns(event);
    tx.execute(
        "UPDATE events
         SET occurred_at = ?2, kind = ?3, symbol = ?4, expiry = ?5, strike = ?6,
             right = ?7, multiplier = ?8, qty = ?9, price = ?10, fees = ?11,
             amount = ?12, note = ?13, split_numerator = ?14,
             split_denominator = ?15, split_cash_in_lieu = ?16
         WHERE id = ?1 AND deleted_at IS NULL",
        params![
            event.id,
            format_date(event.occurred_at),
            kind_to_str(event.kind),
            event.symbol,
            expiry,
            strike,
            right,
            multiplier,
            event.qty as i64,
            event.price,
            event.fees,
            event.amount,
            event.note,
            split_numerator,
            split_denominator,
            split_cash_in_lieu,
        ],
    )
    .context("修改交易")?;
    tx.commit()?;
    Ok(true)
}

/// Validate the remaining history before retaining a tombstone for audit/sequence identity.
pub fn delete_event(conn: &Connection, event_id: &str) -> Result<bool> {
    Ok(delete_events(conn, std::slice::from_ref(&event_id.to_string()))? > 0)
}

/// Soft-delete several events atomically. This is used by whole-import undo:
/// either every requested event is removed and the remaining histories replay,
/// or nothing changes.
pub fn delete_events(conn: &Connection, event_ids: &[String]) -> Result<usize> {
    if event_ids.is_empty() {
        return Ok(0);
    }
    let requested: std::collections::BTreeSet<&str> =
        event_ids.iter().map(String::as_str).collect();
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let mut accounts = std::collections::BTreeSet::new();
    let mut found = Vec::new();
    {
        let mut statement = tx.prepare("SELECT id, account_id FROM events WHERE deleted_at IS NULL")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (id, account) = row?;
            if requested.contains(id.as_str()) {
                accounts.insert(account);
                found.push(id);
            }
        }
    }
    if found.is_empty() {
        return Ok(0);
    }
    let found_set: std::collections::BTreeSet<String> = found.iter().cloned().collect();
    for account in &accounts {
        let mut remaining = list_events(&tx, account)?;
        remaining.retain(|event| !found_set.contains(&event.id));
        replay_checked(account, &remaining, get_settings(&tx)?)
            .context("撤销后的事件历史无效")?;
    }
    let stamp = time::OffsetDateTime::now_utc().to_string();
    for id in &found {
        tx.execute(
            "UPDATE events SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
            params![id, &stamp],
        )?;
    }
    tx.commit()?;
    Ok(found.len())
}

pub fn replay_checked(
    account_id: &str,
    events: &[Event],
    settings: Settings,
) -> Result<DerivedState> {
    for event in events {
        validate_event(event)?;
    }
    // The core uses u32 quantities internally; prevent accumulation/multiplication overflow.
    let mut quantities: HashMap<&str, u64> = HashMap::new();
    for event in events {
        let units =
            u64::from(event.qty) * u64::from(event.contract.as_ref().map_or(1, |c| c.multiplier));
        let total = quantities.entry(&event.symbol).or_default();
        *total = total.checked_add(units).context("数量溢出")?;
        if *total > u64::from(u32::MAX) {
            bail!("数量超出支持范围");
        }
    }
    let derived = replay(account_id, events, settings).context("事件回放失败")?;
    let issues = derived.check_invariants();
    if !issues.is_empty() {
        bail!("账本回放一致性检查失败：{}", issues.join("; "));
    }
    if derived.campaigns.iter().any(|c| {
        [
            c.cost_total,
            c.premium_open,
            c.premium_realized,
            c.cash_flow,
            c.share_pnl,
            c.dividends,
            c.adjustments,
        ]
        .iter()
        .any(|v| !v.is_finite())
    }) {
        bail!("账本回放产生了无效的财务数值");
    }
    if derived.campaigns.iter().any(|c| {
        c.realized_pnl.is_some_and(|v| !v.is_finite())
            || c.cost_points.iter().any(|p| {
                [
                    p.cost_a,
                    p.cost_b,
                    p.cost_c,
                    p.cost_total,
                    p.premium_realized,
                    p.premium_open,
                    p.dividends,
                ]
                .iter()
                .any(|v| !v.is_finite())
            })
    }) {
        bail!("账本回放产生了无效的成本或已实现盈亏");
    }
    Ok(derived)
}

pub fn validate_event(event: &Event) -> Result<()> {
    let cash_transfer = event.kind.is_cash_transfer();
    if event.id.trim().is_empty() || event.account_id.trim().is_empty() {
        bail!("事件编号和账户不能为空");
    }
    if !cash_transfer && event.symbol.trim().is_empty() {
        bail!("标的代码不能为空");
    }
    if event.seq == 0 || event.seq > i64::MAX as u64 {
        bail!("交易序号无效");
    }
    if !event.price.is_finite()
        || event.price < 0.0
        || !event.fees.is_finite()
        || event.fees < 0.0
        || !event.amount.is_finite()
    {
        bail!("价格与费用必须为有限的非负数，金额必须为有限数");
    }
    if cash_transfer {
        if !event.symbol.trim().is_empty() {
            bail!("入金 / 出金是账户级交易，不能填写标的");
        }
        if event.contract.is_some()
            || event.qty != 0
            || event.price != 0.0
            || event.fees != 0.0
            || event.split.is_some()
        {
            bail!("入金 / 出金不能携带合约、数量、价格、费用或拆股信息");
        }
        if event.amount <= 0.0 {
            bail!("入金 / 出金金额必须大于 0");
        }
        return Ok(());
    }
    if matches!(event.kind, EventKind::Split) {
        if event.contract.is_some()
            || event.qty != 0
            || event.price != 0.0
            || event.fees != 0.0
            || event.amount != 0.0
        {
            bail!("拆股事件不能携带合约、数量、价格、费用或金额");
        }
        let Some(terms) = event.split else {
            bail!("拆股事件缺少拆股比例");
        };
        if terms.numerator == 0
            || terms.denominator == 0
            || terms.numerator > 1_000_000
            || terms.denominator > 1_000_000
        {
            bail!("拆股比例的分子与分母必须在 1 到 1,000,000 之间");
        }
        if let Some(cash) = terms.cash_in_lieu {
            if !cash.is_finite() || cash < 0.0 {
                bail!("零股现金补偿必须为有限的非负数");
            }
        }
        return Ok(());
    }
    if event.split.is_some() {
        bail!("只有拆股事件可以携带拆股比例");
    }
    if !matches!(event.kind, EventKind::Fee | EventKind::Adjustment) && event.qty == 0 {
        bail!("交易数量必须大于 0");
    }
    if matches!(event.kind, EventKind::Fee) && event.amount < 0.0 {
        bail!("费用金额不能为负数");
    }
    if matches!(event.kind, EventKind::SharesBuy | EventKind::SharesSell) && event.price <= 0.0 {
        bail!("股票成交价必须大于 0");
    }
    if matches!(event.kind, EventKind::Option(_)) && event.contract.is_none() {
        bail!("期权交易需要填写到期日、行权价和方向");
    }
    if let Some(contract) = &event.contract {
        if !contract.strike.is_finite()
            || contract.strike <= 0.0
            || contract.multiplier == 0
            || contract.underlying != event.symbol
        {
            bail!("期权合约信息无效");
        }
        let shares = f64::from(contract.multiplier) * f64::from(event.qty);
        if !(contract.strike * shares).is_finite() || !(event.price * shares).is_finite() {
            bail!("期权名义金额超出支持范围");
        }
    }
    Ok(())
}

pub fn next_seq(conn: &Connection, account_id: &str) -> Result<u64> {
    let max: Option<i64> = conn.query_row(
        "SELECT MAX(seq) FROM events WHERE account_id = ?1",
        params![account_id],
        |row| row.get(0),
    )?;
    Ok(max.unwrap_or(0) as u64 + 1)
}

pub fn upsert_price(conn: &Connection, symbol: &str, date: Date, close: f64) -> Result<()> {
    if symbol.trim().is_empty() {
        bail!("标的代码不能为空");
    }
    if !close.is_finite() || close <= 0.0 {
        bail!("行情价格必须为有限且大于 0 的数");
    }
    conn.execute(
        "INSERT INTO prices (symbol, date, close, source, quoted_at) VALUES (?1, ?2, ?3, '手动', NULL)
         ON CONFLICT(symbol, date) DO UPDATE SET close = excluded.close, source = '手动', quoted_at = NULL",
        params![symbol, format_date(date), close],
    )?;
    Ok(())
}

/// Snapshot the complete SQLite database, including soft-deleted audit history.
/// Reserve a new empty file first: VACUUM INTO accepts empty files, while create_new
/// prevents us from using any target that was already present.
pub fn backup_to(conn: &Connection, path: &Path) -> Result<()> {
    let target = path.to_str().context("backup path is not valid Unicode")?;
    let reserved = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .with_context(|| format!("cannot create new backup at {}", path.display()))?;
    drop(reserved);
    if let Err(error) = conn.execute("VACUUM INTO ?1", params![target]) {
        let _ = std::fs::remove_file(path);
        return Err(error).context("create SQLite backup snapshot");
    }
    Ok(())
}

pub fn latest_prices(conn: &Connection) -> Result<HashMap<String, f64>> {
    let mut stmt = conn.prepare(
        "SELECT p.symbol, p.close
         FROM prices p
         JOIN (SELECT symbol, MAX(date) AS last_date FROM prices GROUP BY symbol) latest
           ON latest.symbol = p.symbol AND latest.last_date = p.date",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
    })?;
    let mut prices = HashMap::new();
    for row in rows {
        let (symbol, close) = row?;
        prices.insert(symbol, close);
    }
    Ok(prices)
}

pub fn list_prices(conn: &Connection) -> Result<Vec<crate::views::PriceView>> {
    let mut stmt = conn.prepare(
        "SELECT symbol, date, close, source, quoted_at FROM prices ORDER BY date DESC, symbol ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(crate::views::PriceView {
            symbol: row.get(0)?,
            date: row.get(1)?,
            close: row.get(2)?,
            source: row.get(3)?,
            quoted_at: row.get(4)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// An explicit refresh may replace a manual quote on the same date. Automatic
/// quotes can only advance the provider timestamp, including concurrent refreshes.
pub fn upsert_market_quote(
    conn: &Connection,
    quote: &crate::views::MarketQuote,
) -> Result<crate::views::PriceView> {
    if crate::market::normalize_symbol(&quote.symbol).map_err(anyhow::Error::msg)? != quote.symbol
        || quote.currency != "USD"
        || quote.source != crate::market::SOURCE
        || !quote.price.is_finite()
        || quote.price <= 0.0
    {
        bail!("自动行情数据无效");
    }
    crate::market::validate_timestamp(&quote.quoted_at).map_err(anyhow::Error::msg)?;
    let date = &quote.quoted_at[..10];
    parse_date(date)?;
    let changed = conn.execute(
        "INSERT INTO prices (symbol, date, close, source, quoted_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(symbol, date) DO UPDATE SET close = excluded.close, source = excluded.source, quoted_at = excluded.quoted_at
         WHERE prices.quoted_at IS NULL OR prices.source = '手动' OR prices.quoted_at <= excluded.quoted_at",
        params![quote.symbol, date, quote.price, quote.source, quote.quoted_at],
    )?;
    if changed == 0 {
        bail!("行情时间早于已保存的自动行情，已保留较新价格");
    }
    Ok(crate::views::PriceView {
        symbol: quote.symbol.clone(),
        date: date.into(),
        close: quote.price,
        source: quote.source.clone(),
        quoted_at: Some(quote.quoted_at.clone()),
    })
}

pub fn count_events(conn: &Connection, account_id: &str) -> Result<usize> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM events WHERE account_id = ?1 AND deleted_at IS NULL",
        params![account_id],
        |row| row.get(0),
    )?;
    Ok(count as usize)
}

fn parse_right(value: &str) -> Result<Right> {
    match value {
        "P" => Ok(Right::Put),
        "C" => Ok(Right::Call),
        other => bail!("未知的期权方向 `{other}`"),
    }
}

pub fn kind_to_str(kind: EventKind) -> &'static str {
    match kind {
        EventKind::Option(OptionAction::OpenShort) => "option_open_short",
        EventKind::Option(OptionAction::Close) => "option_close",
        EventKind::Option(OptionAction::Expire) => "option_expire",
        EventKind::Option(OptionAction::Assign) => "option_assign",
        EventKind::SharesBuy => "shares_buy",
        EventKind::SharesSell => "shares_sell",
        EventKind::Dividend => "dividend",
        EventKind::Fee => "fee",
        EventKind::Adjustment => "adjustment",
        EventKind::Split => "stock_split",
        EventKind::CashDeposit => "cash_deposit",
        EventKind::CashWithdrawal => "cash_withdrawal",
    }
}

fn parse_kind(value: &str) -> Result<EventKind> {
    match value {
        "option_open_short" => Ok(EventKind::Option(OptionAction::OpenShort)),
        "option_close" => Ok(EventKind::Option(OptionAction::Close)),
        "option_expire" => Ok(EventKind::Option(OptionAction::Expire)),
        "option_assign" => Ok(EventKind::Option(OptionAction::Assign)),
        "shares_buy" => Ok(EventKind::SharesBuy),
        "shares_sell" => Ok(EventKind::SharesSell),
        "dividend" => Ok(EventKind::Dividend),
        "fee" => Ok(EventKind::Fee),
        "adjustment" => Ok(EventKind::Adjustment),
        "stock_split" => Ok(EventKind::Split),
        "cash_deposit" => Ok(EventKind::CashDeposit),
        "cash_withdrawal" => Ok(EventKind::CashWithdrawal),
        other => bail!("未知的交易类型 `{other}`"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        initialize(&conn).unwrap();
        conn
    }
    fn at() -> Date {
        parse_date("2026-01-02").unwrap()
    }
    fn buy(id: &str, seq: u64) -> Event {
        Event::buy_shares("main", id, seq, at(), "AAPL", 100, 150.0, 1.0)
    }
    fn contract(strike: f64) -> OptionContract {
        OptionContract::new(
            "AAPL",
            parse_date("2026-02-20").unwrap(),
            strike,
            Right::Put,
        )
    }

    #[test]
    fn settings_persist_across_reopen_and_initialize_is_idempotent() {
        let path = std::env::temp_dir().join(format!(
            "wheel-settings-{}-{}.sqlite",
            std::process::id(),
            time::OffsetDateTime::now_utc().unix_timestamp_nanos()
        ));
        {
            let conn = open(&path).unwrap();
            assert!(!get_settings(&conn).unwrap().include_dividends_in_cost);
            set_settings(&conn, true).unwrap();
            initialize(&conn).unwrap();
            assert!(get_settings(&conn).unwrap().include_dividends_in_cost);
        }
        {
            let conn = open(&path).unwrap();
            assert!(get_settings(&conn).unwrap().include_dividends_in_cost);
            set_settings(&conn, false).unwrap();
        }
        {
            let conn = open(&path).unwrap();
            assert!(!get_settings(&conn).unwrap().include_dividends_in_cost);
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn corrupt_settings_are_rejected_without_overwrite() {
        let conn = db();
        for value in ["TRUE", "1", "0", "null", "", "garbage"] {
            conn.execute("UPDATE settings SET value = ?1", params![value])
                .unwrap();
            assert!(get_settings(&conn)
                .unwrap_err()
                .to_string()
                .contains("已保存的分红成本设置无效"));
            assert!(set_settings(&conn, true).is_err());
            assert!(insert_event(&conn, &buy("buy", 1)).is_err());
            assert_eq!(count_events(&conn, "main").unwrap(), 0);
            initialize(&conn).unwrap();
            assert!(get_settings(&conn).is_err());
        }
    }

    #[test]
    fn replay_rejection_leaves_rows_and_sequence_unchanged() {
        let conn = db();
        insert_event(&conn, &buy("buy", 1)).unwrap();
        let invalid = Event::sell_shares("main", "oversell", 2, at(), "AAPL", 101, 160.0, 0.0);
        assert!(insert_event(&conn, &invalid).is_err());
        assert_eq!(count_events(&conn, "main").unwrap(), 1);
        assert_eq!(next_seq(&conn, "main").unwrap(), 2);
        assert!(insert_event(&conn, &buy("duplicate-sequence", 1)).is_err());
        insert_event(&conn, &buy("valid", 2)).unwrap();
        assert_eq!(count_events(&conn, "main").unwrap(), 2);
    }

    #[test]
    fn invalid_second_roll_leg_rolls_back_the_entire_batch() {
        let conn = db();
        let open = Event::sell_option("main", "open", 1, at(), contract(150.0), 1, 2.0, 0.0);
        insert_event(&conn, &open).unwrap();
        let close = Event::close_option("main", "close", 2, at(), contract(150.0), 1, 1.0, 0.0);
        let invalid = Event::close_option("main", "invalid", 3, at(), contract(140.0), 1, 1.0, 0.0);
        assert!(insert_events(&conn, &[close.clone(), invalid]).is_err());
        assert_eq!(list_events(&conn, "main").unwrap(), vec![open.clone()]);
        assert_eq!(next_seq(&conn, "main").unwrap(), 2);
        // Even a SQL error on the second insert must roll back the first insert.
        let duplicate_seq =
            Event::sell_option("main", "new", 2, at(), contract(140.0), 1, 2.0, 0.0);
        assert!(insert_events(&conn, &[close.clone(), duplicate_seq]).is_err());
        assert_eq!(list_events(&conn, "main").unwrap(), vec![open]);
        let replacement = Event::sell_option("main", "new", 3, at(), contract(140.0), 1, 2.0, 0.0);
        insert_events(&conn, &[close, replacement]).unwrap();
        assert_eq!(count_events(&conn, "main").unwrap(), 3);
    }

    #[test]
    fn derived_invariants_are_rejected_even_when_replay_succeeds() {
        let conn = db();
        let large = Event::sell_option("main", "large", 1, at(), contract(150.0), 1, 1e16, 0.0);
        let small = Event::sell_option("main", "small", 2, at(), contract(140.0), 1, 1.0, 0.0);
        insert_event(&conn, &large).unwrap();
        insert_event(&conn, &small).unwrap();
        let close = Event::close_option("main", "close", 3, at(), contract(150.0), 1, 0.0, 0.0);
        let derived = replay("main", &[large, small, close.clone()], Settings::default()).unwrap();
        assert!(!derived.check_invariants().is_empty());
        assert!(insert_event(&conn, &close)
            .unwrap_err()
            .to_string()
            .contains("一致性"));
        assert_eq!(count_events(&conn, "main").unwrap(), 2);
        assert_eq!(next_seq(&conn, "main").unwrap(), 3);
    }

    #[test]
    fn soft_delete_preserves_rows_sequences_and_dependencies() {
        let conn = db();
        insert_event(&conn, &buy("buy", 1)).unwrap();
        let sell = Event::sell_shares("main", "sell", 2, at(), "AAPL", 100, 160.0, 0.0);
        insert_event(&conn, &sell).unwrap();
        assert!(delete_event(&conn, "buy").is_err());
        assert_eq!(count_events(&conn, "main").unwrap(), 2);
        assert!(delete_event(&conn, "sell").unwrap());
        assert!(!delete_event(&conn, "sell").unwrap());
        assert!(!delete_event(&conn, "missing").unwrap());
        initialize(&conn).unwrap();
        assert_eq!(list_events(&conn, "main").unwrap(), vec![buy("buy", 1)]);
        assert_eq!(next_seq(&conn, "main").unwrap(), 3);
        let (count, deleted): (i64, i64) = conn
            .query_row("SELECT COUNT(*), COUNT(deleted_at) FROM events", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!((count, deleted), (2, 1));
        assert!(delete_event(&conn, "buy").unwrap());
        assert_eq!(count_events(&conn, "main").unwrap(), 0);
        assert_eq!(next_seq(&conn, "main").unwrap(), 3);
    }

    #[test]
    fn update_event_replaces_fields_without_changing_identity() {
        let conn = db();
        let original = buy("buy", 1);
        insert_event(&conn, &original).unwrap();
        let mut corrected = original.clone();
        corrected.price = 149.5;
        corrected.fees = 2.5;
        corrected.note = "修正成交价".to_string();
        assert!(update_event(&conn, &corrected).unwrap());
        assert_eq!(list_events(&conn, "main").unwrap(), vec![corrected]);
        assert_eq!(next_seq(&conn, "main").unwrap(), 2);
        assert!(!update_event(&conn, &buy("missing", 2)).unwrap());
    }

    #[test]
    fn update_event_refuses_to_break_later_dependencies() {
        let conn = db();
        insert_event(&conn, &buy("buy", 1)).unwrap();
        let sell = Event::sell_shares("main", "sell", 2, at(), "AAPL", 100, 160.0, 0.0);
        insert_event(&conn, &sell).unwrap();
        let mut oversell = buy("buy", 1);
        oversell.qty = 50;
        let failure = update_event(&conn, &oversell).unwrap_err();
        assert!(format!("{failure:#}").contains("修改后的事件历史无效"));
        assert_eq!(
            list_events(&conn, "main").unwrap(),
            vec![buy("buy", 1), sell]
        );
    }

    #[test]
    fn batch_delete_removes_dependent_events_together() {
        let conn = db();
        let open = Event::sell_option("main", "open", 1, at(), contract(150.0), 1, 2.0, 0.0);
        let close = Event::close_option("main", "close", 2, at(), contract(150.0), 1, 1.0, 0.0);
        insert_event(&conn, &open).unwrap();
        insert_event(&conn, &close).unwrap();
        assert!(delete_events(&conn, &["open".to_string()]).is_err());
        assert_eq!(
            delete_events(
                &conn,
                &["open".to_string(), "close".to_string(), "missing".to_string()]
            )
            .unwrap(),
            2
        );
        assert!(list_events(&conn, "main").unwrap().is_empty());
        assert_eq!(
            delete_events(&conn, &["open".to_string(), "close".to_string()]).unwrap(),
            0
        );
    }

    #[test]
    fn option_open_cannot_be_deleted_before_its_close() {
        let conn = db();
        let open = Event::sell_option("main", "open", 1, at(), contract(150.0), 1, 2.0, 0.0);
        let close = Event::close_option("main", "close", 2, at(), contract(150.0), 1, 1.0, 0.0);
        insert_event(&conn, &open).unwrap();
        insert_event(&conn, &close).unwrap();
        assert!(delete_event(&conn, "open").is_err());
        assert_eq!(count_events(&conn, "main").unwrap(), 2);
        assert!(delete_event(&conn, "close").unwrap());
        assert!(delete_event(&conn, "open").unwrap());
    }

    #[test]
    fn existing_schema_migration_retains_history_and_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            &SCHEMA
                .replace("  deleted_at   TEXT,\n", "")
                .replace(
                    "  split_numerator   INTEGER,\n  split_denominator INTEGER,\n  split_cash_in_lieu REAL,\n",
                    "",
                ),
        )
        .unwrap();
        conn.execute_batch("DROP TABLE settings;").unwrap();
        conn.execute(
            "INSERT INTO events (id,account_id,seq,occurred_at,kind,symbol,qty,price,created_at)
            VALUES ('legacy','main',7,'2026-01-02','shares_buy','AAPL',100,150,'2026-01-02')",
            [],
        )
        .unwrap();
        initialize(&conn).unwrap();
        initialize(&conn).unwrap();
        assert!(!get_settings(&conn).unwrap().include_dividends_in_cost);
        assert_eq!(count_events(&conn, "main").unwrap(), 1);
        assert_eq!(next_seq(&conn, "main").unwrap(), 8);
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let split_columns: (Option<i64>, Option<i64>, Option<f64>) = conn
            .query_row(
                "SELECT split_numerator, split_denominator, split_cash_in_lieu
                 FROM events WHERE id = 'legacy'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(split_columns, (None, None, None));
        assert!(list_events(&conn, "main").unwrap()[0].split.is_none());
        assert!(delete_event(&conn, "legacy").unwrap());
        initialize(&conn).unwrap();
        assert_eq!(count_events(&conn, "main").unwrap(), 0);
        assert_eq!(next_seq(&conn, "main").unwrap(), 8);
    }

    #[test]
    fn split_events_round_trip_and_reject_malformed_terms() {
        let conn = db();
        let split = Event::stock_split("main", "split", 1, at(), "AAPL", 2, 1, Some(3.5));
        insert_event(&conn, &split).unwrap();
        let events = list_events(&conn, "main").unwrap();
        assert_eq!(events, vec![split.clone()]);
        assert_eq!(
            events[0].split,
            Some(SplitTerms {
                numerator: 2,
                denominator: 1,
                cash_in_lieu: Some(3.5),
            })
        );
        assert_eq!(kind_to_str(split.kind), "stock_split");
        assert_eq!(parse_kind("stock_split").unwrap(), EventKind::Split);

        let mut with_qty = split.clone();
        with_qty.id = "bad-qty".into();
        with_qty.seq = 2;
        with_qty.qty = 1;
        assert!(insert_event(&conn, &with_qty).is_err());

        let contract = OptionContract::new(
            "AAPL",
            parse_date("2026-02-20").unwrap(),
            150.0,
            Right::Put,
        );
        let mut with_contract = split.clone();
        with_contract.id = "bad-contract".into();
        with_contract.seq = 2;
        with_contract.contract = Some(contract);
        assert!(insert_event(&conn, &with_contract).is_err());

        let mut zero_ratio = split.clone();
        zero_ratio.id = "zero-ratio".into();
        zero_ratio.seq = 2;
        zero_ratio.split = Some(SplitTerms {
            numerator: 0,
            denominator: 1,
            cash_in_lieu: None,
        });
        assert!(insert_event(&conn, &zero_ratio).is_err());

        let mut negative_cash = split.clone();
        negative_cash.id = "negative-cash".into();
        negative_cash.seq = 2;
        negative_cash.split = Some(SplitTerms {
            numerator: 2,
            denominator: 1,
            cash_in_lieu: Some(-1.0),
        });
        assert!(insert_event(&conn, &negative_cash).is_err());

        let mut misplaced = buy("misplaced", 2);
        misplaced.split = Some(SplitTerms {
            numerator: 2,
            denominator: 1,
            cash_in_lieu: None,
        });
        assert!(insert_event(&conn, &misplaced).is_err());

        assert_eq!(count_events(&conn, "main").unwrap(), 1);
    }

    #[test]
    fn newer_schema_is_refused_without_creating_tables() {
        let path = std::env::temp_dir().join(format!(
            "wheel-newer-schema-{}-{}.sqlite",
            std::process::id(),
            time::OffsetDateTime::now_utc().unix_timestamp_nanos()
        ));
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(&format!(
                "CREATE TABLE marker (value INTEGER); INSERT INTO marker VALUES (7);
                 PRAGMA user_version = {};",
                SCHEMA_VERSION + 1
            ))
            .unwrap();
        }
        let message = match open(&path) {
            Ok(_) => panic!("a newer schema must be refused"),
            Err(err) => err.to_string(),
        };
        assert!(message.contains("请升级应用"));
        let conn = Connection::open(&path).unwrap();
        let marker: i64 = conn
            .query_row("SELECT value FROM marker", [], |row| row.get(0))
            .unwrap();
        assert_eq!(marker, 7);
        let created: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'events'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(created, 0);
        drop(conn);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn backup_preserves_prices_audit_history_and_refuses_overwrite() {
        let conn = db();
        ensure_account(&conn, "main", "Test account").unwrap();
        insert_event(&conn, &buy("removed", 1)).unwrap();
        delete_event(&conn, "removed").unwrap();
        insert_event(&conn, &buy("active", 2)).unwrap();
        upsert_price(&conn, "AAPL", at(), 160.0).unwrap();
        set_settings(&conn, true).unwrap();
        let path = std::env::temp_dir().join(format!(
            "wheel-backup-test-{}-{}.sqlite",
            std::process::id(),
            time::OffsetDateTime::now_utc().unix_timestamp_nanos()
        ));
        backup_to(&conn, &path).unwrap();
        {
            let snapshot = Connection::open(&path).unwrap();
            assert!(get_settings(&snapshot).unwrap().include_dividends_in_cost);
            assert_eq!(count_events(&snapshot, "main").unwrap(), 1);
            assert_eq!(next_seq(&snapshot, "main").unwrap(), 3);
            assert_eq!(latest_prices(&snapshot).unwrap()["AAPL"], 160.0);
            let deleted: i64 = snapshot
                .query_row(
                    "SELECT COUNT(*) FROM events WHERE deleted_at IS NOT NULL",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(deleted, 1);
            assert_eq!(list_events(&snapshot, "main").unwrap()[0].id, "active");
        }
        let original = std::fs::read(&path).unwrap();
        assert!(backup_to(&conn, &path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), original);
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn legacy_prices_migrate_and_metadata_survives_reopen() {
        let path = std::env::temp_dir().join(format!(
            "wheel-quote-{}-{}.sqlite",
            std::process::id(),
            time::OffsetDateTime::now_utc().unix_timestamp_nanos()
        ));
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch("CREATE TABLE prices (symbol TEXT NOT NULL,date TEXT NOT NULL,close REAL NOT NULL,PRIMARY KEY(symbol,date)); INSERT INTO prices VALUES ('AAPL','2026-01-02',150);").unwrap();
            initialize(&conn).unwrap();
            initialize(&conn).unwrap();
            let prices = list_prices(&conn).unwrap();
            assert_eq!(prices[0].source, "手动");
            assert!(prices[0].quoted_at.is_none());
            upsert_market_quote(&conn, &test_quote("AAPL", "2026-01-02 16:00:00", 155.0)).unwrap();
        }
        {
            let conn = open(&path).unwrap();
            let prices = list_prices(&conn).unwrap();
            assert_eq!(prices[0].source, "腾讯财经");
            assert_eq!(prices[0].quoted_at.as_deref(), Some("2026-01-02 16:00:00"));
            assert_eq!(latest_prices(&conn).unwrap()["AAPL"], 155.0);
            upsert_price(&conn, "AAPL", at(), 160.0).unwrap();
        }
        {
            let conn = open(&path).unwrap();
            let price = list_prices(&conn).unwrap().remove(0);
            assert_eq!(price.source, "手动");
            assert!(price.quoted_at.is_none());
            assert_eq!(price.close, 160.0);
        }
        std::fs::remove_file(path).unwrap();
    }

    fn test_quote(symbol: &str, timestamp: &str, price: f64) -> crate::views::MarketQuote {
        crate::views::MarketQuote {
            symbol: symbol.into(),
            name: "Example".into(),
            price,
            previous_close: Some(150.0),
            change_percent: None,
            quoted_at: timestamp.into(),
            source: crate::market::SOURCE.into(),
            currency: "USD".into(),
        }
    }

    #[test]
    fn automatic_quotes_reject_older_timestamp_but_explicit_refresh_can_replace_manual() {
        let conn = db();
        let newer = test_quote("AAPL", "2026-01-02 16:00:00", 155.0);
        upsert_market_quote(&conn, &newer).unwrap();
        assert!(
            upsert_market_quote(&conn, &test_quote("AAPL", "2026-01-02 15:59:00", 151.0)).is_err()
        );
        assert_eq!(latest_prices(&conn).unwrap()["AAPL"], 155.0);
        upsert_price(&conn, "AAPL", at(), 160.0).unwrap();
        upsert_market_quote(&conn, &newer).unwrap();
        let following_day = parse_date("2026-01-03").unwrap();
        upsert_price(&conn, "AAPL", following_day, 170.0).unwrap();
        upsert_market_quote(&conn, &test_quote("AAPL", "2026-01-02 16:01:00", 156.0)).unwrap();
        assert_eq!(latest_prices(&conn).unwrap()["AAPL"], 170.0);
        assert_eq!(list_prices(&conn).unwrap().len(), 2);
    }

    #[test]
    fn invalid_quotes_do_not_replace_valid_price() {
        let conn = db();
        upsert_price(&conn, "AAPL", at(), 150.0).unwrap();
        for close in [0.0, -1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert!(upsert_price(&conn, "AAPL", at(), close).is_err());
        }
        assert!(upsert_price(&conn, " ", at(), 1.0).is_err());
        assert_eq!(latest_prices(&conn).unwrap()["AAPL"], 150.0);
    }

    #[test]
    fn setting_helpers_round_trip_and_missing_returns_none() {
        let conn = db();
        let key = "importMapping:v1:abcdef0123456789";
        assert_eq!(get_setting_value(&conn, key).unwrap(), None);
        set_setting_value(&conn, key, "{\"fields\":{}}").unwrap();
        assert_eq!(
            get_setting_value(&conn, key).unwrap().as_deref(),
            Some("{\"fields\":{}}")
        );
        set_setting_value(&conn, key, "{}").unwrap();
        assert_eq!(get_setting_value(&conn, key).unwrap().as_deref(), Some("{}"));
    }

    #[test]
    fn preferences_default_and_round_trip_across_reopen() {
        let path = std::env::temp_dir().join(format!(
            "wheel-preferences-{}-{}.sqlite",
            std::process::id(),
            time::OffsetDateTime::now_utc().unix_timestamp_nanos()
        ));
        let preferences = Preferences {
            reminder_lead_days: 14,
            auto_backup_enabled: false,
            auto_backup_keep: 3,
        };
        {
            let conn = open(&path).unwrap();
            assert_eq!(get_preferences(&conn).unwrap(), Preferences::default());
            assert_eq!(set_preferences(&conn, preferences).unwrap(), preferences);
        }
        {
            let conn = open(&path).unwrap();
            assert_eq!(get_preferences(&conn).unwrap(), preferences);
            set_preferences(&conn, Preferences::default()).unwrap();
        }
        {
            let conn = open(&path).unwrap();
            assert_eq!(get_preferences(&conn).unwrap(), Preferences::default());
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn invalid_preferences_are_rejected_without_partial_writes() {
        let conn = db();
        let original = Preferences {
            reminder_lead_days: 10,
            auto_backup_enabled: true,
            auto_backup_keep: 5,
        };
        set_preferences(&conn, original).unwrap();
        for invalid in [
            Preferences {
                reminder_lead_days: -1,
                ..original
            },
            Preferences {
                reminder_lead_days: 61,
                ..original
            },
            Preferences {
                auto_backup_keep: 0,
                ..original
            },
            Preferences {
                auto_backup_keep: 101,
                ..original
            },
        ] {
            assert!(set_preferences(&conn, invalid).is_err());
            assert_eq!(get_preferences(&conn).unwrap(), original);
        }
        set_setting_value(&conn, "autoBackupKeep", "many").unwrap();
        assert!(get_preferences(&conn).is_err());
        set_setting_value(&conn, "autoBackupKeep", "5").unwrap();
        set_setting_value(&conn, "reminderLeadDays", "7.5").unwrap();
        assert!(get_preferences(&conn).is_err());
        assert_eq!(get_last_auto_backup_day(&conn).unwrap(), None);
        set_last_auto_backup_day(&conn, "2026-01-02").unwrap();
        assert_eq!(
            get_last_auto_backup_day(&conn).unwrap().as_deref(),
            Some("2026-01-02")
        );
    }

    #[test]
    fn accounts_can_be_listed_created_and_renamed_without_duplicate_names() {
        let conn = db();
        ensure_account(&conn, "main", "默认账户").unwrap();
        conn.execute("UPDATE accounts SET created_at = '2000-01-01' WHERE id = 'main'", [])
            .unwrap();
        let accounts = list_accounts(&conn).unwrap();
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].name, "默认账户");
        assert_eq!(accounts[0].currency, "USD");

        insert_account(&conn, "second", "第二个账户", "2026-11-04").unwrap();
        assert!(insert_account(&conn, "second", "重复 ID", "2026-11-04").is_err());
        assert!(account_exists(&conn, "second").unwrap());
        assert!(!account_exists(&conn, "missing").unwrap());
        assert!(account_name_taken(&conn, " 第二个账户 ", None).unwrap());
        assert!(!account_name_taken(&conn, "第二个账户", Some("second")).unwrap());
        assert!(!account_name_taken(&conn, "全新账户", None).unwrap());

        assert!(rename_account(&conn, "second", "长期账户").unwrap());
        assert!(!rename_account(&conn, "missing", "无此账户").unwrap());
        let accounts = list_accounts(&conn).unwrap();
        assert_eq!(
            accounts.iter().map(|account| account.name.as_str()).collect::<Vec<_>>(),
            vec!["默认账户", "长期账户"]
        );
    }

    #[test]
    fn accounts_can_be_archived_restored_and_deleted() {
        let conn = db();
        ensure_account(&conn, "main", "默认账户").unwrap();
        insert_account(&conn, "second", "长期账户", "2026-11-04").unwrap();
        insert_event(
            &conn,
            &Event::buy_shares("second", "second-buy", 1, at(), "AAPL", 10, 150.0, 0.0),
        )
        .unwrap();

        let accounts = list_accounts(&conn).unwrap();
        assert!(accounts.iter().all(|account| account.archived_at.is_none()));
        assert_eq!(
            accounts.iter().find(|account| account.id == "second").unwrap().event_count,
            1
        );
        assert_eq!(count_active_accounts(&conn).unwrap(), 2);

        assert!(set_account_archived(&conn, "second", true).unwrap());
        let second = account_record(&conn, "second").unwrap().unwrap();
        assert_eq!(second.archived_at, Some(format_date(today())));
        assert_eq!(count_active_accounts(&conn).unwrap(), 1);
        assert!(!set_account_archived(&conn, "missing", true).unwrap());

        assert!(set_account_archived(&conn, "second", false).unwrap());
        assert!(account_record(&conn, "second").unwrap().unwrap().archived_at.is_none());

        assert!(delete_account(&conn, "second").unwrap());
        assert!(account_record(&conn, "second").unwrap().is_none());
        assert!(!delete_account(&conn, "second").unwrap());
    }

    #[test]
    fn trading_date_uses_new_york_time_and_dst() {
        let parse = |value: &str| {
            time::OffsetDateTime::parse(
                value,
                &time::format_description::well_known::Rfc3339,
            )
            .unwrap()
        };
        // Winter is UTC-5: 04:30Z is still the previous New York date.
        assert_eq!(
            format_date(eastern_date(parse("2026-01-02T04:30:00Z"))),
            "2026-01-01"
        );
        // Summer is UTC-4: 03:30Z is still the previous New York date.
        assert_eq!(
            format_date(eastern_date(parse("2026-07-01T03:30:00Z"))),
            "2026-06-30"
        );
        // DST begins at 07:00Z on the second Sunday in March.
        assert_eq!(
            format_date(eastern_date(parse("2026-03-08T04:30:00Z"))),
            "2026-03-07"
        );
        assert_eq!(
            format_date(eastern_date(parse("2026-03-09T04:30:00Z"))),
            "2026-03-09"
        );
    }

    #[test]
    fn version_two_accounts_table_gains_archived_column() {
        let path = std::env::temp_dir().join(format!(
            "wheel-accounts-v2-{}-{}.sqlite",
            std::process::id(),
            time::OffsetDateTime::now_utc().unix_timestamp_nanos()
        ));
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE accounts (
                   id TEXT PRIMARY KEY, name TEXT NOT NULL, broker TEXT,
                   currency TEXT NOT NULL DEFAULT 'USD', created_at TEXT NOT NULL
                 );
                 INSERT INTO accounts (id, name, created_at) VALUES ('main', '默认账户', '2026-01-01');
                 PRAGMA user_version = 2;",
            )
            .unwrap();
        }
        let conn = open(&path).unwrap();
        let columns: Vec<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(accounts)").unwrap();
            stmt.query_map([], |row| row.get::<_, String>(1))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        };
        assert!(columns.iter().any(|name| name == "archived_at"));
        let record = account_record(&conn, "main").unwrap().unwrap();
        assert!(record.archived_at.is_none());
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        drop(conn);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn cash_events_round_trip_and_validate_as_account_level_only() {
        let conn = db();
        insert_events(
            &conn,
            &[
                Event::cash_deposit("main", "dep", 1, at(), 5_000.0),
                Event::cash_withdrawal("main", "wd", 2, at(), 1_250.5),
            ],
        )
        .unwrap();
        let events = list_events(&conn, "main").unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].kind, EventKind::CashDeposit);
        assert_eq!(events[0].symbol, "");
        assert_eq!(events[1].kind, EventKind::CashWithdrawal);
        assert_eq!(kind_to_str(EventKind::CashDeposit), "cash_deposit");
        assert_eq!(parse_kind("cash_withdrawal").unwrap(), EventKind::CashWithdrawal);
        validate_event(&events[0]).unwrap();
        validate_event(&events[1]).unwrap();

        let mut bad = events[0].clone();
        bad.symbol = "AAPL".into();
        assert!(validate_event(&bad).unwrap_err().to_string().contains("标的"));
        bad = events[0].clone();
        bad.qty = 1;
        assert!(validate_event(&bad).is_err());
        bad = events[0].clone();
        bad.amount = 0.0;
        assert!(validate_event(&bad).is_err());
        bad = events[0].clone();
        bad.amount = -10.0;
        assert!(validate_event(&bad).is_err());
        bad = events[0].clone();
        bad.contract = Some(contract(150.0));
        assert!(validate_event(&bad).is_err());

        let state = wheel_core::replay("main", &events, Settings::default()).unwrap();
        assert_eq!(state.account_cash, 3_749.5);
        assert_eq!(state.cash_deposits, 5_000.0);
        assert_eq!(state.cash_withdrawals, 1_250.5);
        assert!(state.campaigns.is_empty());
    }
}
