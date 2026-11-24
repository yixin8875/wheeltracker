//! Rule-driven action suggestions and conditional alerts.
//!
//! Both surfaces — the dashboard's "today" list and the Windows notification
//! worker — read the same rules and the same ledger snapshot, so they never
//! disagree about what needs attention. Nothing here writes to the ledger.

use anyhow::{bail, Context, Result};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use wheel_core::Right;

use crate::{option_chain, store, views};

pub const RULES_KEY: &str = "alertRules";

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AlertRules {
    /// Send Windows notifications for conditional alerts. The dashboard list
    /// is always available regardless of this switch.
    pub alerts_enabled: bool,
    /// Contracts this close to expiry appear in today's list.
    pub expiry_days: i64,
    /// Alert when the remaining premium is at most this percent of the credit.
    pub profit_target_pct: f64,
    /// Alert when the underlying is this far past the strike.
    pub deep_itm_pct: f64,
    /// Alert when the price is this far below cost B.
    pub below_cost_pct: f64,
}

impl Default for AlertRules {
    fn default() -> Self {
        Self {
            alerts_enabled: true,
            expiry_days: 7,
            profit_target_pct: 30.0,
            deep_itm_pct: 5.0,
            below_cost_pct: 0.0,
        }
    }
}

impl AlertRules {
    fn validate(&self) -> Result<()> {
        if !(0..=60).contains(&self.expiry_days) {
            bail!("到期提醒天数必须为 0 到 60");
        }
        if !(1.0..=95.0).contains(&self.profit_target_pct) {
            bail!("权利金剩余比例必须为 1 到 95");
        }
        if !(1.0..=50.0).contains(&self.deep_itm_pct) {
            bail!("深度实值阈值必须为 1 到 50");
        }
        if !(0.0..=50.0).contains(&self.below_cost_pct) {
            bail!("低于成本阈值必须为 0 到 50");
        }
        Ok(())
    }
}

