//! Nasdaq delayed option-chain provider.
//!
//! This is the public quote endpoint used by Nasdaq's own website. It is not a
//! contracted API, so callers must keep the previous snapshot when it fails and
//! offer manual import as the guaranteed path.

use std::time::Duration;

use time::macros::format_description;
use time::Date;

use crate::option_chain::{self, ChainFetch};

const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

pub const MAX_DAYS: i64 = 730;

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(USER_AGENT)
        .build()
        .map_err(|error| format!("期权链客户端初始化失败: {error}"))
}

fn stamp() -> String {
    time::OffsetDateTime::now_utc()
        .format(format_description!(
            "[year]-[month]-[day] [hour]:[minute]:[second]"
        ))
        .unwrap_or_else(|_| "1970-01-01 00:00:00".to_string())
}

/// Fetch one symbol's chain. `to` is clamped to `MAX_DAYS` after `from` so a
/// hand-edited request cannot ask for a decade of contracts.
pub async fn fetch(symbol: &str, from: Date, to: Date) -> Result<ChainFetch, String> {
    let symbol = crate::market::normalize_symbol(symbol)?;
    let max_to = from + time::Duration::days(MAX_DAYS);
    let to = if to > max_to { max_to } else { to };
    if to < from {
        return Err("期权链结束日期早于开始日期".to_string());
    }
    let url = format!("https://api.nasdaq.com/api/quote/{symbol}/option-chain");
    let response = client()?
        .get(url)
        .query(&[
            ("assetclass", "stocks"),
            ("limit", "10000"),
            ("fromdate", &from.to_string()),
            ("todate", &to.to_string()),
            ("exchcode", "oprac"),
            ("callput", "callput"),
            ("money", "all"),
            ("type", "all"),
        ])
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| format!("Nasdaq 期权链请求失败: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "Nasdaq 期权链请求失败（HTTP {}）；可改用粘贴导入",
            status.as_u16()
        ));
    }
    let body = response
        .text()
        .await
        .map_err(|error| format!("Nasdaq 期权链读取失败: {error}"))?;
    option_chain::parse_nasdaq(&symbol, &body, &stamp(), None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::Month;

    #[test]
    fn stamp_has_expected_shape() {
        let value = stamp();
        assert_eq!(value.len(), 19);
        assert_eq!(&value[4..5], "-");
        assert_eq!(&value[10..11], " ");
    }

    #[test]
    fn max_window_is_two_years() {
        let from = Date::from_calendar_date(2026, Month::November, 20).unwrap();
        let to = from + time::Duration::days(MAX_DAYS);
        assert_eq!(to.year(), 2028);
    }
}
