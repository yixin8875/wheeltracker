//! Expiry scanning and Windows notifications.
//!
//! The tray menu, the hourly background worker and the UI all use the same
//! scan so "what is due" never disagrees between surfaces. Notifications are
//! deduplicated per contract and expiry phase, not per calendar day: a
//! contract notifies once when it enters the soon window, once within three
//! days, once on expiry day and once after it is overdue.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Context, Result};
use rusqlite::Connection;
use serde::Serialize;
use tauri_plugin_notification::NotificationExt;
use time::Duration;

use crate::insights::{self, InsightView};
use crate::store;
use crate::views;

const LOG_KEY: &str = "expiryNotificationLog";
const ALERT_LOG_KEY: &str = "alertNotificationLog";
const LOG_RETENTION_DAYS: i64 = 90;
const LOG_MAX_ENTRIES: usize = 500;
const TRAY_ID: &str = "main";
const NOTIFICATION_TITLE: &str = "Wheel Tracker · 到期提醒";
const ALERT_TITLE: &str = "Wheel Tracker · 条件提醒";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DueContract {
    pub account_id: String,
    pub account_name: String,
    pub contract: String,
    pub symbol: String,
    pub expiry: String,
    pub days_left: i64,
    pub open_qty: u32,
    pub right: String,
    pub strike: f64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckSummary {
    pub overdue: u32,
    pub today: u32,
    pub critical: u32,
    pub soon: u32,
    pub total: u32,
    pub notified: u32,
    /// Conditional alerts that are currently firing.
    pub alerts: u32,
    /// Conditional alerts sent by this check.
    pub alert_notified: u32,
}

pub struct Scan {
    pub due: Vec<DueContract>,
    pub summary: CheckSummary,
}

fn bucket(days_left: i64, lead_days: i64) -> &'static str {
    if days_left < 0 {
        "overdue"
    } else if days_left == 0 {
        "today"
    } else if days_left <= 3.min(lead_days) {
        "critical"
    } else {
        "soon"
    }
}

/// All open contracts inside the reminder window, across active accounts.
pub fn scan(conn: &Connection, lead_days: i64) -> Result<Scan> {
    let today = store::today();
    let settings = store::get_settings(conn)?;
    let mut due = Vec::new();
    let mut summary = CheckSummary::default();

    for account in store::list_accounts(conn)? {
        if account.archived_at.is_some() {
            continue;
        }
        let events = store::list_events(conn, &account.id)?;
        let derived = store::replay_checked(&account.id, &events, settings)?;
        for position in &derived.positions {
            let view = views::position(position, today);
            if view.days_left > lead_days {
                continue;
            }
            match bucket(view.days_left, lead_days) {
                "overdue" => summary.overdue += 1,
                "today" => summary.today += 1,
                "critical" => summary.critical += 1,
                _ => summary.soon += 1,
            }
            summary.total += 1;
            due.push(DueContract {
                account_id: account.id.clone(),
                account_name: account.name.clone(),
                contract: view.contract,
                symbol: view.symbol,
                expiry: view.expiry,
                days_left: view.days_left,
                open_qty: view.open_qty,
                right: view.right,
                strike: view.strike,
            });
        }
    }

    due.sort_by(|left, right| {
        left.days_left
            .cmp(&right.days_left)
            .then_with(|| left.account_name.cmp(&right.account_name))
            .then_with(|| left.contract.cmp(&right.contract))
    });
    Ok(Scan { due, summary })
}

