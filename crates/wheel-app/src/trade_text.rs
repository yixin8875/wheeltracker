//! Shared trade-text helpers used by the vision import pipeline.
//!
//! Model-extracted trades are emitted as a synthetic CSV document with a fixed
//! header so the existing CSV preview / commit pipeline (deduplication,
//! validation, atomic insert) is reused unchanged. The module also normalizes
//! model-provided dates and symbols before validation.

use std::sync::OnceLock;

use regex::Regex;

use crate::import::{self, DateFormat};

const CSV_HEADER: &str = "日期,方向,代码,数量,价格,费用,到期日,行权价,看涨看跌,乘数,备注";

/// A single extracted trade, ready to be written as one CSV row.
#[derive(Debug, Clone, PartialEq)]
pub struct ExtractedTrade {
    pub date: String,
    pub kind: String,
    pub symbol: String,
    pub qty: u32,
    pub price: f64,
    pub fees: f64,
    pub expiry: Option<String>,
    pub strike: Option<f64>,
    pub right: Option<String>,
    /// Shares per contract; 100 unless the source explicitly says otherwise.
    pub multiplier: u32,
    pub amount: f64,
    pub note: String,
}

#[derive(Debug, Clone)]
pub struct Extraction {
    pub template: String,
    pub trades: Vec<ExtractedTrade>,
    pub warnings: Vec<String>,
    pub csv: String,
}

pub(crate) fn build_csv(trades: &[ExtractedTrade]) -> String {
    let mut rows = vec![CSV_HEADER.to_string()];
    for trade in trades {
        let row = [
            trade.date.clone(),
            trade.kind.clone(),
            trade.symbol.clone(),
            trade.qty.to_string(),
            money_cell(trade.price),
            money_cell(trade.fees),
            trade.expiry.clone().unwrap_or_default(),
            trade.strike.map(money_cell).unwrap_or_default(),
            trade.right.clone().unwrap_or_default(),
            trade.multiplier.to_string(),
            trade.note.clone(),
        ];
        rows.push(
            row.iter()
                .map(|value| csv_cell(value))
                .collect::<Vec<_>>()
                .join(","),
        );
    }
    rows.join("\n")
}

fn money_cell(value: f64) -> String {
    let mut text = format!("{value:.6}");
    while text.contains('.') && text.ends_with('0') {
        text.pop();
    }
    if text.ends_with('.') {
        text.pop();
    }
    if text.is_empty() || text == "-0" {
        "0".to_string()
    } else {
        text
    }
}

fn csv_cell(value: &str) -> String {
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

fn is_stopword(word: &str) -> bool {
    const WORDS: &[&str] = &[
        "a",
        "an",
        "and",
        "at",
        "account",
        "amount",
        "buy",
        "bought",
        "cash",
        "commission",
        "date",
        "for",
        "fees",
        "from",
        "in",
        "net",
        "of",
        "on",
        "open",
        "order",
        "price",
        "purchase",
        "sale",
        "sell",
        "share",
        "shares",
        "sold",
        "the",
        "this",
        "to",
        "total",
        "trade",
        "transaction",
        "value",
        "with",
        "your",
    ];
    WORDS.contains(&word.to_lowercase().as_str())
}

pub(crate) fn sanitize_symbol(raw: &str) -> Option<String> {
    let trimmed = raw
        .trim()
        .trim_matches(|ch: char| !ch.is_ascii_alphanumeric() && ch != '.' && ch != '-');
    let symbol = trimmed.to_uppercase();
    if symbol.is_empty() || symbol.len() > 10 || is_stopword(&symbol) {
        return None;
    }
    if !symbol.chars().any(|ch| ch.is_ascii_alphabetic()) {
        return None;
    }
    if !symbol
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '-')
    {
        return None;
    }
    Some(symbol)
}

pub(crate) fn normalize_any_date(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_matches(|ch: char| ch == ',' || ch == '.');
    if let Some(value) = month_name_date(trimmed) {
        return Some(value);
    }
    if let Ok((value, _)) = import::parse_date_cell(trimmed, DateFormat::Auto) {
        return Some(value);
    }
    if let Ok((value, _)) = import::parse_date_cell(trimmed, DateFormat::Chinese) {
        return Some(value);
    }
    None
}

