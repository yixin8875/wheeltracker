//! Email / pasted-text import.
//!
//! The module decodes common MIME layouts (multipart, base64,
//! quoted-printable, HTML) into plain text, then extracts broker trade
//! confirmations line by line. Extracted trades are emitted as a synthetic
//! CSV document with a fixed header so the existing CSV preview / commit
//! pipeline (deduplication, validation, atomic insert) is reused unchanged.
//!
//! Extraction is deliberately conservative: a line is only turned into an
//! event when the direction, contract or symbol, quantity and (where needed)
//! price are all present. Anything else is reported as a warning instead of
//! being guessed.

use std::sync::OnceLock;

use base64::Engine as _;
use regex::Regex;

use crate::import::{self, DateFormat, OccOption};

/// Upper bound for email text (decoded or pasted).
pub const MAX_TEXT_BYTES: usize = 8 * 1024 * 1024;

const CSV_HEADER: &str =
    "日期,方向,代码,数量,价格,费用,到期日,行权价,看涨看跌,乘数,备注";

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

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Decode and extract trades from an email document or pasted broker text.
pub fn extract(text: &str, source: Option<&str>) -> Result<Extraction, String> {
    if text.trim().is_empty() {
        return Err("内容为空".to_string());
    }
    if text.len() > MAX_TEXT_BYTES {
        return Err(format!(
            "内容超过 {} MB 上限，请拆分后再导入",
            MAX_TEXT_BYTES / 1024 / 1024
        ));
    }

    let mut warnings = Vec::new();
    let decoded = decode_if_mime(text, &mut warnings);
    let mut body = normalize_text(&decoded);
    if !body.trim().is_empty() && looks_like_html(&body) {
        body = html_to_text(&body);
    }
    if body.trim().is_empty() {
        return Err("邮件正文为空，无法识别交易".to_string());
    }

    let template = detect_template(&body, source);
    let trades = extract_trades(&body, &template, &mut warnings);

    if trades.is_empty() {
        let detail = if warnings.is_empty() {
            String::new()
        } else {
            format!("：{}", warnings.join("；"))
        };
        return Err(format!(
            "未识别到可导入的交易{detail}。请确认邮件包含成交信息，或改用 CSV 导入。"
        ));
    }

    let csv = build_csv(&trades);
    Ok(Extraction {
        template,
        trades,
        warnings,
        csv,
    })
}

// ---------------------------------------------------------------------------
// MIME decoding
// ---------------------------------------------------------------------------

fn looks_like_mime(text: &str) -> bool {
    let head: String = text.chars().take(4096).collect();
    let lower = head.to_lowercase();
    lower.contains("mime-version:")
        || (lower.contains("content-type:")
            && (lower.contains("content-transfer-encoding:") || lower.contains("boundary=")))
}

fn decode_if_mime(text: &str, warnings: &mut Vec<String>) -> String {
    if !looks_like_mime(text) {
        return text.to_string();
    }
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let (headers, body) = split_entity(&normalized);
    let header_map = parse_headers(headers);
    let content_type = header_map
        .get("content-type")
        .cloned()
        .unwrap_or_else(|| "text/plain".to_string());
    let charset = header_param(&content_type, "charset");
    if let Some(charset) = &charset {
        let lower = charset.to_lowercase();
        if !matches!(
            lower.as_str(),
            "utf-8" | "utf8" | "us-ascii" | "ascii" | "iso-8859-1" | "latin1"
        ) {
            push_warning(
                warnings,
                format!("邮件声明字符集 {charset}，当前按 UTF-8 解码，如出现乱码请另存为 UTF-8 后重试。"),
            );
        }
    }

    let boundary = header_param(&content_type, "boundary");
    let mut parts: Vec<String> = Vec::new();
    if let Some(boundary) = boundary {
        let mut plain = Vec::new();
        let mut html = Vec::new();
        for part in split_multipart(body, &boundary) {
            let (part_headers, part_body) = split_entity(&part);
            let map = parse_headers(part_headers);
            let part_type = map
                .get("content-type")
                .cloned()
                .unwrap_or_else(|| "text/plain".to_string());
            let lower_type = part_type.to_lowercase();
            if !lower_type.starts_with("text/") {
                continue;
            }
            let decoded = decode_transfer(
                part_body,
                map.get("content-transfer-encoding").map(String::as_str),
            );
            if lower_type.starts_with("text/html") {
                html.push(html_to_text(&decoded));
            } else {
                plain.push(decoded);
            }
        }
        if !plain.is_empty() {
            parts = plain;
        } else if !html.is_empty() {
            parts = html;
        }
    } else {
        let decoded = decode_transfer(
            body,
            header_map
                .get("content-transfer-encoding")
                .map(String::as_str),
        );
        parts.push(if content_type.to_lowercase().starts_with("text/html") {
            html_to_text(&decoded)
        } else {
            decoded
        });
    }

    if parts.is_empty() {
        push_warning(warnings, "邮件没有可读取的文本正文。".to_string());
    }
    parts.join("\n")
}

fn split_entity(text: &str) -> (&str, &str) {
    match text.find("\n\n") {
        Some(index) => (&text[..index], &text[index + 2..]),
        None => ("", text),
    }
}

fn parse_headers(block: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let mut current = String::new();
    let mut value = String::new();
    for line in block.lines() {
        if line.starts_with(' ') || line.starts_with('\t') {
            value.push(' ');
            value.push_str(line.trim());
            continue;
        }
        if !current.is_empty() {
            map.insert(current.to_lowercase(), value.trim().to_string());
        }
        current.clear();
        value.clear();
        if let Some((name, rest)) = line.split_once(':') {
            current = name.trim().to_string();
            value = rest.trim().to_string();
        }
    }
    if !current.is_empty() {
        map.insert(current.to_lowercase(), value.trim().to_string());
    }
    map
}