pub fn load_rules(conn: &Connection) -> Result<AlertRules> {
    let Some(raw) = store::get_setting_value(conn, RULES_KEY)? else {
        return Ok(AlertRules::default());
    };
    // Preferences are disposable; a corrupt value falls back to defaults.
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

pub fn save_rules(conn: &Connection, rules: AlertRules) -> Result<AlertRules> {
    rules.validate()?;
    let raw = serde_json::to_string(&rules)?;
    store::set_setting_value(conn, RULES_KEY, &raw)?;
    Ok(rules)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InsightView {
    pub id: String,
    /// `urgent` / `warning` / `info`.
    pub severity: String,
    /// `overdue` / `expiry` / `profit` / `deep_itm` / `cash` / `below_cost`.
    pub kind: String,
    pub account_id: String,
    pub account_name: String,
    pub symbol: String,
    pub campaign_id: Option<String>,
    pub contract: Option<String>,
    pub title: String,
    pub detail: String,
    /// `expire` / `close` / `roll` / `cost` / `cash`.
    pub action: String,
    pub qty: Option<u32>,
    pub expiry: Option<String>,
    pub strike: Option<f64>,
    pub right: Option<String>,
    pub multiplier: Option<u32>,
    pub days_left: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoView {
    pub as_of: String,
    pub rules: AlertRules,
    pub items: Vec<InsightView>,
}

pub fn build_with(conn: &Connection, rules: AlertRules) -> Result<Vec<InsightView>> {
    let today = store::today();
    let prices = store::latest_prices(conn)?;
    let mut items = Vec::new();

    for account in store::list_accounts(conn)? {
        if account.archived_at.is_some() {
            continue;
        }
        let events = store::list_events(conn, &account.id)?;
        let derived = store::replay_checked(&account.id, &events, store::get_settings(conn)?)
            .with_context(|| format!("账户「{}」回放失败", account.name))?;
        let include_dividends = derived.settings.include_dividends_in_cost;

        for position in &derived.positions {
            let symbol = position.contract.underlying.clone();
            let contract = position.contract.display();
            let days_left = (position.contract.expiry - today).whole_days();
            let quote = option_chain::load_symbol(conn, &symbol)
                .ok()
                .and_then(|chain| chain.quote(&position.contract).cloned());
            let valuation = views::option_valuation(position, quote.as_ref(), today);
            let price = prices.get(&symbol).copied();
            let captured = valuation.unrealized_pct.map(|pct| pct * 100.0);
            let base = InsightView {
                id: format!("{}|{}|", account.id, contract),
                severity: String::new(),
                kind: String::new(),
                account_id: account.id.clone(),
                account_name: account.name.clone(),
                symbol: symbol.clone(),
                campaign_id: Some(position.campaign_id.clone()),
                contract: Some(contract.clone()),
                title: String::new(),
                detail: String::new(),
                action: String::new(),
                qty: Some(position.open_qty),
                expiry: Some(position.contract.expiry.to_string()),
                strike: Some(position.contract.strike),
                right: Some(position.contract.right.as_str().to_string()),
                multiplier: Some(position.contract.multiplier),
                days_left: Some(days_left),
            };

            let mut item = None;
            if days_left < 0 {
                item = Some(InsightView {
                    severity: "urgent".into(),
                    kind: "overdue".into(),
                    title: "已过期未处理".into(),
                    detail: format!("已过期 {} 天，请核对券商后标记作废或指派。", -days_left),
                    action: "expire".into(),
                    ..base.clone()
                });
            } else if let Some(price) = price {
                let deep = match position.contract.right {
                    Right::Put => {
                        price <= position.contract.strike * (1.0 - rules.deep_itm_pct / 100.0)
                    }
                    Right::Call => {
                        price >= position.contract.strike * (1.0 + rules.deep_itm_pct / 100.0)
                    }
                };
                if deep {
                    item = Some(InsightView {
                        severity: "warning".into(),
                        kind: "deep_itm".into(),
                        title: "深度实值".into(),
                        detail: format!(
                            "现价 {price:.2}，已越过行权价 {:.2}；考虑平仓或滚动。",
                            position.contract.strike
                        ),
                        action: "roll".into(),
                        ..base.clone()
                    });
                }
            }
            if item.is_none()
                && valuation
                    .unrealized_pct
                    .is_some_and(|pct| pct >= 1.0 - rules.profit_target_pct / 100.0)
            {
                item = Some(InsightView {
                    severity: "info".into(),
                    kind: "profit".into(),
                    title: "权利金已基本收回".into(),
                    detail: format!(
                        "已收回 {:.0}% 权利金，剩余时间价值不多；可考虑平仓了结。",
                        captured.unwrap_or(0.0)
                    ),
                    action: "close".into(),
                    ..base.clone()
                });
            }
            if item.is_none() && days_left <= rules.expiry_days {
                let suffix = captured
                    .map(|pct| format!("已收回 {pct:.0}% 权利金。"))
                    .unwrap_or_default();
                item = Some(InsightView {
                    severity: if days_left <= 1 {
                        "warning".into()
                    } else {
                        "info".into()
                    },
                    kind: "expiry".into(),
                    title: if days_left == 0 {
                        "今天到期".into()
                    } else {
                        format!("{days_left} 天后到期")
                    },
                    detail: format!("{suffix}平仓、滚动、作废或准备指派。"),
                    action: "close".into(),
                    ..base.clone()
                });
            }
            if let Some(mut item) = item {
                item.id.push_str(&item.kind);
                items.push(item);
            }
        }

        let collateral: f64 = derived
            .positions
            .iter()
            .filter(|position| position.contract.right == Right::Put)
            .map(|position| {
                position.contract.strike
                    * f64::from(position.contract.multiplier)
                    * f64::from(position.open_qty)
            })
            .sum();
        let cash_tracked = derived.cash_deposits > 0.0 || derived.cash_withdrawals > 0.0;
        if cash_tracked && collateral > 0.0 && derived.account_cash < collateral {
            let coverage = derived.account_cash / collateral;
            items.push(InsightView {
                id: format!("{}|cash", account.id),
                severity: "warning".into(),
                kind: "cash".into(),
                account_id: account.id.clone(),
                account_name: account.name.clone(),
                symbol: String::new(),
                campaign_id: None,
                contract: None,
                title: "现金覆盖不足".into(),
                detail: format!(
                    "现金 {:.2} 只能覆盖 Put 义务 {:.2} 的 {:.0}%；若全部被指派需要补足资金。",
                    derived.account_cash,
                    collateral,
                    coverage * 100.0
                ),
                action: "cash".into(),
                qty: None,
                expiry: None,
                strike: None,
                right: None,
                multiplier: None,
                days_left: None,
            });
        }

        for campaign in &derived.campaigns {
            let Some(cost_b) = campaign.cost_b(include_dividends) else {
                continue;
            };
            let Some(price) = prices.get(&campaign.symbol).copied() else {
                continue;
            };
            let threshold = cost_b * (1.0 - rules.below_cost_pct / 100.0);
            if price >= threshold || threshold <= 0.0 {
                continue;
            }
            items.push(InsightView {
                id: format!("{}|below_cost", campaign.id),
                severity: "info".into(),
                kind: "below_cost".into(),
                account_id: account.id.clone(),
                account_name: account.name.clone(),
                symbol: campaign.symbol.clone(),
                campaign_id: Some(campaign.id.clone()),
                contract: None,
                title: "股价低于 B 轨成本".into(),
                detail: format!(
                    "现价 {price:.2}，B 轨成本 {cost_b:.2}，低 {:.1}%；可查看降本方案。",
                    (1.0 - price / cost_b) * 100.0
                ),
                action: "cost".into(),
                qty: None,
                expiry: None,
                strike: None,
                right: None,
                multiplier: None,
                days_left: None,
            });
        }
    }

    items.sort_by(|left, right| {
        rank(&left.severity)
            .cmp(&rank(&right.severity))
            .then_with(|| {
                left.days_left
                    .unwrap_or(i64::MAX)
                    .cmp(&right.days_left.unwrap_or(i64::MAX))
            })
            .then_with(|| left.account_name.cmp(&right.account_name))
            .then_with(|| left.contract.cmp(&right.contract))
    });
    items.truncate(50);
    Ok(items)
}

fn rank(severity: &str) -> u8 {
    match severity {
        "urgent" => 0,
        "warning" => 1,
        _ => 2,
    }
}

/// Alerts that are worth a Windows notification. Expiry and overdue contracts
/// already go through the expiry reminder log, so only the conditional rules
/// are returned here.
pub fn conditional(conn: &Connection, rules: AlertRules) -> Result<Vec<InsightView>> {
    if !rules.alerts_enabled {
        return Ok(Vec::new());
    }
    Ok(build_with(conn, rules)?
        .into_iter()
        .filter(|item| matches!(item.kind.as_str(), "profit" | "deep_itm" | "below_cost"))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::Duration;
    use wheel_core::{Event, OptionContract};

    fn db() -> Connection {
        let conn = store::open(std::path::Path::new(":memory:")).unwrap();
        store::ensure_account(&conn, "main", "默认账户").unwrap();
        conn
    }

    fn mark(conn: &Connection, strike: f64, mark: f64) {
        let snapshot = option_chain::ChainSnapshot {
            symbol: "AAPL".into(),
            source: "test".into(),
            as_of: "2026-01-02 00:00:00".into(),
            fetched_at: "2026-01-02 00:00:00".into(),
            underlying: Some(100.0),
            notes: String::new(),
        };
        let quote = option_chain::OptionQuote {
            symbol: "AAPL".into(),
            expiry: store::today() + Duration::days(5),
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
        option_chain::replace(conn, &snapshot, &[quote]).unwrap();
    }

    fn sell_put(conn: &Connection, id: &str, seq: u64, at: time::Date, expiry: time::Date) {
        store::insert_event(
            conn,
            &Event::sell_option(
                "main",
                id,
                seq,
                at,
                OptionContract::new("AAPL", expiry, 100.0, Right::Put),
                1,
                2.0,
                0.0,
            ),
        )
        .unwrap();
    }

    #[test]
    fn profit_target_and_expiry_have_single_most_urgent_item() {
        let conn = db();
        sell_put(
            &conn,
            "p1",
            1,
            store::today(),
            store::today() + Duration::days(5),
        );
        mark(&conn, 100.0, 0.4);
        let items = build_with(
            &conn,
            AlertRules {
                expiry_days: 3,
                ..AlertRules::default()
            },
        )
        .unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].kind, "profit");
        assert_eq!(items[0].action, "close");
        assert!(items[0].detail.contains("80%"));
    }

    #[test]
    fn overdue_contract_is_urgent_and_prefills_expire() {
        let conn = db();
        sell_put(
            &conn,
            "old",
            1,
            store::today() - Duration::days(10),
            store::today() - Duration::days(2),
        );
        let items = build_with(&conn, AlertRules::default()).unwrap();
        let overdue = items.iter().find(|item| item.kind == "overdue").unwrap();
        assert_eq!(overdue.severity, "urgent");
        assert_eq!(overdue.action, "expire");
        assert_eq!(overdue.days_left, Some(-2));
    }

    #[test]
    fn expiry_window_uses_the_configured_days() {
        let conn = db();
        sell_put(
            &conn,
            "p1",
            1,
            store::today(),
            store::today() + Duration::days(6),
        );
        let wide = build_with(
            &conn,
            AlertRules {
                expiry_days: 7,
                ..AlertRules::default()
            },
        )
        .unwrap();
        assert_eq!(wide.len(), 1);
        assert_eq!(wide[0].kind, "expiry");

        let narrow = build_with(
            &conn,
            AlertRules {
                expiry_days: 3,
                ..AlertRules::default()
            },
        )
        .unwrap();
        assert!(narrow.is_empty());
    }

    #[test]
    fn rules_reject_out_of_range_values_and_round_trip() {
        let conn = db();
        let bad = AlertRules {
            expiry_days: 90,
            ..AlertRules::default()
        };
        assert!(save_rules(&conn, bad).is_err());
        let rules = AlertRules {
            expiry_days: 5,
            profit_target_pct: 25.0,
            deep_itm_pct: 8.0,
            below_cost_pct: 3.0,
            alerts_enabled: false,
        };
        save_rules(&conn, rules).unwrap();
        assert_eq!(load_rules(&conn).unwrap(), rules);
    }
}