fn month_name_date(raw: &str) -> Option<String> {
    static MONTH_FIRST: OnceLock<Regex> = OnceLock::new();
    static DAY_FIRST: OnceLock<Regex> = OnceLock::new();
    let month_first = MONTH_FIRST
        .get_or_init(|| Regex::new(r"(?i)\b([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{2,4})\b").unwrap());
    let day_first = DAY_FIRST
        .get_or_init(|| Regex::new(r"(?i)\b(\d{1,2})\s+([a-z]{3,9})\.?\s+(\d{2,4})\b").unwrap());

    let (month_name, day, year) = if let Some(caps) = month_first.captures(raw) {
        (
            caps.get(1)?.as_str(),
            caps.get(2)?.as_str().parse::<u32>().ok()?,
            caps.get(3)?.as_str().parse::<u32>().ok()?,
        )
    } else {
        let caps = day_first.captures(raw)?;
        (
            caps.get(2)?.as_str(),
            caps.get(1)?.as_str().parse::<u32>().ok()?,
            caps.get(3)?.as_str().parse::<u32>().ok()?,
        )
    };
    let month = match month_name.to_lowercase().trim_end_matches('.').get(..3)? {
        "jan" => 1,
        "feb" => 2,
        "mar" => 3,
        "apr" => 4,
        "may" => 5,
        "jun" => 6,
        "jul" => 7,
        "aug" => 8,
        "sep" => 9,
        "oct" => 10,
        "nov" => 11,
        "dec" => 12,
        _ => return None,
    };
    let year = if year < 100 { 2000 + year } else { year };
    if !(2000..=2100).contains(&year) || !(1..=31).contains(&day) {
        return None;
    }
    Some(format!("{year:04}-{month:02}-{day:02}"))
}

pub(crate) fn fingerprint(trade: &ExtractedTrade) -> String {
    format!(
        "{}|{}|{}|{}|{:.6}|{:.6}|{}|{}|{}|{:.6}",
        trade.date,
        trade.kind,
        trade.symbol,
        trade.qty,
        trade.price,
        trade.fees,
        trade.expiry.as_deref().unwrap_or(""),
        trade
            .strike
            .map(|value| format!("{value:.4}"))
            .unwrap_or_default(),
        trade.right.as_deref().unwrap_or(""),
        trade.amount
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trade() -> ExtractedTrade {
        ExtractedTrade {
            date: "2026-01-02".into(),
            kind: "option_open_short".into(),
            symbol: "AAPL".into(),
            qty: 1,
            price: 2.0,
            fees: 1.0,
            expiry: Some("2026-02-20".into()),
            strike: Some(150.0),
            right: Some("P".into()),
            multiplier: 100,
            amount: 0.0,
            note: "synthetic".into(),
        }
    }

    #[test]
    fn normalizes_month_names_and_plain_dates() {
        assert_eq!(normalize_any_date("Feb 20, 2026").as_deref(), Some("2026-02-20"));
        assert_eq!(normalize_any_date("20 FEB 26").as_deref(), Some("2026-02-20"));
        assert_eq!(normalize_any_date("2026年1月5日").as_deref(), Some("2026-01-05"));
        assert_eq!(normalize_any_date("not a date"), None);
    }

    #[test]
    fn sanitizes_symbols_and_rejects_stopwords() {
        assert_eq!(sanitize_symbol(" aapl ").as_deref(), Some("AAPL"));
        assert_eq!(sanitize_symbol("BRK.B").as_deref(), Some("BRK.B"));
        assert_eq!(sanitize_symbol("shares"), None);
        assert_eq!(sanitize_symbol("123"), None);
        assert_eq!(sanitize_symbol("TOOLONGSYMBOL"), None);
    }

    #[test]
    fn csv_uses_the_fixed_header_and_quotes_notes() {
        let mut row = trade();
        row.note = "note, with comma".into();
        let csv = build_csv(&[row]);
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].ends_with(",乘数,备注"));
        assert!(lines[1].contains("option_open_short,AAPL,1,2,1,2026-02-20,150,P,100,\"note, with comma\""));
    }

    #[test]
    fn fingerprint_is_stable_for_the_same_trade() {
        assert_eq!(fingerprint(&trade()), fingerprint(&trade()));
        let mut other = trade();
        other.qty = 2;
        assert_ne!(fingerprint(&trade()), fingerprint(&other));
    }
}
