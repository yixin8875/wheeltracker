//! Validation and construction of events from shell-level requests.
//!
//! Both shells accept the same camelCase request shape from their frontends and
//! turn it into an immutable [`Event`] here, so a trade recorded on the phone
//! passes exactly the same checks as one recorded on the desktop.

use rusqlite::Connection;
use serde::Deserialize;
use wheel_core::{Event, OptionContract, Right};

use crate::store;

pub const DEFAULT_ACCOUNT: &str = "main";

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NewEventReq {
    #[serde(default)]
    pub account_id: Option<String>,
    pub date: String,
    pub kind: String,
    pub symbol: String,
    #[serde(default)]
    pub qty: u32,
    #[serde(default)]
    pub price: f64,
    #[serde(default)]
    pub fees: f64,
    #[serde(default)]
    pub amount: f64,
    #[serde(default)]
    pub expiry: Option<String>,
    #[serde(default)]
    pub strike: Option<f64>,
    #[serde(default)]
    pub right: Option<String>,
    #[serde(default)]
    pub multiplier: Option<u32>,
    #[serde(default)]
    pub split_numerator: Option<u32>,
    #[serde(default)]
    pub split_denominator: Option<u32>,
    #[serde(default)]
    pub split_cash_in_lieu: Option<f64>,
    #[serde(default)]
    pub note: Option<String>,
}

pub fn account_or_default(account_id: Option<String>) -> String {
    account_id
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_ACCOUNT.to_string())
}

pub fn next_event_id(seq: u64) -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let unique = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("ev-{millis}-{seq}-{unique}")
}

/// Validates a batch of requests and assigns each one the next sequence number
/// of its account. Rows are written in one transaction by `insert_events`.
pub fn append_requests(
    conn: &Connection,
    reqs: Vec<NewEventReq>,
) -> Result<Vec<String>, String> {
    if reqs.is_empty() {
        return Err("至少需要一笔交易。".to_string());
    }
    let mut sequences = std::collections::HashMap::new();
    let mut events = Vec::with_capacity(reqs.len());
    let mut ids = Vec::with_capacity(reqs.len());
    for req in reqs {
        let account_id = account_or_default(req.account_id.clone());
        let seq = match sequences.get(&account_id) {
            Some(seq) => *seq,
            None => store::next_seq(conn, &account_id).map_err(|error| error.to_string())?,
        };
        sequences.insert(
            account_id.clone(),
            seq.checked_add(1).ok_or("交易序号溢出")?,
        );
        let id = next_event_id(seq);
        events.push(build_event(&req, &account_id, &id, seq)?);
        ids.push(id);
    }
    match events.as_slice() {
        [event] => store::insert_event(conn, event),
        _ => store::insert_events(conn, &events),
    }
    .map_err(|error| format!("{error:#}"))?;
    Ok(ids)
}

pub fn build_event(req: &NewEventReq, account_id: &str, id: &str, seq: u64) -> Result<Event, String> {
    let at = store::parse_date(&req.date).map_err(|error| error.to_string())?;
    let cash_transfer = matches!(req.kind.as_str(), "cash_deposit" | "cash_withdrawal");
    let symbol = if cash_transfer {
        String::new()
    } else {
        req.symbol.trim().to_ascii_uppercase()
    };
    if !cash_transfer && symbol.is_empty() {
        return Err("标的代码不能为空。".to_string());
    }
    if !req.price.is_finite()
        || req.price < 0.0
        || !req.fees.is_finite()
        || req.fees < 0.0
        || !req.amount.is_finite()
    {
        return Err(
            "价格与费用必须为有限的非负数，金额必须为有限数。".to_string(),
        );
    }
    let contract = match (&req.expiry, req.strike, &req.right) {
        (None, None, None) => None,
        (Some(expiry), Some(strike), Some(right)) => {
            if !strike.is_finite() || strike <= 0.0 {
                return Err("行权价必须为有限且大于 0 的数。".to_string());
            }
            let right = match right.to_ascii_uppercase().as_str() {
                "P" => Right::Put,
                "C" => Right::Call,
                _ => return Err("期权方向必须为 P（Put）或 C（Call）。".to_string()),
            };
            let multiplier = req.multiplier.unwrap_or(100);
            if multiplier == 0 {
                return Err("每手股数必须大于 0。".to_string());
            }
            Some(OptionContract {
                underlying: symbol.clone(),
                expiry: store::parse_date(expiry).map_err(|error| error.to_string())?,
                strike,
                right,
                multiplier,
            })
        }
        _ => return Err("期权合约必须同时填写到期日、行权价和方向。".to_string()),
    };
    let require_contract = || {
        contract
            .clone()
            .ok_or_else(|| "期权交易需要填写到期日、行权价和方向。".to_string())
    };

    let event = match req.kind.as_str() {
        "option_open_short" => Event::sell_option(
            account_id,
            id,
            seq,
            at,
            require_contract()?,
            req.qty,
            req.price,
            req.fees,
        ),
        "option_close" => Event::close_option(
            account_id,
            id,
            seq,
            at,
            require_contract()?,
            req.qty,
            req.price,
            req.fees,
        ),
        "option_expire" => {
            Event::expire_option(account_id, id, seq, at, require_contract()?, req.qty)
        }
        "option_assign" => Event::assign_option(
            account_id,
            id,
            seq,
            at,
            require_contract()?,
            req.qty,
            req.fees,
        ),
        "shares_buy" => Event::buy_shares(
            account_id, id, seq, at, &symbol, req.qty, req.price, req.fees,
        ),
        "shares_sell" => Event::sell_shares(
            account_id, id, seq, at, &symbol, req.qty, req.price, req.fees,
        ),
        "dividend" => Event::dividend(account_id, id, seq, at, &symbol, req.price, req.qty),
        "fee" => Event::fee(account_id, id, seq, at, &symbol, req.amount),
        "adjustment" => Event::adjustment(account_id, id, seq, at, &symbol, req.amount),
        "cash_deposit" => Event::cash_deposit(account_id, id, seq, at, req.amount),
        "cash_withdrawal" => Event::cash_withdrawal(account_id, id, seq, at, req.amount),
        "stock_split" => {
            let numerator = req
                .split_numerator
                .ok_or_else(|| "拆股比例缺少分子。".to_string())?;
            let denominator = req
                .split_denominator
                .ok_or_else(|| "拆股比例缺少分母。".to_string())?;
            Event::stock_split(
                account_id,
                id,
                seq,
                at,
                &symbol,
                numerator,
                denominator,
                req.split_cash_in_lieu,
            )
        }
        other => return Err(format!("未知的交易类型 `{other}`。")),
    };

    let event = event.note(req.note.clone().unwrap_or_default());
    store::validate_event(&event).map_err(|error| error.to_string())?;
    Ok(event)
}