fn header_param(value: &str, key: &str) -> Option<String> {
    let pattern = format!(r#"(?i)\b{}\s*=\s*"?([^";]+)"?"#, regex::escape(key));
    let regex = Regex::new(&pattern).ok()?;
    regex
        .captures(value)
        .and_then(|caps| caps.get(1))
        .map(|matched| matched.as_str().trim().to_string())
}

fn split_multipart(body: &str, boundary: &str) -> Vec<String> {
    let marker = format!("--{boundary}");
    let closing = format!("--{boundary}--");
    let mut parts = Vec::new();
    let mut current: Option<String> = None;
    for line in body.lines() {
        let trimmed = line.trim_end();
        if trimmed == marker || trimmed == closing {
            if let Some(part) = current.take() {
                parts.push(part);
            }
            if trimmed == closing {
                break;
            }
            current = Some(String::new());
        } else if let Some(part) = current.as_mut() {
            part.push_str(line);
            part.push('\n');
        }
    }
    if let Some(part) = current {
        parts.push(part);
    }
    parts
}

fn decode_transfer(body: &str, encoding: Option<&str>) -> String {
    match encoding.unwrap_or("7bit").trim().to_lowercase().as_str() {
        "base64" => {
            let cleaned: String = body.chars().filter(|ch| !ch.is_whitespace()).collect();
            let aligned = format!("{}{}", cleaned, "=".repeat((4 - cleaned.len() % 4) % 4));
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(aligned.as_bytes())
                .or_else(|_| {
                    base64::engine::general_purpose::STANDARD_NO_PAD.decode(cleaned.as_bytes())
                })
                .unwrap_or_default();
            String::from_utf8_lossy(&bytes).to_string()
        }
        "quoted-printable" => decode_quoted_printable(body),
        _ => body.to_string(),
    }
}

fn decode_quoted_printable(body: &str) -> String {
    let bytes = body.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'=' if index + 1 < bytes.len() && bytes[index + 1] == b'\n' => {
                index += 2;
            }
            b'=' if index + 2 < bytes.len()
                && bytes[index + 1] == b'\r'
                && bytes[index + 2] == b'\n' =>
            {
                index += 3;
            }
            b'=' if index + 2 < bytes.len() => {
                let hex = &body[index + 1..index + 3];
                if let Ok(value) = u8::from_str_radix(hex, 16) {
                    out.push(value);
                    index += 3;
                } else {
                    out.push(bytes[index]);
                    index += 1;
                }
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

fn looks_like_html(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("<html")
        || lower.contains("<body")
        || lower.contains("<div")
        || lower.contains("<table")
        || lower.contains("<p>")
}

fn html_to_text(input: &str) -> String {
    static SCRIPT: OnceLock<Regex> = OnceLock::new();
    static STYLE: OnceLock<Regex> = OnceLock::new();
    static BREAK: OnceLock<Regex> = OnceLock::new();
    static BLOCK: OnceLock<Regex> = OnceLock::new();
    static CELL: OnceLock<Regex> = OnceLock::new();
    static TAG: OnceLock<Regex> = OnceLock::new();
    let script = SCRIPT.get_or_init(|| Regex::new(r"(?is)<script\b[^>]*>.*?</script>").unwrap());
    let style = STYLE.get_or_init(|| Regex::new(r"(?is)<style\b[^>]*>.*?</style>").unwrap());
    let br = BREAK.get_or_init(|| Regex::new(r"(?i)<br\s*/?>").unwrap());
    let block = BLOCK.get_or_init(|| {
        Regex::new(r"(?i)</(?:p|div|tr|li|h[1-6]|table|section|article|blockquote)>").unwrap()
    });
    let cell = CELL.get_or_init(|| Regex::new(r"(?i)</(?:td|th)>").unwrap());
    let tag = TAG.get_or_init(|| Regex::new(r"(?s)<[^>]+>").unwrap());

    let mut text = script.replace_all(input, " ").to_string();
    text = style.replace_all(&text, " ").to_string();
    text = br.replace_all(&text, "\n").to_string();
    text = block.replace_all(&text, "\n").to_string();
    text = cell.replace_all(&text, "\t").to_string();
    text = tag.replace_all(&text, "").to_string();
    decode_entities(&text)
}

fn decode_entities(input: &str) -> String {
    static NUMERIC: OnceLock<Regex> = OnceLock::new();
    static HEX: OnceLock<Regex> = OnceLock::new();
    let numeric = NUMERIC.get_or_init(|| Regex::new(r"&#(\d+);").unwrap());
    let hex = HEX.get_or_init(|| Regex::new(r"&#[xX]([0-9a-fA-F]+);").unwrap());

    let mut text = input
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&mdash;", "—")
        .replace("&ndash;", "–");
    text = numeric
        .replace_all(&text, |caps: &regex::Captures<'_>| {
            caps.get(1)
                .and_then(|m| m.as_str().parse::<u32>().ok())
                .and_then(char::from_u32)
                .map(|ch| ch.to_string())
                .unwrap_or_default()
        })
        .to_string();
    text = hex
        .replace_all(&text, |caps: &regex::Captures<'_>| {
            caps.get(1)
                .and_then(|m| u32::from_str_radix(m.as_str(), 16).ok())
                .and_then(char::from_u32)
                .map(|ch| ch.to_string())
                .unwrap_or_default()
        })
        .to_string();
    text
}

fn normalize_text(input: &str) -> String {
    input
        .replace('\r', "\n")
        .replace(['\u{feff}', '\u{200b}'], "")
        .replace('\u{a0}', " ")
        .lines()
        .map(collapse_ws)
        .collect::<Vec<_>>()
        .join("\n")
}

fn collapse_ws(line: &str) -> String {
    line.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn detect_template(body: &str, source: Option<&str>) -> String {
    let mut haystack = body.chars().take(4000).collect::<String>().to_lowercase();
    if let Some(source) = source {
        haystack.push(' ');
        haystack.push_str(&source.to_lowercase());
    }
    const TEMPLATES: &[(&str, &str)] = &[
        ("schwab", "Schwab"),
        ("charles schwab", "Schwab"),
        ("fidelity", "Fidelity"),
        ("interactive brokers", "IBKR"),
        ("ibkr", "IBKR"),
        ("富途", "富途"),
        ("futu", "富途"),
        ("moomoo", "富途"),
        ("老虎", "老虎证券"),
        ("tiger brokers", "老虎证券"),
        ("嘉信", "Schwab"),
        ("盈透", "IBKR"),
    ];
    for (needle, name) in TEMPLATES {
        if haystack.contains(needle) {
            return (*name).to_string();
        }
    }
    "通用邮件".to_string()
}

// ---------------------------------------------------------------------------
// Trade extraction
// ---------------------------------------------------------------------------

enum Outcome {
    Trade(ExtractedTrade, Vec<String>),
    Fragment(String),
    Rejected(String),
    Skip,
}

fn extract_trades(body: &str, template: &str, warnings: &mut Vec<String>) -> Vec<ExtractedTrade> {
    let lines: Vec<String> = body
        .lines()
        .map(collapse_ws)
        .filter(|line| !line.is_empty())
        .collect();
    let mut trades: Vec<ExtractedTrade> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let mut index = 0;

    while index < lines.len() {
        let line_no = index + 1;
        let context = lines[index.saturating_sub(4)..index].join(" ");
        let mut found: Option<(ExtractedTrade, usize)> = None;
        let mut fragment = String::new();
        let mut rejected: Option<String> = None;

        for take in 1..=3 {
            let end = index + take;
            if end > lines.len() {
                break;
            }
            let window = lines[index..end].join(" ");
            match parse_trade(&window, line_no, &context, template) {
                Outcome::Trade(trade, trade_warnings) => {
                    for warning in trade_warnings {
                        push_warning(warnings, warning);
                    }
                    found = Some((trade, take));
                    break;
                }
                Outcome::Fragment(reason) => {
                    fragment = reason;
                    if index + take >= lines.len()
                        || !continues_fragment(&lines[index + take], &fragment)
                    {
                        break;
                    }
                }
                Outcome::Rejected(reason) => {
                    rejected = Some(reason);
                    break;
                }
                Outcome::Skip => break,
            }
        }

        if let Some((mut trade, take)) = found {
            let mut end = index + take;
            let mut extra = 0;
            while end < lines.len() && extra < 2 {
                let line = &lines[end];
                if trade.fees == 0.0 && is_fee_line(line) {
                    trade.fees = find_fees(line).unwrap_or(0.0);
                    end += 1;
                    extra += 1;
                    continue;
                }
                if trade.price <= 0.0 && is_price_line(line) {
                    if let Some(price) = find_price(line) {
                        trade.price = price;
                        end += 1;
                        extra += 1;
                        continue;
                    }
                }
                break;
            }

            let key = fingerprint(&trade);
            if seen.iter().any(|existing| existing == &key) {
                push_warning(
                    warnings,
                    format!("第 {line_no} 行与前面的记录重复，已合并。"),
                );
            } else {
                seen.push(key);
                trades.push(trade);
            }
            index = end;
            continue;
        }

        if let Some(reason) = rejected {
            push_warning(warnings, format!("第 {line_no} 行：{reason}，已跳过。"));
        } else if !fragment.is_empty() && looks_trade_like(&lines[index]) {
            push_warning(warnings, format!("第 {line_no} 行：{fragment}，已跳过。"));
        }
        index += 1;
    }

    trades
}

/// Whether the next line plausibly completes the current fragment instead of
/// starting an unrelated trade. A new action or dividend line never merges.
fn continues_fragment(next: &str, reason: &str) -> bool {
    if action_kind(next).is_some() || is_dividend(next) {
        return false;
    }
    if reason.contains("合约") {
        return find_contract(next).is_some() || find_occ(next).is_some();
    }
    if reason.contains("成交价") {
        return find_price(next).is_some() || is_price_line(next);
    }
    if reason.contains("日期") {
        return !find_dates(next).is_empty();
    }
    if reason.contains("数量") {
        return next.chars().any(|ch| ch.is_ascii_digit());
    }
    false
}

fn parse_trade(text: &str, line_no: usize, context: &str, template: &str) -> Outcome {
    let dividend = is_dividend(text);
    let action = action_kind(text);
    if let Some(Err(message)) = &action {
        return Outcome::Rejected(message.clone());
    }
    let contract = find_occ(text).or_else(|| find_contract(text));

    if action.is_none() && contract.is_none() && !dividend {
        return Outcome::Skip;
    }
    // Option quotes / contract references carry a contract but no direction.
    if action.is_none() && !dividend {
        return Outcome::Skip;
    }
    if action.is_none() && dividend && !text.chars().any(|ch| ch.is_ascii_digit()) {
        return Outcome::Skip;
    }

    let mut kind = match action
        .as_ref()
        .and_then(|result| result.as_ref().ok().copied())
    {
        Some("shares_buy") if contract.is_some() => "option_close",
        Some("shares_sell") if contract.is_some() => "option_open_short",
        Some(kind) => kind,
        None => "dividend",
    };
    if contract.is_some() && matches!(kind, "shares_buy" | "shares_sell") {
        kind = if kind == "shares_buy" {
            "option_close"
        } else {
            "option_open_short"
        };
    }

    let option_kind = kind.starts_with("option_");
    if option_kind && contract.is_none() {
        return Outcome::Fragment(
            "未识别到期权合约（代码、到期日、行权价、看涨/看跌）".to_string(),
        );
    }

    let symbol = if option_kind {
        contract
            .as_ref()
            .map(|value| value.underlying.clone())
            .unwrap_or_default()
    } else if kind == "dividend" {
        match find_dividend_symbol(text) {
            Some(symbol) => symbol,
            None => return Outcome::Fragment("未识别到分红标的".to_string()),
        }
    } else {
        match find_shares_symbol(text) {
            Some(symbol) => symbol,
            None => return Outcome::Fragment("未识别到标的代码".to_string()),
        }
    };
    let Some(symbol) = sanitize_symbol(&symbol) else {
        return Outcome::Fragment(format!("标的代码 `{symbol}` 无法识别"));
    };

    let qty = match if kind == "dividend" {
        find_dividend_qty(text)
    } else {
        find_qty(text, option_kind)
    } {
        Some(qty) => qty,
        None => return Outcome::Fragment("未找到数量".to_string()),
    };

    let mut price = find_price(text).unwrap_or(0.0);
    let mut fees = find_fees(text).unwrap_or(0.0);
    let mut amount = 0.0;

    if kind == "dividend" {
        let Some((per_share, total)) = find_dividend_amount(text, qty) else {
            return Outcome::Fragment("未找到分红金额".to_string());
        };
        price = per_share;
        amount = total;
    } else if matches!(
        kind,
        "shares_buy" | "shares_sell" | "option_open_short" | "option_close"
    ) && price <= 0.0
    {
        return Outcome::Fragment("未找到成交价".to_string());
    } else if matches!(kind, "option_expire" | "option_assign") {
        price = 0.0;
        fees = 0.0;
        amount = 0.0;
    }

    let Some((date, ambiguous_date)) = resolve_date(text, context, contract.as_ref()) else {
        return Outcome::Fragment("未找到交易日期".to_string());
    };

    let (expiry, strike, right) = match &contract {
        Some(contract) => (
            Some(contract.expiry.clone()),
            Some(contract.strike),
            Some(contract.right.clone()),
        ),
        None => (None, None, None),
    };

    let trade = ExtractedTrade {
        date,
        kind: kind.to_string(),
        symbol,
        qty,
        price: round_money(price),
        fees: round_money(fees.abs()),
        expiry,
        strike,
        right,
        multiplier: 100,
        amount: round_money(amount.abs()),
        note: format!("{template} · 第 {line_no} 行"),
    };

    let mut warnings = Vec::new();
    if ambiguous_date {
        push_warning(
            &mut warnings,
            "按月/日/年解析日期，请确认无误。".to_string(),
        );
    }
    Outcome::Trade(trade, warnings)
}

// ---------------------------------------------------------------------------
// Field extraction
// ---------------------------------------------------------------------------

fn action_kind(text: &str) -> Option<Result<&'static str, String>> {
    static UNSUPPORTED: OnceLock<Regex> = OnceLock::new();
    static OPEN_SHORT: OnceLock<Regex> = OnceLock::new();
    static CLOSE: OnceLock<Regex> = OnceLock::new();
    static EXPIRE: OnceLock<Regex> = OnceLock::new();
    static ASSIGN: OnceLock<Regex> = OnceLock::new();
    static BUY: OnceLock<Regex> = OnceLock::new();
    static SELL: OnceLock<Regex> = OnceLock::new();

    let unsupported = UNSUPPORTED.get_or_init(|| {
        Regex::new(r"(?i)\b(?:bto|buy\s+to\s+open|stc|sell\s+to\s+close)\b|买入开仓|卖出平仓")
            .unwrap()
    });
    let open_short = OPEN_SHORT.get_or_init(|| {
        Regex::new(r"(?i)\b(?:sto|sell\s+to\s+open|sold\s+to\s+open)\b|卖出开仓|卖开").unwrap()
    });
    let close = CLOSE.get_or_init(|| {
        Regex::new(r"(?i)\b(?:btc|buy\s+to\s+close|bought\s+to\s+close)\b|买入平仓|买平").unwrap()
    });
    let expire =
        EXPIRE.get_or_init(|| Regex::new(r"(?i)\bexpired?\b|到期作废|已到期|作废").unwrap());
    let assign = ASSIGN.get_or_init(|| {
        Regex::new(r"(?i)\b(?:assigned|assignment|exercised)\b|被指派|指派|已行权").unwrap()
    });
    let buy = BUY.get_or_init(|| Regex::new(r"(?i)\b(?:bought|buy|purchase[ds]?)\b|买入").unwrap());
    let sell = SELL.get_or_init(|| Regex::new(r"(?i)\b(?:sold|sell)\b|卖出").unwrap());

    if unsupported.is_match(text) {
        return Some(Err("暂不支持做多期权操作".to_string()));
    }
    if open_short.is_match(text) {
        return Some(Ok("option_open_short"));
    }
    if close.is_match(text) {
        return Some(Ok("option_close"));
    }
    if expire.is_match(text) {
        return Some(Ok("option_expire"));
    }
    if assign.is_match(text) {
        return Some(Ok("option_assign"));
    }
    if buy.is_match(text) {
        return Some(Ok("shares_buy"));
    }
    if sell.is_match(text) {
        return Some(Ok("shares_sell"));
    }
    None
}

fn is_dividend(text: &str) -> bool {
    static DIVIDEND: OnceLock<Regex> = OnceLock::new();
    let regex = DIVIDEND
        .get_or_init(|| Regex::new(r"(?i)\b(?:cash\s+)?dividends?\b|分红|股息|红利").unwrap());
    regex.is_match(text)
}

fn find_occ(text: &str) -> Option<OccOption> {
    static CANDIDATE: OnceLock<Regex> = OnceLock::new();
    let regex = CANDIDATE.get_or_init(|| Regex::new(r"[A-Za-z0-9]{16,24}").unwrap());
    for matched in regex.find_iter(text) {
        if let Some(occ) = import::parse_occ_symbol(matched.as_str()) {
            return Some(occ);
        }
    }
    None
}

const DATE_PATTERN: &str = r"(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}/\d{1,2}/\d{2,4}|\d{4}年\d{1,2}月\d{1,2}日|\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{2,4}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})";

fn find_contract(text: &str) -> Option<OccOption> {
    static CONTRACT: OnceLock<Regex> = OnceLock::new();
    let regex = CONTRACT.get_or_init(|| {
        Regex::new(&format!(
            r"(?i)\b([a-z][a-z0-9]{{0,5}})\s+({DATE_PATTERN})\s+\$?(\d+(?:,\d{{3}})*(?:\.\d+)?)\s+(put|puts|call|calls|p|c)\b"
        ))
        .unwrap()
    });
    let caps = regex.captures(text)?;
    let symbol = caps.get(1)?.as_str().to_uppercase();
    if is_stopword(&symbol) {
        return None;
    }
    let expiry = normalize_any_date(caps.get(2)?.as_str())?;
    let strike = import::parse_number(caps.get(3)?.as_str()).ok()?;
    let right = match caps.get(4)?.as_str().to_lowercase().as_str() {
        "p" | "put" | "puts" => "P",
        _ => "C",
    };
    if strike <= 0.0 {
        return None;
    }
    Some(OccOption {
        underlying: symbol,
        expiry,
        strike,
        right: right.to_string(),
    })
}

fn find_shares_symbol(text: &str) -> Option<String> {
    static AFTER_ACTION: OnceLock<Regex> = OnceLock::new();
    static BEFORE_ACTION: OnceLock<Regex> = OnceLock::new();
    let after = AFTER_ACTION.get_or_init(|| {
        Regex::new(
            r"(?i)\b(?:bought|buy|sold|sell|purchased|purchase)\s+(?:to\s+(?:open|close)\s+)?(?:[+-]?\d[\d,]*\s+)?(?:(?:shares?|股)\s+(?:of\s+)?)?([a-z][a-z0-9.]{0,6})\b",
        )
        .unwrap()
    });
    let before = BEFORE_ACTION.get_or_init(|| {
        Regex::new(r"(?i)\b([a-z][a-z0-9.]{0,6})\s+(?:shares?\s+)?(?:bought|sold|买入|卖出)\b")
            .unwrap()
    });
    for regex in [after, before] {
        for caps in regex.captures_iter(text) {
            if let Some(symbol) = caps.get(1).map(|m| m.as_str().to_string()) {
                if !is_stopword(&symbol) {
                    return Some(symbol);
                }
            }
        }
    }
    None
}

fn find_dividend_symbol(text: &str) -> Option<String> {
    static SYMBOL_FIRST: OnceLock<Regex> = OnceLock::new();
    static DIVIDEND_FIRST: OnceLock<Regex> = OnceLock::new();
    let symbol_first = SYMBOL_FIRST.get_or_init(|| {
        Regex::new(r"(?i)\b([a-z][a-z0-9.]{0,6})\s+(?:cash\s+)?dividends?\b").unwrap()
    });
    let dividend_first = DIVIDEND_FIRST.get_or_init(|| {
        Regex::new(r"(?i)\bdividends?\s+(?:on|for|of)\s+([a-z][a-z0-9.]{0,6})\b").unwrap()
    });
    for regex in [symbol_first, dividend_first] {
        for caps in regex.captures_iter(text) {
            if let Some(symbol) = caps.get(1).map(|m| m.as_str().to_string()) {
                if !is_stopword(&symbol) {
                    return Some(symbol);
                }
            }
        }
    }
    None
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

fn find_qty(text: &str, option: bool) -> Option<u32> {
    static OPTION_ACTION: OnceLock<Regex> = OnceLock::new();
    static OPTION_UNITS: OnceLock<Regex> = OnceLock::new();
    static SHARES_ACTION: OnceLock<Regex> = OnceLock::new();
    static SHARES_UNITS: OnceLock<Regex> = OnceLock::new();
    static SHARES_BARE: OnceLock<Regex> = OnceLock::new();

    let patterns: Vec<&Regex> = if option {
        vec![
            OPTION_ACTION.get_or_init(|| {
                Regex::new(
                    r"(?i)\b(?:sold|sell|bought|buy|sto|btc|assigned|expired|expire)\s+(?:to\s+(?:open|close)\s+)?([+-]?\d+)\b",
                )
                .unwrap()
            }),
            OPTION_UNITS.get_or_init(|| {
                Regex::new(r"(?i)([+-]?\d+)\s*(?:contracts?|张|手)\b").unwrap()
            }),
        ]
    } else {
        vec![
            SHARES_ACTION.get_or_init(|| {
                Regex::new(
                    r"(?i)\b(?:bought|buy|sold|sell|purchased|purchase)\s+(?:to\s+(?:open|close)\s+)?([+-]?\d+)\b",
                )
                .unwrap()
            }),
            SHARES_UNITS
                .get_or_init(|| Regex::new(r"(?i)([+-]?\d+)\s*(?:shares?|股)\b").unwrap()),
            SHARES_BARE.get_or_init(|| {
                Regex::new(r"(?i)\b([+-]?\d+)\s+(?:shares?\s+of\s+)?[a-z][a-z0-9.]{0,5}\b")
                    .unwrap()
            }),
        ]
    };

    for regex in patterns {
        for caps in regex.captures_iter(text) {
            if let Some(value) = caps.get(1).and_then(|m| m.as_str().parse::<i64>().ok()) {
                let qty = value.unsigned_abs();
                if (1..=1_000_000).contains(&qty) {
                    return Some(qty as u32);
                }
            }
        }
    }
    None
}

fn find_dividend_qty(text: &str) -> Option<u32> {
    static QTY: OnceLock<Regex> = OnceLock::new();
    let regex = QTY.get_or_init(|| Regex::new(r"(?i)([+-]?\d[\d,]*)\s*(?:shares?|股)\b").unwrap());
    for caps in regex.captures_iter(text) {
        if let Some(raw) = caps.get(1) {
            if let Ok(value) = import::parse_number(raw.as_str()) {
                let qty = value.abs().round() as u64;
                if (1..=1_000_000).contains(&qty) {
                    return Some(qty as u32);
                }
            }
        }
    }
    None
}

fn find_price(text: &str) -> Option<f64> {
    static AT: OnceLock<Regex> = OnceLock::new();
    static LABEL: OnceLock<Regex> = OnceLock::new();
    static AT_WORD: OnceLock<Regex> = OnceLock::new();
    let at = AT.get_or_init(|| Regex::new(r"@\s*\$?\s*([\d,]+(?:\.\d+)?)").unwrap());
    let label = LABEL.get_or_init(|| {
        Regex::new(
            r"(?i)\b(?:price|premium|avg(?:erage)?\s+price|net\s+price|成交价|均价|价格)\s*[:：]?\s*\$?\s*([\d,]+(?:\.\d+)?)",
        )
        .unwrap()
    });
    let at_word = AT_WORD.get_or_init(|| {
        Regex::new(r"(?i)\bat\s+(?:\$\s*(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*\.\d+))").unwrap()
    });
    for regex in [at, label, at_word] {
        if let Some(caps) = regex.captures(text) {
            if let Some(value) = caps
                .get(1)
                .or_else(|| caps.get(2))
                .and_then(|m| import::parse_number(m.as_str()).ok())
            {
                if value > 0.0 {
                    return Some(value);
                }
            }
        }
    }
    None
}

fn find_fees(text: &str) -> Option<f64> {
    static FEES: OnceLock<Regex> = OnceLock::new();
    let regex = FEES.get_or_init(|| {
        Regex::new(
            r"(?i)\b(?:fees?|commissions?|手续费|佣金|交收费)\s*[:：]?\s*-?\$?\s*([\d,]+(?:\.\d+)?)",
        )
        .unwrap()
    });
    regex
        .captures(text)
        .and_then(|caps| caps.get(1))
        .and_then(|m| import::parse_number(m.as_str()).ok())
        .map(f64::abs)
}

fn find_per_share(text: &str) -> Option<f64> {
    static PER_SHARE: OnceLock<Regex> = OnceLock::new();
    let regex = PER_SHARE.get_or_init(|| {
        Regex::new(
            r"(?i)(?:\$?\s*([\d,]+(?:\.\d+)?)\s*(?:per\s+share|/share|每股)|(?:per\s+share|每股)\s*\$?\s*([\d,]+(?:\.\d+)?))",
        )
        .unwrap()
    });
    let caps = regex.captures(text)?;
    let raw = caps.get(1).or_else(|| caps.get(2))?;
    import::parse_number(raw.as_str())
        .ok()
        .filter(|value| *value > 0.0)
}

fn find_amount(text: &str) -> Option<f64> {
    static AMOUNT: OnceLock<Regex> = OnceLock::new();
    let regex = AMOUNT.get_or_init(|| {
        Regex::new(
            r"(?i)\b(?:amount|total|gross|net\s+amount|金额|净额|合计)\s*[:：]?\s*\$?\s*([\d,]+(?:\.\d+)?)",
        )
        .unwrap()
    });
    regex
        .captures(text)
        .and_then(|caps| caps.get(1))
        .and_then(|m| import::parse_number(m.as_str()).ok())
        .map(f64::abs)
}

fn find_dividend_amount(text: &str, qty: u32) -> Option<(f64, f64)> {
    static CURRENCY: OnceLock<Regex> = OnceLock::new();
    let total = find_amount(text);
    let per_share = find_per_share(text);
    if let Some(total) = total.filter(|value| *value > 0.0) {
        let price = per_share.unwrap_or(total / f64::from(qty));
        return Some((price, total));
    }
    if let Some(per_share) = per_share {
        return Some((per_share, per_share * f64::from(qty)));
    }
    let currency = CURRENCY.get_or_init(|| Regex::new(r"\$\s*([\d,]+(?:\.\d+)?)").unwrap());
    let mut values: Vec<f64> = currency
        .captures_iter(text)
        .filter_map(|caps| caps.get(1))
        .filter_map(|m| import::parse_number(m.as_str()).ok())
        .filter(|value| *value > 0.0)
        .collect();
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let total = values.last().copied()?;
    Some((total / f64::from(qty), total))
}

fn find_labeled_date(text: &str, chinese: bool) -> Option<String> {
    static ENGLISH: OnceLock<Regex> = OnceLock::new();
    static CHINESE: OnceLock<Regex> = OnceLock::new();
    let regex = if chinese {
        CHINESE.get_or_init(|| {
            Regex::new(&format!(
                r"(?:成交|交易|下单|订单)?日期\s*[:：]\s*({DATE_PATTERN})"
            ))
            .unwrap()
        })
    } else {
        ENGLISH
            .get_or_init(|| Regex::new(&format!(r"(?i)\bdate\s*[:：]\s*({DATE_PATTERN})")).unwrap())
    };
    for caps in regex.captures_iter(text) {
        let Some(full) = caps.get(0) else {
            continue;
        };
        let prefix_start = full.start().saturating_sub(24);
        let prefix = text[prefix_start..full.start()].to_lowercase();
        if prefix.contains("expir") || prefix.contains("到期") {
            continue;
        }
        if let Some(value) = caps.get(1) {
            return Some(value.as_str().to_string());
        }
    }
    None
}

fn find_dates(text: &str) -> Vec<(String, String)> {
    static DATES: OnceLock<Regex> = OnceLock::new();
    let regex = DATES.get_or_init(|| Regex::new(&format!(r"(?i){DATE_PATTERN}")).unwrap());
    regex
        .find_iter(text)
        .filter_map(|matched| {
            let raw = matched.as_str().to_string();
            normalize_any_date(&raw).map(|normalized| (raw, normalized))
        })
        .collect()
}

fn resolve_date(text: &str, context: &str, contract: Option<&OccOption>) -> Option<(String, bool)> {
    let labelled = find_labeled_date(text, false)
        .or_else(|| find_labeled_date(text, true))
        .or_else(|| find_labeled_date(context, false))
        .or_else(|| find_labeled_date(context, true));
    if let Some(raw) = labelled {
        if let Some(date) = normalize_any_date(&raw) {
            return Some((date, is_american_date(&raw)));
        }
    }

    let expiry = contract.map(|value| value.expiry.as_str());
    let mut candidates: Vec<(String, String)> = find_dates(text)
        .into_iter()
        .filter(|(_, normalized)| Some(normalized.as_str()) != expiry)
        .collect();
    if candidates.is_empty() {
        candidates = find_dates(context)
            .into_iter()
            .filter(|(_, normalized)| Some(normalized.as_str()) != expiry)
            .collect();
        // The closest preceding date is the most likely trade date.
        candidates.reverse();
    }
    candidates
        .into_iter()
        .next()
        .map(|(raw, normalized)| (normalized, is_american_date(&raw)))
}

fn is_american_date(raw: &str) -> bool {
    static AMERICAN: OnceLock<Regex> = OnceLock::new();
    let regex = AMERICAN.get_or_init(|| Regex::new(r"^\d{1,2}/\d{1,2}/\d{2,4}$").unwrap());
    regex.is_match(raw.trim().trim_matches(|ch: char| ch == ',' || ch == '.'))
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

// ---------------------------------------------------------------------------
// Line classification and CSV output
// ---------------------------------------------------------------------------

fn looks_trade_like(line: &str) -> bool {
    action_kind(line).is_some()
        || is_dividend(line)
        || find_contract(line).is_some()
        || find_occ(line).is_some()
}

fn is_fee_line(line: &str) -> bool {
    static FEES: OnceLock<Regex> = OnceLock::new();
    let regex = FEES.get_or_init(|| {
        Regex::new(r"(?i)^\s*(?:fees?|commissions?|手续费|佣金|交收费)\s*[:：]?\s*-?\$?\s*[\d,.]+")
            .unwrap()
    });
    regex.is_match(line)
}

fn is_price_line(line: &str) -> bool {
    static PRICE: OnceLock<Regex> = OnceLock::new();
    let regex =
        PRICE.get_or_init(|| Regex::new(r"(?i)^\s*(?:@|price|premium|成交价|均价)\b").unwrap());
    regex.is_match(line)
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

fn round_money(value: f64) -> f64 {
    let rounded = (value * 1_000_000.0).round() / 1_000_000.0;
    if rounded == 0.0 {
        0.0
    } else {
        rounded
    }
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

fn push_warning(warnings: &mut Vec<String>, warning: String) {
    if warnings.len() >= 20 {
        return;
    }
    if !warnings.iter().any(|existing| existing == &warning) {
        warnings.push(warning);
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schwab_confirmation_is_extracted_with_fees_from_the_next_line() {
        let text = "\
Trade Date: 01/02/2026
SOLD TO OPEN 1 AAPL 02/20/2026 150 P @ $2.00
Fees: $1.00
";
        let extraction = extract(text, Some("schwab.txt")).expect("extract");
        assert_eq!(extraction.template, "Schwab");
        assert_eq!(extraction.trades.len(), 1);
        let trade = &extraction.trades[0];
        assert_eq!(trade.date, "2026-01-02");
        assert_eq!(trade.kind, "option_open_short");
        assert_eq!(trade.symbol, "AAPL");
        assert_eq!(trade.qty, 1);
        assert_eq!(trade.price, 2.0);
        assert_eq!(trade.fees, 1.0);
        assert_eq!(trade.expiry.as_deref(), Some("2026-02-20"));
        assert_eq!(trade.strike, Some(150.0));
        assert_eq!(trade.right.as_deref(), Some("P"));
        assert!(extraction
            .csv
            .contains("option_open_short,AAPL,1,2,1,2026-02-20,150,P"));
        assert!(extraction.warnings.iter().any(|w| w.contains("按月/日/年")));
    }

    #[test]
    fn fidelity_share_purchase_uses_the_previous_date_line() {
        let text = "\
Date: 2026-01-03
Bought 100 shares of MSFT at $300.00
Commission: $0.00
";
        let extraction = extract(text, None).expect("extract");
        assert_eq!(extraction.trades.len(), 1);
        let trade = &extraction.trades[0];
        assert_eq!(trade.date, "2026-01-03");
        assert_eq!(trade.kind, "shares_buy");
        assert_eq!(trade.symbol, "MSFT");
        assert_eq!(trade.qty, 100);
        assert_eq!(trade.price, 300.0);
    }

    #[test]
    fn ibkr_buy_to_close_is_supported() {
        let text = "\
Trade Date 2026-01-04
Bought to close 2 AAPL 2026-02-20 150 P @ 0.50
";
        let extraction = extract(text, Some("ibkr.eml")).expect("extract");
        assert_eq!(extraction.template, "IBKR");
        let trade = &extraction.trades[0];
        assert_eq!(trade.kind, "option_close");
        assert_eq!(trade.qty, 2);
        assert_eq!(trade.price, 0.5);
    }

    #[test]
    fn futu_chinese_confirmation_is_supported() {
        let text = "\
成交日期：2026年1月5日
卖出开仓 1 张 AAPL 2026-02-20 150 P 成交价 2.00 手续费 1.00
";
        let extraction = extract(text, Some("富途成交确认.txt")).expect("extract");
        assert_eq!(extraction.template, "富途");
        let trade = &extraction.trades[0];
        assert_eq!(trade.date, "2026-01-05");
        assert_eq!(trade.kind, "option_open_short");
        assert_eq!(trade.symbol, "AAPL");
        assert_eq!(trade.qty, 1);
        assert_eq!(trade.price, 2.0);
        assert_eq!(trade.fees, 1.0);
    }

    #[test]
    fn dividend_derives_per_share_from_the_total() {
        let text = "2026-01-06 AAPL Dividend 100 shares $50.00\n";
        let extraction = extract(text, None).expect("extract");
        let trade = &extraction.trades[0];
        assert_eq!(trade.kind, "dividend");
        assert_eq!(trade.symbol, "AAPL");
        assert_eq!(trade.qty, 100);
        assert_eq!(trade.amount, 50.0);
        assert_eq!(trade.price, 0.5);
    }

    #[test]
    fn multipart_mime_prefers_the_plain_text_part() {
        let text = "\
From: alerts@example.com
MIME-Version: 1.0
Content-Type: multipart/alternative; boundary=\"abc\"

--abc
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: quoted-printable

Trade Date: 2026-01-07
SOLD TO OPEN 1 AAPL 2026-02-20 150 P @ 2.00
--abc
Content-Type: text/html; charset=utf-8

<html><body><p>Trade Date: 2026-01-07</p><p>SOLD TO OPEN 1 AAPL 2026-02-20 150 P @ 2.00</p></body></html>
--abc--
";
        let extraction = extract(text, None).expect("extract");
        assert_eq!(extraction.trades.len(), 1);
        assert_eq!(extraction.trades[0].date, "2026-01-07");
    }

    #[test]
    fn base64_body_is_decoded() {
        let body = "Trade Date: 2026-01-09\nSOLD TO OPEN 1 AAPL 2026-02-20 150 P @ 2.00\n";
        let encoded = base64::engine::general_purpose::STANDARD.encode(body);
        let text = format!(
            "MIME-Version: 1.0\nContent-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: base64\n\n{encoded}\n"
        );
        let extraction = extract(&text, None).expect("extract");
        assert_eq!(extraction.trades.len(), 1);
        assert_eq!(extraction.trades[0].date, "2026-01-09");
    }

    #[test]
    fn repeated_trade_lines_are_merged_with_a_warning() {
        let text = "\
Trade Date: 2026-01-10
SOLD TO OPEN 1 AAPL 2026-02-20 150 P @ 2.00
SOLD TO OPEN 1 AAPL 2026-02-20 150 P @ 2.00
";
        let extraction = extract(text, None).expect("extract");
        assert_eq!(extraction.trades.len(), 1);
        assert!(extraction.warnings.iter().any(|w| w.contains("重复")));
    }

    #[test]
    fn buy_to_open_is_rejected_instead_of_being_guessed() {
        let text = "Trade Date: 2026-01-11\nBUY TO OPEN 1 AAPL 2026-02-20 150 P @ 2.00\n";
        let error = extract(text, None).expect_err("unsupported");
        assert!(error.contains("暂不支持做多期权操作"));
    }

    #[test]
    fn missing_price_is_reported_not_defaulted() {
        let text = "Trade Date: 2026-01-12\nSOLD TO OPEN 1 AAPL 2026-02-20 150 P\n";
        let error = extract(text, None).expect_err("missing price");
        assert!(error.contains("未找到成交价"));
    }

    #[test]
    fn html_table_keeps_the_date_and_the_trade_on_separate_lines() {
        let text = "\
MIME-Version: 1.0
Content-Type: text/html; charset=utf-8

<html><body><table><tr><td>Trade Date:</td><td>01/02/2026</td></tr><tr><td>SOLD TO OPEN 1 AAPL 02/20/2026 150 P @ $2.00</td></tr></table></body></html>
";
        let extraction = extract(text, None).expect("extract");
        assert_eq!(extraction.trades.len(), 1);
        assert_eq!(extraction.trades[0].date, "2026-01-02");
    }

    #[test]
    fn month_name_expiry_is_normalized() {
        assert_eq!(
            normalize_any_date("Feb 20, 2026").as_deref(),
            Some("2026-02-20")
        );
        assert_eq!(
            normalize_any_date("20 FEB 26").as_deref(),
            Some("2026-02-20")
        );
    }

    #[test]
    fn quoted_printable_soft_breaks_and_escapes_are_decoded() {
        let decoded = decode_quoted_printable("SOLD TO=\n OPEN 1 AAPL =402.00\n");
        assert!(decoded.contains("SOLD TO OPEN 1 AAPL @2.00"));
    }

    #[test]
    fn missing_price_does_not_borrow_the_next_trade_price() {
        let text = "\
Trade Date: 2026-01-12
SOLD TO OPEN 1 AAPL 2026-02-20 150 P
SOLD TO OPEN 1 MSFT 2026-02-20 400 P @ 3.00
";
        let extraction = extract(text, None).expect("extract");
        assert_eq!(extraction.trades.len(), 1);
        let trade = &extraction.trades[0];
        assert_eq!(trade.symbol, "MSFT");
        assert_eq!(trade.price, 3.0);
        assert!(extraction
            .warnings
            .iter()
            .any(|w| w.contains("未找到成交价")));
    }

    #[test]
    fn exercise_price_is_not_treated_as_an_assignment() {
        assert!(action_kind("AAPL 2026-02-20 150 P exercise price $150.00").is_none());
        assert_eq!(
            action_kind("AAPL 2026-02-20 150 P assigned"),
            Some(Ok("option_assign"))
        );
    }

    #[test]
    fn at_followed_by_a_date_is_not_a_price() {
        assert_eq!(find_price("filled at 2026-01-02"), None);
        assert_eq!(find_price("filled at $2.00"), Some(2.0));
        assert_eq!(find_price("filled at 2.00"), Some(2.0));
    }

    #[test]
    fn american_warning_only_tracks_the_resolved_trade_date() {
        let text = "\
Trade Date: 2026-01-13
SOLD TO OPEN 1 AAPL 02/20/2026 150 P @ 2.00
";
        let extraction = extract(text, None).expect("extract");
        assert_eq!(extraction.trades[0].date, "2026-01-13");
        assert!(!extraction.warnings.iter().any(|w| w.contains("按月/日/年")));
    }

    #[test]
    fn sub_cent_option_prices_keep_their_precision() {
        let text = "\
Trade Date: 2026-01-14
SOLD TO OPEN 1 AAPL 2026-02-20 150 P @ 0.005
";
        let extraction = extract(text, None).expect("extract");
        assert_eq!(extraction.trades[0].price, 0.005);
    }
}