fn load_log(conn: &Connection) -> Result<BTreeMap<String, String>> {
    let Some(raw) = store::get_setting_value(conn, LOG_KEY)? else {
        return Ok(BTreeMap::new());
    };
    // Notification state is disposable; a corrupt value must not block the app.
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

fn save_log(conn: &Connection, log: &BTreeMap<String, String>) -> Result<()> {
    let cutoff = (store::today() - Duration::days(LOG_RETENTION_DAYS)).to_string();
    let mut entries: Vec<(&String, &String)> = log
        .iter()
        .filter(|(_, sent_on)| sent_on.as_str() >= cutoff.as_str())
        .collect();
    if entries.len() > LOG_MAX_ENTRIES {
        entries.sort_by(|left, right| right.1.cmp(left.1));
        entries.truncate(LOG_MAX_ENTRIES);
    }
    let kept: BTreeMap<String, String> = entries
        .into_iter()
        .map(|(key, sent_on)| (key.clone(), sent_on.clone()))
        .collect();
    let raw = serde_json::to_string(&kept)?;
    store::set_setting_value(conn, LOG_KEY, &raw)
}

fn load_alert_log(conn: &Connection) -> Result<BTreeMap<String, String>> {
    let Some(raw) = store::get_setting_value(conn, ALERT_LOG_KEY)? else {
        return Ok(BTreeMap::new());
    };
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

fn save_alert_log(conn: &Connection, log: &BTreeMap<String, String>) -> Result<()> {
    let cutoff = (store::today() - Duration::days(LOG_RETENTION_DAYS)).to_string();
    let kept: BTreeMap<String, String> = log
        .iter()
        .filter(|(_, sent_on)| sent_on.as_str() >= cutoff.as_str())
        .map(|(key, sent_on)| (key.clone(), sent_on.clone()))
        .collect();
    let raw = serde_json::to_string(&kept)?;
    store::set_setting_value(conn, ALERT_LOG_KEY, &raw)
}

fn log_key(item: &DueContract, lead_days: i64) -> String {
    format!(
        "{}|{}|{}|{}",
        item.account_id,
        item.contract,
        item.expiry,
        bucket(item.days_left, lead_days)
    )
}

fn day_label(days_left: i64) -> String {
    if days_left < 0 {
        format!("已过期 {} 天", -days_left)
    } else if days_left == 0 {
        "今天到期".to_string()
    } else {
        format!("{} 天后到期", days_left)
    }
}

fn alert_body(items: &[InsightView]) -> String {
    let detail = items
        .iter()
        .take(3)
        .map(|item| match &item.contract {
            Some(contract) => format!("{contract} {}", item.title),
            None => format!("{} {}", item.symbol, item.title),
        })
        .collect::<Vec<_>>()
        .join("；");
    let suffix = if items.len() > 3 {
        format!("；另有 {} 条", items.len() - 3)
    } else {
        String::new()
    };
    format!("{detail}{suffix}。打开应用查看今日待办。")
}

fn notification_body(items: &[DueContract], summary: &CheckSummary) -> String {
    let detail = items
        .iter()
        .take(3)
        .map(|item| format!("{} {}", item.contract, day_label(item.days_left)))
        .collect::<Vec<_>>()
        .join("；");
    let suffix = if items.len() > 3 {
        format!("；另有 {} 个", items.len() - 3)
    } else {
        String::new()
    };
    format!(
        "{detail}{suffix}。已过期 {} 个，今天到期 {} 个，3 天内 {} 个。打开应用处理。",
        summary.overdue, summary.today, summary.critical
    )
}

/// Scan, send at most one aggregated notification per newly phased contract
/// and one for newly firing conditional alerts, then remember what was sent.
/// `send` is injected so the tests can observe it.
pub fn check_and_notify<F>(conn: &Connection, mut send: F) -> Result<CheckSummary>
where
    F: FnMut(&str, &str) -> Result<(), String>,
{
    let preferences = store::get_preferences(conn)?;
    let scan = scan(conn, preferences.reminder_lead_days)?;
    let mut summary = scan.summary;
    if !preferences.system_notifications_enabled {
        return Ok(summary);
    }

    if !scan.due.is_empty() {
        let log = load_log(conn)?;
        let fresh: Vec<DueContract> = scan
            .due
            .iter()
            .filter(|item| !log.contains_key(&log_key(item, preferences.reminder_lead_days)))
            .cloned()
            .collect();
        if !fresh.is_empty() {
            send(NOTIFICATION_TITLE, &notification_body(&fresh, &summary))
                .map_err(|error| anyhow::anyhow!(error))
                .context("发送系统通知失败")?;

            let mut updated = log;
            let today = store::today().to_string();
            for item in &fresh {
                updated.insert(log_key(item, preferences.reminder_lead_days), today.clone());
            }
            save_log(conn, &updated)?;
            summary.notified = fresh.len() as u32;
        }
    }

    notify_alerts(conn, &mut send, &mut summary)?;
    Ok(summary)
}

/// Conditional alerts use the same once-per-condition contract as expiry
/// reminders. The log is pruned to conditions still firing, so a condition
/// that resolves and later returns can notify again.
fn notify_alerts<F>(conn: &Connection, send: &mut F, summary: &mut CheckSummary) -> Result<()>
where
    F: FnMut(&str, &str) -> Result<(), String>,
{
    let rules = insights::load_rules(conn)?;
    let alerts = insights::conditional(conn, rules)?;
    summary.alerts = alerts.len() as u32;

    let active: BTreeSet<&str> = alerts.iter().map(|item| item.id.as_str()).collect();
    let mut updated: BTreeMap<String, String> = load_alert_log(conn)?
        .into_iter()
        .filter(|(key, _)| active.contains(key.as_str()))
        .collect();

    let fresh: Vec<InsightView> = alerts
        .iter()
        .filter(|item| !updated.contains_key(&item.id))
        .cloned()
        .collect();
    if !fresh.is_empty() {
        send(ALERT_TITLE, &alert_body(&fresh))
            .map_err(|error| anyhow::anyhow!(error))
            .context("发送条件提醒失败")?;
        let today = store::today().to_string();
        for item in &fresh {
            updated.insert(item.id.clone(), today.clone());
        }
        summary.alert_notified = fresh.len() as u32;
    }
    // Save even when nothing is fresh: this records the prune.
    save_alert_log(conn, &updated)?;
    Ok(())
}

pub fn send(app: &tauri::AppHandle, title: &str, body: &str) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|error| error.to_string())
}

