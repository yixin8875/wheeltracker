//! Option-chain snapshots and manual imports.
//!
//! Quotes live in their own tables and never touch `prices`, so the cost chart
//! and the ledger keep their strict "stock close only" semantics.

use std::collections::BTreeMap;

use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::Deserialize;
use time::{macros::format_description, Date, Month};
use wheel_core::Right;

/// One option contract quote. Missing fields stay `None`; the scanner decides
/// whether a contract is tradable.
#[derive(Debug, Clone, PartialEq)]
pub struct OptionQuote {
    pub symbol: String,
    pub expiry: Date,
    pub strike: f64,
    pub right: Right,
    pub bid: Option<f64>,
    pub ask: Option<f64>,
    pub last: Option<f64>,
    pub mark: Option<f64>,
    pub iv: Option<f64>,
    pub delta: Option<f64>,
    pub gamma: Option<f64>,
    pub theta: Option<f64>,
    pub vega: Option<f64>,
    pub open_interest: Option<i64>,
    pub volume: Option<i64>,
    pub multiplier: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChainSnapshot {
    pub symbol: String,
    pub source: String,
    pub as_of: String,
    pub fetched_at: String,
    pub underlying: Option<f64>,
    pub notes: String,
}

#[derive(Debug, Clone)]
pub struct ChainFetch {
    pub snapshot: ChainSnapshot,
    pub quotes: Vec<OptionQuote>,
}

/// Replace every quote for one symbol in a single transaction. The snapshot row
/// is upserted last so readers never see a half-written chain.
pub fn replace(conn: &Connection, snapshot: &ChainSnapshot, quotes: &[OptionQuote]) -> Result<()> {
    if quotes.is_empty() {
        bail!("期权链为空，未写入");
    }
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    tx.execute(
        "DELETE FROM option_quotes WHERE symbol = ?1",
        params![snapshot.symbol],
    )?;
    {
        let mut stmt = tx.prepare(
            "INSERT OR REPLACE INTO option_quotes (
                symbol, expiry, strike, right, bid, ask, last, mark,
                iv, delta, gamma, theta, vega, open_interest, volume,
                multiplier, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
        )?;
        for quote in quotes {
            stmt.execute(params![
                quote.symbol,
                quote.expiry.to_string(),
                quote.strike,
                quote.right.as_str(),
                quote.bid,
                quote.ask,
                quote.last,
                quote.mark,
                quote.iv,
                quote.delta,
                quote.gamma,
                quote.theta,
                quote.vega,
                quote.open_interest,
                quote.volume,
                quote.multiplier,
                snapshot.fetched_at,
            ])?;
        }
    }
    tx.execute(
        "INSERT INTO option_chain_snapshot (symbol, source, as_of, fetched_at, underlying, notes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(symbol) DO UPDATE SET
           source = excluded.source,
           as_of = excluded.as_of,
           fetched_at = excluded.fetched_at,
           underlying = excluded.underlying,
           notes = excluded.notes",
        params![
            snapshot.symbol,
            snapshot.source,
            snapshot.as_of,
            snapshot.fetched_at,
            snapshot.underlying,
            snapshot.notes,
        ],
    )?;
    tx.commit()?;
    Ok(())
}

pub fn snapshot(conn: &Connection, symbol: &str) -> Result<Option<ChainSnapshot>> {
    let mut stmt = conn.prepare(
        "SELECT symbol, source, as_of, fetched_at, underlying, notes
         FROM option_chain_snapshot WHERE symbol = ?1",
    )?;
    let row = stmt
        .query_row(params![symbol], |row| {
            Ok(ChainSnapshot {
                symbol: row.get(0)?,
                source: row.get(1)?,
                as_of: row.get(2)?,
                fetched_at: row.get(3)?,
                underlying: row.get(4)?,
                notes: row.get(5)?,
            })
        })
        .optional()?;
    Ok(row)
}

pub fn list_snapshots(conn: &Connection) -> Result<Vec<ChainSnapshot>> {
    let mut stmt = conn.prepare(
        "SELECT symbol, source, as_of, fetched_at, underlying, notes
         FROM option_chain_snapshot ORDER BY symbol",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(ChainSnapshot {
            symbol: row.get(0)?,
            source: row.get(1)?,
            as_of: row.get(2)?,
            fetched_at: row.get(3)?,
            underlying: row.get(4)?,
            notes: row.get(5)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn quotes(conn: &Connection, symbol: &str) -> Result<Vec<OptionQuote>> {
    let mut stmt = conn.prepare(
        "SELECT expiry, strike, right, bid, ask, last, mark,
                iv, delta, gamma, theta, vega, open_interest, volume, multiplier
         FROM option_quotes WHERE symbol = ?1
         ORDER BY expiry, strike, right",
    )?;
    let rows = stmt.query_map(params![symbol], |row| {
        let expiry: String = row.get(0)?;
        let right: String = row.get(2)?;
        Ok(OptionQuote {
            symbol: symbol.to_string(),
            expiry: crate::store::parse_date(&expiry)
                .map_err(|_| rusqlite::Error::InvalidQuery)?,
            strike: row.get(1)?,
            right: if right == "C" { Right::Call } else { Right::Put },
            bid: row.get(3)?,
            ask: row.get(4)?,
            last: row.get(5)?,
            mark: row.get(6)?,
            iv: row.get(7)?,
            delta: row.get(8)?,
            gamma: row.get(9)?,
            theta: row.get(10)?,
            vega: row.get(11)?,
            open_interest: row.get(12)?,
            volume: row.get(13)?,
            multiplier: row.get(14)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn quote_count(conn: &Connection, symbol: &str) -> Result<i64> {
    let count = conn.query_row(
        "SELECT COUNT(*) FROM option_quotes WHERE symbol = ?1",
        params![symbol],
        |row| row.get(0),
    )?;
    Ok(count)
}

/// A parsed manual row, before it is tied to a symbol and written.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedQuote {
    pub expiry: Date,
    pub strike: f64,
    pub right: Right,
    pub bid: Option<f64>,
    pub ask: Option<f64>,
    pub last: Option<f64>,
    pub iv: Option<f64>,
    pub open_interest: Option<i64>,
    pub volume: Option<i64>,
    pub multiplier: u32,
}

impl ParsedQuote {
    pub fn mark(&self) -> Option<f64> {
        match (self.bid, self.ask) {
            (Some(bid), Some(ask)) if bid > 0.0 && ask > 0.0 => Some((bid + ask) / 2.0),
            _ => self.last.or(self.bid).or(self.ask),
        }
    }

    pub fn into_quote(self, symbol: &str) -> OptionQuote {
        OptionQuote {
            symbol: symbol.to_string(),
            expiry: self.expiry,
            strike: self.strike,
            right: self.right,
            bid: self.bid,
            ask: self.ask,
            last: self.last,
            mark: self.mark(),
            iv: self.iv,
            delta: None,
            gamma: None,
            theta: None,
            vega: None,
            open_interest: self.open_interest,
            volume: self.volume,
            multiplier: self.multiplier,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChainRowError {
    pub line: usize,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct ParseOutcome {
    pub rows: Vec<ParsedQuote>,
    pub errors: Vec<ChainRowError>,
    pub headers: Vec<String>,
    pub delimiter: char,
}

/// Parse a pasted broker chain. Header aliases cover the common English and
/// Chinese exports; the first row must be a header.
pub fn parse_text(text: &str) -> Result<ParseOutcome> {
    let mut lines = text
        .lines()
        .enumerate()
        .filter(|(_, line)| !line.trim().is_empty() && !line.trim_start().starts_with('#'));
    let Some((_, header)) = lines.next() else {
        bail!("没有可解析的内容");
    };
    let delimiter = detect_delimiter(header);
    let headers = split_delimited(header, delimiter);
    if headers.len() < 3 {
        bail!("表头至少需要到期日、行权价和方向三列");
    }
    let columns = map_columns(&headers)?;
    let mut rows = BTreeMap::new();
    let mut errors = Vec::new();
    for (index, line) in lines {
        let cells = split_delimited(line, delimiter);
        if cells.iter().all(|cell| cell.trim().is_empty()) {
            continue;
        }
        match parse_row(&cells, &columns) {
            Ok(quote) => {
                let key = (
                    quote.expiry,
                    (quote.strike * 10_000.0).round() as i64,
                    quote.right,
                );
                rows.insert(key, quote);
            }
            Err(message) => errors.push(ChainRowError {
                line: index + 1,
                message,
            }),
        }
    }
    if rows.is_empty() && errors.is_empty() {
        bail!("表头下方没有数据行");
    }
    Ok(ParseOutcome {
        rows: rows.into_values().collect(),
        errors,
        headers: headers.iter().map(|header| header.trim().to_string()).collect(),
        delimiter,
    })
}

fn detect_delimiter(line: &str) -> char {
    let mut commas = 0;
    let mut semicolons = 0;
    let mut tabs = 0;
    let mut quoted = false;
    for ch in line.chars() {
        match ch {
            '"' => quoted = !quoted,
            ',' if !quoted => commas += 1,
            ';' if !quoted => semicolons += 1,
            '\t' if !quoted => tabs += 1,
            _ => {}
        }
    }
    if tabs >= commas && tabs >= semicolons && tabs > 0 {
        '\t'
    } else if semicolons > commas {
        ';'
    } else {
        ','
    }
}

fn split_delimited(line: &str, delimiter: char) -> Vec<String> {
    let mut cells = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '"' if quoted && chars.peek() == Some(&'"') => {
                current.push('"');
                chars.next();
            }
            '"' => quoted = !quoted,
            ch if ch == delimiter && !quoted => {
                cells.push(current.trim().to_string());
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    cells.push(current.trim().to_string());
    cells
}

#[derive(Debug, Clone, Copy)]
struct Columns {
    expiry: usize,
    strike: usize,
    right: usize,
    bid: Option<usize>,
    ask: Option<usize>,
    last: Option<usize>,
    iv: Option<usize>,
    open_interest: Option<usize>,
    volume: Option<usize>,
    multiplier: Option<usize>,
}

fn normalize_header(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .chars()
        .filter(|ch| !ch.is_whitespace() && !"_/()-.".contains(*ch))
        .collect()
}

fn find_column(headers: &[String], aliases: &[&str]) -> Option<usize> {
    headers.iter().position(|header| {
        let normalized = normalize_header(header);
        aliases.iter().any(|alias| normalized == *alias)
    })
}

fn map_columns(headers: &[String]) -> Result<Columns> {
    let expiry = find_column(
        headers,
        &["expiry", "expiration", "expirydate", "expirationdate", "到期日", "到期", "日期"],
    )
    .ok_or_else(|| anyhow::anyhow!("缺少到期日列"))?;
    let strike = find_column(headers, &["strike", "strikeprice", "行权价", "行使价"])
        .ok_or_else(|| anyhow::anyhow!("缺少行权价列"))?;
    let right = find_column(
        headers,
        &["right", "type", "callput", "cp", "direction", "方向", "类型", "看涨看跌"],
    )
    .ok_or_else(|| anyhow::anyhow!("缺少方向列（Call/Put 或 C/P）"))?;
    Ok(Columns {
        expiry,
        strike,
        right,
        bid: find_column(headers, &["bid", "买价", "买盘", "买入价"]),
        ask: find_column(headers, &["ask", "卖价", "卖盘", "卖出价"]),
        last: find_column(headers, &["last", "lastprice", "最新价", "现价", "成交价"]),
        iv: find_column(headers, &["iv", "impliedvolatility", "隐含波动率", "隐波"]),
        open_interest: find_column(
            headers,
            &["openinterest", "openint", "oi", "未平仓", "持仓量", "未平仓量"],
        ),
        volume: find_column(headers, &["volume", "vol", "成交量"]),
        multiplier: find_column(headers, &["multiplier", "每手股数", "乘数"]),
    })
}

fn cell<'a>(cells: &'a [String], index: Option<usize>) -> Option<&'a str> {
    index
        .and_then(|index| cells.get(index))
        .map(|value| value.as_str())
}

fn parse_row(cells: &[String], columns: &Columns) -> Result<ParsedQuote, String> {
    let expiry_text = cell(cells, Some(columns.expiry)).unwrap_or("");
    let expiry =
        parse_expiry(expiry_text).ok_or_else(|| format!("到期日无法识别：`{expiry_text}`"))?;
    let strike_text = cell(cells, Some(columns.strike)).unwrap_or("");
    let strike = parse_number(strike_text)
        .filter(|value| *value > 0.0)
        .ok_or_else(|| format!("行权价无法识别：`{strike_text}`"))?;
    let right_text = cell(cells, Some(columns.right)).unwrap_or("");
    let right = parse_right(right_text)
        .ok_or_else(|| format!("方向无法识别：`{right_text}`（需要 Call/Put 或 C/P）"))?;
    let bid = parse_number(cell(cells, columns.bid).unwrap_or(""));
    let ask = parse_number(cell(cells, columns.ask).unwrap_or(""));
    let last = parse_number(cell(cells, columns.last).unwrap_or(""));
    if bid.is_none() && ask.is_none() && last.is_none() {
        return Err("缺少买价 / 卖价 / 最新价".to_string());
    }
    let iv = parse_number(cell(cells, columns.iv).unwrap_or("")).map(|value| {
        if value > 1.5 && value <= 500.0 {
            value / 100.0
        } else {
            value
        }
    });
    let open_interest = parse_count(cell(cells, columns.open_interest).unwrap_or(""));
    let volume = parse_count(cell(cells, columns.volume).unwrap_or(""));
    let multiplier = parse_count(cell(cells, columns.multiplier).unwrap_or(""))
        .filter(|value| *value > 0)
        .map(|value| value as u32)
        .unwrap_or(100);
    Ok(ParsedQuote {
        expiry,
        strike,
        right,
        bid,
        ask,
        last,
        iv,
        open_interest,
        volume,
        multiplier,
    })
}

pub fn parse_expiry(text: &str) -> Option<Date> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    for format in [
        format_description!("[year]-[month]-[day]"),
        format_description!("[year]/[month]-[day]"),
        format_description!("[year]/[month]/[day]"),
        format_description!("[month]/[day]/[year]"),
        format_description!("[month padding:none]/[day padding:none]/[year]"),
        format_description!("[month repr:long] [day], [year]"),
        format_description!("[month repr:long] [day padding:none], [year]"),
        format_description!("[month repr:short] [day], [year]"),
        format_description!("[month repr:short] [day padding:none], [year]"),
        format_description!("[year][month][day]"),
    ] {
        if let Ok(date) = Date::parse(text, format) {
            return Some(date);
        }
    }
    None
}

pub fn parse_right(text: &str) -> Option<Right> {
    match text.trim().to_ascii_uppercase().as_str() {
        "C" | "CALL" | "看涨" | "认购" | "买权" => Some(Right::Call),
        "P" | "PUT" | "看跌" | "认沽" | "卖权" => Some(Right::Put),
        _ => None,
    }
}

fn parse_number(text: &str) -> Option<f64> {
    let cleaned = text
        .trim()
        .trim_start_matches('$')
        .replace([',', '%'], "");
    if cleaned.is_empty() || cleaned == "--" || cleaned == "-" || cleaned.eq_ignore_ascii_case("n/a")
    {
        return None;
    }
    cleaned
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
}

fn parse_count(text: &str) -> Option<i64> {
    parse_number(text).map(|value| value.round() as i64)
}

// ---------------------------------------------------------------------------
// Nasdaq delayed quotes
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct NasdaqResponse {
    data: Option<NasdaqData>,
}

#[derive(Deserialize)]
struct NasdaqData {
    #[serde(rename = "lastTrade")]
    last_trade: Option<String>,
    table: Option<NasdaqTable>,
}

#[derive(Deserialize)]
struct NasdaqTable {
    rows: Option<Vec<NasdaqRow>>,
}

#[derive(Deserialize)]
struct NasdaqRow {
    #[serde(rename = "expiryDate")]
    expiry_date: Option<String>,
    expirygroup: Option<String>,
    strike: Option<String>,
    #[serde(rename = "c_Bid")]
    c_bid: Option<String>,
    #[serde(rename = "c_Ask")]
    c_ask: Option<String>,
    #[serde(rename = "c_Last")]
    c_last: Option<String>,
    #[serde(rename = "c_Volume")]
    c_volume: Option<String>,
    #[serde(rename = "c_Openinterest")]
    c_open_interest: Option<String>,
    #[serde(rename = "p_Bid")]
    p_bid: Option<String>,
    #[serde(rename = "p_Ask")]
    p_ask: Option<String>,
    #[serde(rename = "p_Last")]
    p_last: Option<String>,
    #[serde(rename = "p_Volume")]
    p_volume: Option<String>,
    #[serde(rename = "p_Openinterest")]
    p_open_interest: Option<String>,
    #[serde(rename = "drillDownURL")]
    drill_down_url: Option<String>,
}

pub fn parse_nasdaq(
    symbol: &str,
    body: &str,
    fetched_at: &str,
    underlying: Option<f64>,
) -> Result<ChainFetch, String> {
    let response: NasdaqResponse =
        serde_json::from_str(body).map_err(|_| "Nasdaq 期权链响应不是有效 JSON".to_string())?;
    let data = response
        .data
        .ok_or_else(|| "Nasdaq 期权链没有返回数据（标的可能不存在或接口已变更）".to_string())?;
    let rows = data
        .table
        .and_then(|table| table.rows)
        .ok_or_else(|| "Nasdaq 期权链缺少 table.rows".to_string())?;
    let parsed_underlying = underlying.or_else(|| parse_last_trade(data.last_trade.as_deref()));
    let mut quotes = BTreeMap::new();
    let mut current_expiry: Option<Date> = None;
    let mut skipped = 0usize;
    for row in rows {
        if let Some(group) = row.expirygroup.as_deref() {
            if !group.trim().is_empty() {
                if let Some(date) = parse_expiry(group) {
                    current_expiry = Some(date);
                }
            }
        }
        let Some(strike) = row.strike.as_deref().and_then(parse_number) else {
            // Group header rows carry the expiry but no strike.
            continue;
        };
        if strike <= 0.0 {
            continue;
        }
        let occ = row.drill_down_url.as_deref().and_then(occ_contract);
        let expiry = current_expiry
            .or_else(|| occ.map(|(date, _)| date))
            .or_else(|| row.expiry_date.as_deref().and_then(parse_expiry));
        let Some(expiry) = expiry else {
            skipped += 1;
            continue;
        };
        let strike = occ.map(|(_, occ_strike)| occ_strike).unwrap_or(strike);
        for (right, bid, ask, last, oi, volume) in [
            (
                Right::Call,
                row.c_bid.as_deref(),
                row.c_ask.as_deref(),
                row.c_last.as_deref(),
                row.c_open_interest.as_deref(),
                row.c_volume.as_deref(),
            ),
            (
                Right::Put,
                row.p_bid.as_deref(),
                row.p_ask.as_deref(),
                row.p_last.as_deref(),
                row.p_open_interest.as_deref(),
                row.p_volume.as_deref(),
            ),
        ] {
            let bid = bid.and_then(parse_number);
            let ask = ask.and_then(parse_number);
            let last = last.and_then(parse_number);
            if bid.is_none() && ask.is_none() && last.is_none() {
                continue;
            }
            let mark = match (bid, ask) {
                (Some(bid), Some(ask)) if bid > 0.0 && ask > 0.0 => Some((bid + ask) / 2.0),
                _ => last.or(bid).or(ask),
            };
            let key = (expiry, (strike * 10_000.0).round() as i64, right);
            quotes.insert(
                key,
                OptionQuote {
                    symbol: symbol.to_string(),
                    expiry,
                    strike,
                    right,
                    bid,
                    ask,
                    last,
                    mark,
                    iv: None,
                    delta: None,
                    gamma: None,
                    theta: None,
                    vega: None,
                    open_interest: oi.and_then(parse_count),
                    volume: volume.and_then(parse_count),
                    multiplier: 100,
                },
            );
        }
    }
    if quotes.is_empty() {
        return Err(format!(
            "Nasdaq 没有返回可用的期权合约（跳过 {skipped} 行缺少到期日）"
        ));
    }
    let quotes: Vec<OptionQuote> = quotes.into_values().collect();
    if quotes.len() > 20_000 {
        return Err("期权链超过 20,000 条，已拒绝写入".to_string());
    }
    Ok(ChainFetch {
        snapshot: ChainSnapshot {
            symbol: symbol.to_string(),
            source: "nasdaq".to_string(),
            as_of: fetched_at.to_string(),
            fetched_at: fetched_at.to_string(),
            underlying: parsed_underlying,
            notes: "Nasdaq 延迟报价（约 15 分钟）；时间为本机获取时间".to_string(),
        },
        quotes,
    })
}

fn parse_last_trade(text: Option<&str>) -> Option<f64> {
    let text = text?;
    let start = text.find('$')? + 1;
    let rest = &text[start..];
    let end = rest
        .find(|ch: char| !(ch.is_ascii_digit() || ch == '.'))
        .unwrap_or(rest.len());
    parse_number(&rest[..end])
}

/// Nasdaq rows carry an OCC code such as `aapl--261218c00315000`.
fn occ_contract(url: &str) -> Option<(Date, f64)> {
    let token = url.rsplit('/').next()?.rsplit("--").next()?;
    if token.len() < 15 {
        return None;
    }
    let code = &token[token.len() - 15..];
    let year: i32 = code.get(0..2)?.parse().ok()?;
    let month: u8 = code.get(2..4)?.parse().ok()?;
    let day: u8 = code.get(4..6)?.parse().ok()?;
    let right = code.as_bytes().get(6).copied()?.to_ascii_uppercase();
    if right != b'C' && right != b'P' {
        return None;
    }
    let strike: f64 = code.get(7..15)?.parse().ok()?;
    let month = Month::try_from(month).ok()?;
    let date = Date::from_calendar_date(2000 + year, month, day).ok()?;
    Some((date, strike / 1000.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_chinese_and_english_headers() {
        let text = "到期日,行权价,方向,买价,卖价,未平仓\n2026-12-18,160,Call,3.10,3.30,1200\n2026/12/18,140,认沽,3.90,4.10,900\n";
        let result = parse_text(text).unwrap();
        assert_eq!(result.rows.len(), 2);
        let call = result
            .rows
            .iter()
            .find(|quote| quote.right == Right::Call)
            .unwrap();
        assert_eq!(call.mark(), Some(3.2));
        let put = result
            .rows
            .iter()
            .find(|quote| quote.right == Right::Put)
            .unwrap();
        assert_eq!(put.strike, 140.0);
        assert_eq!(result.errors.len(), 0);
    }

    #[test]
    fn rejects_missing_prices() {
        let text = "expiry,strike,type,bid,ask\n2026-12-18,160,C,--,--\n";
        let result = parse_text(text).unwrap();
        assert!(result.rows.is_empty());
        assert_eq!(result.errors.len(), 1);
    }

    #[test]
    fn parses_expiry_formats() {
        assert_eq!(
            parse_expiry("2026-12-18"),
            Date::from_calendar_date(2026, Month::December, 18).ok()
        );
        assert_eq!(
            parse_expiry("12/18/2026"),
            Date::from_calendar_date(2026, Month::December, 18).ok()
        );
        assert_eq!(
            parse_expiry("December 18, 2026"),
            Date::from_calendar_date(2026, Month::December, 18).ok()
        );
        assert_eq!(
            parse_expiry("20261218"),
            Date::from_calendar_date(2026, Month::December, 18).ok()
        );
    }

    #[test]
    fn parses_occ_contract() {
        let (date, strike) = occ_contract(
            "/market-activity/stocks/aapl/option-chain/call-put-options/aapl--261218c00315000",
        )
        .unwrap();
        assert_eq!(
            date,
            Date::from_calendar_date(2026, Month::December, 18).unwrap()
        );
        assert!((strike - 315.0).abs() < 1e-9);
    }

    #[test]
    fn parses_nasdaq_rows_and_groups() {
        let body = r#"{
          "data": {
            "lastTrade": "LAST TRADE: $349.21 (AS OF NOV 20, 2026)",
            "table": {
              "rows": [
                { "expirygroup": "December 18, 2026", "expiryDate": null, "strike": null },
                { "expirygroup": "", "expiryDate": "Dec 18", "strike": "315.00",
                  "c_Bid": "30.10", "c_Ask": "30.70", "c_Last": "30.40",
                  "c_Volume": "40", "c_Openinterest": "5,025",
                  "p_Bid": "1.60", "p_Ask": "1.70", "p_Last": "1.65",
                  "p_Volume": "1072", "p_Openinterest": "11,835",
                  "drillDownURL": "/market-activity/stocks/aapl/option-chain/call-put-options/aapl--261218c00315000" }
              ]
            }
          }
        }"#;
        let fetch = parse_nasdaq("AAPL", body, "2026-11-20 15:42:00", None).unwrap();
        assert_eq!(fetch.quotes.len(), 2);
        assert_eq!(fetch.snapshot.underlying, Some(349.21));
        let call = fetch
            .quotes
            .iter()
            .find(|quote| quote.right == Right::Call)
            .unwrap();
        assert_eq!(call.open_interest, Some(5025));
        assert!((call.mark.unwrap() - 30.4).abs() < 1e-9);
        let put = fetch
            .quotes
            .iter()
            .find(|quote| quote.right == Right::Put)
            .unwrap();
        assert_eq!(put.open_interest, Some(11835));
    }
}