pub fn update_tray_tooltip(app: &tauri::AppHandle, summary: &CheckSummary) {
    let tooltip = if summary.total == 0 && summary.alerts == 0 {
        "Wheel Tracker · 无提醒".to_string()
    } else if summary.total == 0 {
        format!("Wheel Tracker · {} 个条件提醒", summary.alerts)
    } else if summary.overdue > 0 {
        let base = format!(
            "Wheel Tracker · {} 个到期提醒（{} 个已过期）",
            summary.total, summary.overdue
        );
        if summary.alerts > 0 {
            format!("{base}，{} 个条件提醒", summary.alerts)
        } else {
            base
        }
    } else if summary.alerts > 0 {
        format!(
            "Wheel Tracker · {} 个到期提醒，{} 个条件提醒",
            summary.total, summary.alerts
        )
    } else {
        format!("Wheel Tracker · {} 个到期提醒", summary.total)
    };
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use time::macros::date;
    use wheel_core::{Event, OptionContract, Right};

    fn db() -> Connection {
        let conn = store::open(std::path::Path::new(":memory:")).unwrap();
        store::ensure_account(&conn, "main", "默认账户").unwrap();
        conn
    }

    fn put_on(conn: &Connection, id: &str, seq: u64, expiry: time::Date) {
        let today = store::today();
        store::insert_event(
            conn,
            &Event::sell_option(
                "main",
                id,
                seq,
                today,
                OptionContract::new("AAPL", expiry, 150.0, Right::Put),
                1,
                2.0,
                0.0,
            ),
        )
        .unwrap();
    }

    fn enable_notifications(conn: &Connection) {
        let mut preferences = store::get_preferences(conn).unwrap();
        preferences.system_notifications_enabled = true;
        store::set_preferences(conn, preferences).unwrap();
    }

    #[test]
    fn scan_groups_overdue_today_critical_soon_and_ignores_later_contracts() {
        let conn = db();
        let today = store::today();
        put_on(&conn, "overdue", 1, today - Duration::days(2));
        put_on(&conn, "today", 2, today);
        put_on(&conn, "critical", 3, today + Duration::days(2));
        put_on(&conn, "soon", 4, today + Duration::days(6));
        put_on(&conn, "later", 5, today + Duration::days(10));

        let scan = scan(&conn, 7).unwrap();
        assert_eq!(scan.summary.overdue, 1);
        assert_eq!(scan.summary.today, 1);
        assert_eq!(scan.summary.critical, 1);
        assert_eq!(scan.summary.soon, 1);
        assert_eq!(scan.summary.total, 4);
        assert_eq!(scan.due.len(), 4);
        assert!(scan.due[0].contract.starts_with("AAPL "));
        assert!(scan.due[0].contract.ends_with(" 150P"));
        assert_eq!(scan.due[0].days_left, -2);
        assert_eq!(scan.due[3].days_left, 6);
    }

    #[test]
    fn archived_accounts_are_excluded_from_notifications() {
        let conn = db();
        store::insert_account(&conn, "second", "长期账户", &store::today().to_string()).unwrap();
        let today = store::today();
        store::insert_event(
            &conn,
            &Event::sell_option(
                "second",
                "e1",
                1,
                today,
                OptionContract::new("MSFT", today, 300.0, Right::Put),
                1,
                3.0,
                0.0,
            ),
        )
        .unwrap();
        store::set_account_archived(&conn, "second", true).unwrap();
        let scan = scan(&conn, 7).unwrap();
        assert!(scan.due.is_empty());
        assert_eq!(scan.summary.total, 0);
    }

    #[test]
    fn notifications_send_once_per_contract_and_phase() {
        let conn = db();
        enable_notifications(&conn);
        put_on(&conn, "today", 1, store::today());
        let sent = RefCell::new(Vec::new());
        let first = check_and_notify(&conn, |title, body| {
            sent.borrow_mut()
                .push((title.to_string(), body.to_string()));
            Ok(())
        })
        .unwrap();
        assert_eq!(first.notified, 1);
        assert_eq!(sent.borrow().len(), 1);
        assert!(sent.borrow()[0].0.contains("到期提醒"));
        assert!(sent.borrow()[0].1.contains("今天到期"));

        let second = check_and_notify(&conn, |_, _| {
            panic!("the same phase must not notify twice");
        })
        .unwrap();
        assert_eq!(second.notified, 0);
        assert_eq!(second.total, 1);
    }

    #[test]
    fn disabled_notifications_still_report_counts() {
        let conn = db();
        put_on(&conn, "today", 1, store::today());
        let summary = check_and_notify(&conn, |_, _| panic!("notifications are disabled")).unwrap();
        assert_eq!(summary.total, 1);
        assert_eq!(summary.notified, 0);
        assert!(store::get_setting_value(&conn, LOG_KEY).unwrap().is_none());
    }

    #[test]
    fn notification_log_purges_old_entries() {
        let conn = db();
        enable_notifications(&conn);
        put_on(&conn, "today", 1, store::today());
        let stale = date!(2020 - 01 - 01).to_string();
        let mut log = BTreeMap::new();
        log.insert("old|AAPL 150P|2020-01-01|overdue".to_string(), stale);
        store::set_setting_value(&conn, LOG_KEY, &serde_json::to_string(&log).unwrap()).unwrap();

        check_and_notify(&conn, |_, _| Ok(())).unwrap();
        let stored: BTreeMap<String, String> =
            serde_json::from_str(&store::get_setting_value(&conn, LOG_KEY).unwrap().unwrap())
                .unwrap();
        assert!(!stored.contains_key("old|AAPL 150P|2020-01-01|overdue"));
        assert_eq!(stored.len(), 1);
    }

    #[test]
    fn send_failure_does_not_mark_contracts_as_notified() {
        let conn = db();
        enable_notifications(&conn);
        put_on(&conn, "today", 1, store::today());
        let error = check_and_notify(&conn, |_, _| Err("toast unavailable".into())).unwrap_err();
        assert!(format!("{error:#}").contains("toast unavailable"));
        assert!(store::get_setting_value(&conn, LOG_KEY).unwrap().is_none());
    }

    fn mark(conn: &Connection, strike: f64, mark: f64) {
        let expiry = store::today() + Duration::days(5);
        let snapshot = crate::option_chain::ChainSnapshot {
            symbol: "AAPL".to_string(),
            source: "test".to_string(),
            as_of: "2026-01-02 00:00:00".to_string(),
            fetched_at: "2026-01-02 00:00:00".to_string(),
            underlying: Some(100.0),
            notes: String::new(),
        };
        let quote = crate::option_chain::OptionQuote {
            symbol: "AAPL".to_string(),
            expiry,
            strike,
            right: Right::Put,
            bid: Some(mark),
            ask: Some(mark),
            last: None,
            mark: Some(mark),
            iv: None,
            delta: None,
            gamma: None,
            theta: None,
            vega: None,
            open_interest: Some(100),
            volume: Some(1),
            multiplier: 100,
        };
        crate::option_chain::replace(conn, &snapshot, &[quote]).unwrap();
    }

    #[test]
    fn conditional_alerts_notify_once_and_rearm_after_resolution() {
        let conn = db();
        enable_notifications(&conn);
        let mut preferences = store::get_preferences(&conn).unwrap();
        preferences.reminder_lead_days = 0;
        store::set_preferences(&conn, preferences).unwrap();

        let expiry = store::today() + Duration::days(5);
        store::insert_event(
            &conn,
            &Event::sell_option(
                "main",
                "profit",
                1,
                store::today(),
                OptionContract::new("AAPL", expiry, 100.0, Right::Put),
                1,
                2.0,
                0.0,
            ),
        )
        .unwrap();
        mark(&conn, 100.0, 0.4);

        let sent = RefCell::new(Vec::new());
        let first = check_and_notify(&conn, |title, body| {
            sent.borrow_mut()
                .push((title.to_string(), body.to_string()));
            Ok(())
        })
        .unwrap();
        assert_eq!(first.notified, 0);
        assert_eq!(first.alerts, 1);
        assert_eq!(first.alert_notified, 1);
        assert_eq!(sent.borrow().len(), 1);
        assert!(sent.borrow()[0].0.contains("条件提醒"));
        assert!(sent.borrow()[0].1.contains("权利金已基本收回"));

        let second =
            check_and_notify(&conn, |_, _| panic!("the same alert must not notify twice")).unwrap();
        assert_eq!(second.alerts, 1);
        assert_eq!(second.alert_notified, 0);

        // The condition resolves; pruning lets it notify again when it returns.
        mark(&conn, 100.0, 2.0);
        let resolved = check_and_notify(&conn, |_, _| Ok(())).unwrap();
        assert_eq!(resolved.alerts, 0);

        mark(&conn, 100.0, 0.4);
        let again_sent = RefCell::new(0);
        let again = check_and_notify(&conn, |_, _| {
            *again_sent.borrow_mut() += 1;
            Ok(())
        })
        .unwrap();
        assert_eq!(again.alert_notified, 1);
        assert_eq!(*again_sent.borrow(), 1);
    }
}
