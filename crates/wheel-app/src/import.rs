//! CSV import: parsing, column mapping, normalization and deduplication.
//!
//! Everything here is pure: no database, no Tauri state and no filesystem
//! access. The command layer feeds existing events in and takes candidate rows
//! out, so the whole adapter is testable without an app handle.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use time::macros::format_description;
use time::format_description::FormatItem;
use time::{Date, Month};
use wheel_core::Event;

pub const MAX_TEXT_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_ROWS: usize = 5_000;
pub const MAX_COLUMNS: usize = 64;
const MAX_CELL_CHARS: usize = 4_096;
const MAPPING_KEY_PREFIX: &str = "importMapping:v1:";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Field {
    Date,
    Kind,
    Action,
    Symbol,
    OptionSymbol,
    Qty,
    Price,
    Fees,
    Amount,
    Expiry,
    Strike,
    Right,
    Multiplier,
    Note,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Delimiter {
    Comma,
    Semicolon,
    Tab,
}

impl Delimiter {
    pub fn as_char(self) -> char {
        match self {
            Delimiter::Comma => ',',
            Delimiter::Semicolon => ';',
            Delimiter::Tab => '\t',
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Delimiter::Comma => ",",
            Delimiter::Semicolon => ";",
            Delimiter::Tab => "\t",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DateFormat {
    #[default]
    Auto,
    YearMonthDay,
    MonthDayYear,
    Chinese,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMapping {
    #[serde(default)]
    pub fields: BTreeMap<Field, usize>,
    #[serde(default)]
    pub date_format: DateFormat,
    #[serde(default)]
    pub delimiter: Option<Delimiter>,
    /// `None` means "trust the file"; an explicit value overrides detection.
    #[serde(default)]
    pub has_header: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateEvent {
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
    #[serde(default = "default_multiplier")]
    pub multiplier: u32,
    #[serde(default)]
    pub note: Option<String>,
}

fn default_multiplier() -> u32 {
    100
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RowStatus {
    Ok,
    Warning,
    Duplicate,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateRow {
    /// 1-based logical data row (quoted newlines do not advance it).
    pub row_number: u32,
    /// 1-based physical line where the record starts, for diagnostics.
    pub line: u32,
    pub status: RowStatus,
    pub messages: Vec<String>,
    pub cells: Vec<String>,
    pub raw: String,
    pub event: Option<CandidateEvent>,
    pub selected_by_default: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCounts {
    pub total: usize,
    pub ok: usize,
    pub warning: usize,
    pub duplicate: usize,
    pub error: usize,
    pub selected: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub headers: Vec<String>,
    pub signature: String,
    pub delimiter: String,
    pub header_line: u32,
    pub mapping: ColumnMapping,
    pub mapping_source: String,
    pub rows: Vec<CandidateRow>,
    pub counts: ImportCounts,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub imported: usize,
    pub event_ids: Vec<String>,
    pub account_id: String,
    pub note_prefix: String,
    pub duplicate_count: usize,
    /// `None` when the batch metadata could not be persisted after the events
    /// were already committed; the import itself still succeeded.
    pub batch_id: Option<String>,
    pub batch_saved: bool,
}

/// A single import run, stored as JSON under a `settings` key so that a whole
/// batch can be undone later without changing the database schema.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportBatch {
    pub id: String,
    pub account_id: String,
    pub origin: String,
    pub note_prefix: String,
    pub created_at: String,
    pub imported: usize,
    pub event_ids: Vec<String>,
    #[serde(default)]
    pub undone_at: Option<String>,
    #[serde(default)]
    pub undone_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportBatchView {
    pub id: String,
    pub origin: String,
    pub created_at: String,
    pub imported: usize,
    /// Events from this batch that are still active in the ledger.
    pub remaining: usize,
    pub undone_at: Option<String>,
    pub undone_count: usize,
}

#[derive(Debug, Clone)]
pub struct CsvRecord {
    pub line: u32,
    pub cells: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct ParsedDocument {
    pub headers: Vec<String>,
    pub records: Vec<CsvRecord>,
    pub delimiter: Delimiter,
    pub signature: String,
    pub header_line: u32,
    pub has_header: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OccOption {
    pub underlying: String,
    pub expiry: String,
    pub strike: f64,
    pub right: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ActionResult {
    Kind(&'static str),
    Unsupported(String),
    Unknown(String),
}

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

/// RFC 4180 parser: quoted cells may contain delimiters, doubled quotes and
/// newlines. BOM, LF, CRLF and bare CR are accepted.
pub fn parse_csv(text: &str, delimiter: char) -> Result<Vec<CsvRecord>, String> {
    let body = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut records = Vec::new();
    let mut cells: Vec<String> = Vec::new();
    let mut cell = String::new();
    let mut line = 1u32;
    let mut record_line = 1u32;
    let mut quoted = false;
    let mut chars = body.chars().peekable();

    while let Some(ch) = chars.next() {
        if quoted {
            match ch {
                '"' => {
                    if chars.peek() == Some(&'"') {
                        chars.next();
                        cell.push('"');
                    } else {
                        quoted = false;
                    }
                }
                '\n' => {
                    line += 1;
                    cell.push('\n');
                }
                '\r' => {
                    if chars.peek() == Some(&'\n') {
                        chars.next();
                    }
                    line += 1;
                    cell.push('\n');
                }
                other => cell.push(other),
            }
        } else if ch == '"' && cell.trim().is_empty() {
            cell.clear();
            quoted = true;
        } else if ch == delimiter {
            cells.push(std::mem::take(&mut cell));
        } else if ch == '\n' || ch == '\r' {
            if ch == '\r' && chars.peek() == Some(&'\n') {
                chars.next();
            }
            cells.push(std::mem::take(&mut cell));
            push_record(&mut records, &mut cells, record_line)?;
            line += 1;
            record_line = line;
        } else {
            cell.push(ch);
        }
    }
    if quoted {
        return Err("CSV 引号未闭合".to_string());
    }
    if !cell.is_empty() || !cells.is_empty() {
        cells.push(cell);
        push_record(&mut records, &mut cells, record_line)?;
    }
    if records.is_empty() {
        return Err("CSV 没有可解析的内容".to_string());
    }
    Ok(records)
}

fn push_record(
    records: &mut Vec<CsvRecord>,
    cells: &mut Vec<String>,
    line: u32,
) -> Result<(), String> {
    if records.len() > MAX_ROWS {
        return Err(format!("CSV 行数超过上限 {MAX_ROWS}"));
    }
    if cells.len() > MAX_COLUMNS {
        return Err(format!("CSV 列数超过上限 {MAX_COLUMNS}"));
    }
    let trimmed: Vec<String> = cells
        .drain(..)
        .map(|cell| cell.chars().take(MAX_CELL_CHARS).collect())
        .collect();
    records.push(CsvRecord {
        line,
        cells: trimmed,
    });
    Ok(())
}

/// Count each candidate separator outside quotes on the first logical line.
pub fn detect_delimiter(text: &str) -> Delimiter {
    let body = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut counts = [0usize; 3];
    let mut quoted = false;
    for ch in body.chars() {
        match ch {
            '"' => quoted = !quoted,
            ',' if !quoted => counts[0] += 1,
            ';' if !quoted => counts[1] += 1,
            '\t' if !quoted => counts[2] += 1,
            '\n' | '\r' if !quoted => break,
            _ => {}
        }
    }
    if counts[1] > counts[0] && counts[1] >= counts[2] {
        Delimiter::Semicolon
    } else if counts[2] > counts[0] && counts[2] > counts[1] {
        Delimiter::Tab
    } else {
        Delimiter::Comma
    }
}

fn normalize_header(value: &str) -> String {
    let cleaned: String = value
        .trim_start_matches('\u{feff}')
        .chars()
        .map(|ch| if ch == '\u{a0}' { ' ' } else { ch })
        .collect();
    let mut out = String::new();
    for word in cleaned.split_whitespace() {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&word.to_lowercase());
    }
    out.trim_end_matches(':').to_string()
}

pub fn header_signature(headers: &[String]) -> String {
    let joined = headers
        .iter()
        .map(|header| normalize_header(header))
        .collect::<Vec<_>>()
        .join("\u{1f}");
    format!("{:016x}", fnv1a(joined.as_bytes()))
}

pub fn mapping_key(signature: &str) -> String {
    format!("{MAPPING_KEY_PREFIX}{signature}")
}

pub fn is_valid_signature(signature: &str) -> bool {
    signature.len() == 16 && signature.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

// ---------------------------------------------------------------------------
// Headers and mapping
// ---------------------------------------------------------------------------

const ALIASES: &[(Field, &[&str])] = &[
    (
        Field::Date,
        &[
            "date",
            "trade date",
            "transaction date",
            "settlement date",
            "日期",
            "成交日期",
            "交易日期",
            "发生日期",
        ],
    ),
    (
        Field::Kind,
        &["kind", "event", "event type", "类型", "交易类型", "事件类型"],
    ),
    (
        Field::Action,
        &[
            "action",
            "side",
            "direction",
            "instruction",
            "type",
            "方向",
            "买卖",
            "买/卖",
            "交易方向",
            "操作",
        ],
    ),
    (
        Field::Symbol,
        &[
            "symbol",
            "ticker",
            "underlying",
            "stock code",
            "代码",
            "标的",
            "标的代码",
            "证券代码",
            "股票代码",
        ],
    ),
    (
        Field::OptionSymbol,
        &[
            "option symbol",
            "contract",
            "contract symbol",
            "occ symbol",
            "合约代码",
            "期权代码",
            "合约",
        ],
    ),
    (
        Field::Qty,
        &[
            "qty",
            "quantity",
            "shares",
            "contracts",
            "数量",
            "成交数量",
            "股数",
            "张数",
            "手数",
        ],
    ),
    (
        Field::Price,
        &[
            "price",
            "trade price",
            "avg price",
            "average price",
            "成交价",
            "价格",
            "均价",
            "成交均价",
        ],
    ),
    (
        Field::Fees,
        &[
            "fees",
            "fee",
            "commission",
            "commission fee",
            "费用",
            "手续费",
            "佣金",
            "交易费用",
        ],
    ),
    (
        Field::Amount,
        &[
            "amount",
            "net amount",
            "gross amount",
            "proceeds",
            "金额",
            "成交金额",
            "净金额",
            "发生金额",
        ],
    ),
    (
        Field::Expiry,
        &[
            "expiry",
            "expiration",
            "expiration date",
            "到期日",
            "到期日期",
            "行权日",
        ],
    ),
    (
        Field::Strike,
        &["strike", "strike price", "行权价", "执行价", "行使价"],
    ),
    (
        Field::Multiplier,
        &[
            "multiplier",
            "contract size",
            "shares per contract",
            "乘数",
            "合约乘数",
            "每手股数",
        ],
    ),
    (
        Field::Right,
        &[
            "right",
            "put/call",
            "option type",
            "call/put",
            "期权类型",
            "看涨看跌",
            "认购认沽",
            "方向类型",
        ],
    ),
    (
        Field::Note,
        &[
            "note",
            "notes",
            "memo",
            "description",
            "备注",
            "说明",
            "摘要",
        ],
    ),
];

fn alias_fields(header: &str) -> Vec<Field> {
    let normalized = normalize_header(header);
    if normalized.is_empty() {
        return Vec::new();
    }
    let mut matched = Vec::new();
    for (field, aliases) in ALIASES {
        if aliases
            .iter()
            .any(|alias| normalize_header(alias) == normalized)
        {
            matched.push(*field);
        }
    }
    matched
}

pub fn auto_map(headers: &[String]) -> (ColumnMapping, Vec<String>) {
    let mut mapping = ColumnMapping::default();
    let mut warnings = Vec::new();
    for (index, header) in headers.iter().enumerate() {
        let matched = alias_fields(header);
        if matched.is_empty() {
            continue;
        }
        if matched.len() > 1 {
            warnings.push(format!(
                "表头“{header}”可能对应多个字段，已按{}处理，可在映射中修改。",
                field_label(matched[0])
            ));
        }
        let target = matched
            .iter()
            .copied()
            .find(|field| !mapping.fields.contains_key(field));
        match target {
            Some(field) => {
                mapping.fields.insert(field, index);
            }
            None => warnings.push(format!("表头“{header}”没有可用的目标字段，已忽略。")),
        }
    }
    mapping.has_header = Some(true);
    (mapping, warnings)
}

pub fn field_label(field: Field) -> &'static str {
    match field {
        Field::Date => "交易日期",
        Field::Kind => "交易类型（规范值）",
        Field::Action => "方向 / 买卖",
        Field::Symbol => "标的代码",
        Field::OptionSymbol => "期权合约代码",
        Field::Qty => "数量",
        Field::Price => "价格",
        Field::Fees => "费用",
        Field::Amount => "金额",
        Field::Expiry => "到期日",
        Field::Strike => "行权价",
        Field::Right => "看涨 / 看跌",
        Field::Multiplier => "每手股数 / 乘数",
        Field::Note => "备注",
    }
}

pub fn validate_mapping(mapping: &ColumnMapping, columns: usize) -> Result<(), String> {
    if !mapping.fields.contains_key(&Field::Date) {
        return Err("映射缺少交易日期列".to_string());
    }
    if !mapping.fields.contains_key(&Field::Symbol)
        && !mapping.fields.contains_key(&Field::OptionSymbol)
    {
        return Err("映射缺少标的代码或期权合约代码列".to_string());
    }
    if !mapping.fields.contains_key(&Field::Kind) && !mapping.fields.contains_key(&Field::Action) {
        return Err("映射缺少交易类型或方向列".to_string());
    }
    for (field, index) in &mapping.fields {
        if *index >= columns {
            return Err(format!(
                "字段{}指向第 {} 列，但文件只有 {} 列",
                field_label(*field),
                index + 1,
                columns
            ));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Cell normalization
// ---------------------------------------------------------------------------

pub fn parse_date_cell(raw: &str, format: DateFormat) -> Result<(String, Option<String>), String> {
    let text = raw.trim();
    if text.is_empty() {
        return Err("缺少日期".to_string());
    }
    let chinese = text
        .replace(['年', '月'], "-")
        .replace(['日', ' '], "");
    let hyphen = format_description!("[year]-[month]-[day]");
    let hyphen_any = format_description!("[year]-[month padding:none]-[day padding:none]");
    let slash = format_description!("[year]/[month padding:none]/[day padding:none]");
    let american = format_description!("[month padding:none]/[day padding:none]/[year]");
    let attempt = |value: &str, descriptor: &[FormatItem<'_>]| -> Option<Date> {
        Date::parse(value, descriptor).ok()
    };

    let (parsed, warning) = match format {
        DateFormat::YearMonthDay => (
            attempt(text, hyphen)
                .or_else(|| attempt(text, hyphen_any))
                .or_else(|| attempt(text, slash)),
            None,
        ),
        DateFormat::MonthDayYear => (
            attempt(text, american),
            Some("按月/日/年解析日期，请确认无误。".to_string()),
        ),
        DateFormat::Chinese => (attempt(&chinese, hyphen_any), None),
        DateFormat::Auto => {
            if let Some(date) = attempt(text, hyphen) {
                (Some(date), None)
            } else if let Some(date) = attempt(text, hyphen_any) {
                (Some(date), None)
            } else if let Some(date) = attempt(text, slash) {
                (Some(date), None)
            } else if let Some(date) = attempt(&chinese, hyphen_any) {
                (Some(date), None)
            } else if let Some(date) = attempt(text, american) {
                (Some(date), Some("按月/日/年解析日期，请确认无误。".to_string()))
            } else {
                (None, None)
            }
        }
    };
    match parsed {
        Some(date) => Ok((format_date(date), warning)),
        None => Err(format!("无法识别日期 `{raw}`")),
    }
}

fn format_date(date: Date) -> String {
    date.format(format_description!("[year]-[month]-[day]"))
        .unwrap_or_else(|_| date.to_string())
}

pub fn parse_number(raw: &str) -> Result<f64, String> {
    let text = raw.trim();
    if text.is_empty() {
        return Err("缺少数值".to_string());
    }
    let mut body = text.to_string();
    let mut negative = false;
    if body.starts_with('(') && body.ends_with(')') {
        negative = true;
        body = body[1..body.len() - 1].to_string();
    }
    if let Some(stripped) = body.strip_prefix('-') {
        negative = !negative;
        body = stripped.to_string();
    } else if let Some(stripped) = body.strip_prefix('+') {
        body = stripped.to_string();
    }
    body = body.replace('，', ",");
    let commas = body.matches(',').count();
    let dots = body.matches('.').count();
    if commas > 0 && dots > 0 {
        let comma_last = body.rfind(',').unwrap();
        let dot_last = body.rfind('.').unwrap();
        let decimals = body.len() - comma_last.max(dot_last) - 1;
        if comma_last > dot_last && decimals <= 2 {
            body = body.replace('.', "");
            let position = body.rfind(',').unwrap();
            body.replace_range(position..position + 1, ".");
            body = body.replace(',', "");
        } else {
            body = body.replace(',', "");
        }
    } else if commas == 1 {
        let position = body.rfind(',').unwrap();
        let decimals = body.len() - position - 1;
        if decimals > 0 && decimals <= 2 {
            body.replace_range(position..position + 1, ".");
        } else {
            body = body.replace(',', "");
        }
    }
    let cleaned: String = body
        .chars()
        .filter(|ch| {
            !matches!(
                ch,
                '$' | '¥' | '€' | '£' | ' ' | '\u{a0}' | '\'' | ',' | '%'
            )
        })
        .collect();
    if cleaned.is_empty() {
        return Err(format!("无法识别数值 `{raw}`"));
    }
    let value: f64 = cleaned
        .parse()
        .map_err(|_| format!("无法识别数值 `{raw}`"))?;
    if !value.is_finite() {
        return Err(format!("数值不是有限数 `{raw}`"));
    }
    Ok(if negative { -value } else { value })
}

fn optional_number(cells: &[String], mapping: &ColumnMapping, field: Field) -> Option<String> {
    cell(cells, mapping, field).map(str::to_string)
}

// ---------------------------------------------------------------------------
// Option symbols and action text
// ---------------------------------------------------------------------------

pub fn parse_occ_symbol(raw: &str) -> Option<OccOption> {
    let compact: String = raw
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect::<String>()
        .to_uppercase();
    if compact.len() < 16 || !compact.is_ascii() {
        return None;
    }
    let split = compact.len() - 15;
    let tail = &compact[split..];
    let bytes = tail.as_bytes();
    if !bytes[..6].iter().all(u8::is_ascii_digit)
        || !matches!(bytes[6], b'C' | b'P')
        || !bytes[7..].iter().all(u8::is_ascii_digit)
    {
        return None;
    }
    let underlying = compact[..split].to_string();
    if underlying.is_empty() {
        return None;
    }
    let year: i32 = format!("20{}", &tail[0..2]).parse().ok()?;
    let month = Month::try_from(tail[2..4].parse::<u8>().ok()?).ok()?;
    let day: u8 = tail[4..6].parse().ok()?;
    let date = Date::from_calendar_date(year, month, day).ok()?;
    let strike = tail[7..15].parse::<u64>().ok()? as f64 / 1000.0;
    Some(OccOption {
        underlying,
        expiry: format_date(date),
        strike,
        right: (bytes[6] as char).to_string(),
    })
}

pub fn kind_from_action(text: &str, _has_contract: bool) -> ActionResult {
    let normalized = normalize_action(text);
    if normalized.is_empty() {
        return ActionResult::Unknown(text.trim().to_string());
    }
    let kind = match normalized.as_str() {
        "option_open_short" | "sto" | "sell to open" | "selltoopen" | "卖出开仓" | "卖开" => {
            Some("option_open_short")
        }
        "option_close" | "btc" | "buy to close" | "buytoclose" | "买入平仓" | "买平" => {
            Some("option_close")
        }
        "option_expire" | "expired" | "expire" | "expiration" | "到期" | "作废" | "到期作废" => {
            Some("option_expire")
        }
        "option_assign" | "assigned" | "assignment" | "exercise" | "指派" | "行权" | "被指派" => {
            Some("option_assign")
        }
        "shares_buy" | "buy" | "bought" | "买入" | "买" => Some("shares_buy"),
        "shares_sell" | "sell" | "sold" | "卖出" | "卖" => Some("shares_sell"),
        "dividend" | "dividends" | "cash dividend" | "分红" | "股息" | "红利" => {
            Some("dividend")
        }
        "fee" | "fees" | "commission" | "费用" | "手续费" | "佣金" | "利息" => Some("fee"),
        "adjustment" | "adjust" | "调整" | "现金调整" => Some("adjustment"),
        "buy to open" | "bto" | "买入开仓" | "sell to close" | "stc" | "卖出平仓" => {
            return ActionResult::Unsupported(format!("暂不支持做多期权操作 `{}`", text.trim()))
        }
        _ => None,
    };
    match kind {
        Some(kind) => ActionResult::Kind(kind),
        None => ActionResult::Unknown(text.trim().to_string()),
    }
}

fn normalize_action(value: &str) -> String {
    let mut out = String::new();
    for word in value.split_whitespace() {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&word.to_lowercase());
    }
    out
}

fn is_option_kind(kind: &str) -> bool {
    kind.starts_with("option_")
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

fn cell<'a>(cells: &'a [String], mapping: &ColumnMapping, field: Field) -> Option<&'a str> {
    mapping
        .fields
        .get(&field)
        .and_then(|index| cells.get(*index))
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
}

pub fn parse_document(
    text: &str,
    delimiter: Option<Delimiter>,
    has_header: Option<bool>,
) -> Result<ParsedDocument, String> {
    if text.len() > MAX_TEXT_BYTES {
        return Err(format!(
            "CSV 超过 {} MB 上限",
            MAX_TEXT_BYTES / 1024 / 1024
        ));
    }
    let delimiter = delimiter.unwrap_or_else(|| detect_delimiter(text));
    let records = parse_csv(text, delimiter.as_char())?;
    let first = records.first().cloned().ok_or("CSV 没有内容")?;
    let columns = records
        .iter()
        .map(|record| record.cells.len())
        .max()
        .unwrap_or(0);
    let detected_header = looks_like_header(&first.cells);
    let use_header = has_header.unwrap_or(detected_header);
    let mut warnings = Vec::new();

    let (headers, data, header_line) = if use_header {
        (first.cells.clone(), records[1..].to_vec(), first.line)
    } else {
        (
            (1..=columns).map(|index| format!("列 {index}")).collect(),
            records.clone(),
            0,
        )
    };
    if data.is_empty() {
        warnings.push("CSV 只有表头，没有数据行。".to_string());
    }
    if detected_header != use_header {
        warnings.push(if use_header {
            "已按首行是表头解析。".to_string()
        } else {
            "已按首行是数据解析；如果首行其实是表头，请在映射中启用。".to_string()
        });
    }
    let signature = header_signature(&headers);
    Ok(ParsedDocument {
        headers,
        records: data,
        delimiter,
        signature,
        header_line,
        has_header: use_header,
        warnings,
    })
}

fn is_blank(cells: &[String]) -> bool {
    cells.iter().all(|cell| cell.trim().is_empty())
}

fn looks_like_header(cells: &[String]) -> bool {
    if cells.is_empty() || is_blank(cells) {
        return false;
    }
    if cells.iter().any(|cell| !alias_fields(cell).is_empty()) {
        return true;
    }
    let first = cells.first().map(String::as_str).unwrap_or("");
    if parse_date_cell(first, DateFormat::Auto).is_ok() {
        return false;
    }
    cells
        .iter()
        .any(|cell| cell.trim().chars().any(|ch| ch.is_alphabetic()))
}

pub fn normalize_row(
    row_number: u32,
    line: u32,
    cells: &[String],
    mapping: &ColumnMapping,
) -> CandidateRow {
    let mut warnings: Vec<String> = Vec::new();
    let mut errors: Vec<String> = Vec::new();

    let date_cell = cell(cells, mapping, Field::Date).map(str::to_string);
    let date = match date_cell {
        Some(value) => match parse_date_cell(&value, mapping.date_format) {
            Ok((date, warning)) => {
                if let Some(warning) = warning {
                    warnings.push(warning);
                }
                Some(date)
            }
            Err(error) => {
                errors.push(error);
                None
            }
        },
        None => {
            errors.push("缺少交易日期".to_string());
            None
        }
    };

    let occ = cell(cells, mapping, Field::OptionSymbol).and_then(parse_occ_symbol);
    let mut symbol = cell(cells, mapping, Field::Symbol)
        .map(|value| value.trim().to_ascii_uppercase())
        .unwrap_or_default();
    let mut expiry = None;
    let mut strike = None;
    let mut right = None;

    if let Some(occ) = &occ {
        if symbol.is_empty() {
            symbol = occ.underlying.clone();
        }
        expiry = Some(occ.expiry.clone());
        strike = Some(occ.strike);
        right = Some(occ.right.clone());
        if let Some(explicit) = cell(cells, mapping, Field::Expiry) {
            if parse_date_cell(explicit, DateFormat::Auto)
                .map(|(value, _)| value != occ.expiry)
                .unwrap_or(false)
            {
                warnings.push("合约代码的到期日与到期日列不一致，已采用合约代码。".to_string());
            }
        }
    } else {
        let expiry_raw = cell(cells, mapping, Field::Expiry).map(str::to_string);
        let strike_raw = cell(cells, mapping, Field::Strike).map(str::to_string);
        let right_raw = cell(cells, mapping, Field::Right).map(str::to_string);
        match (expiry_raw, strike_raw, right_raw) {
            (None, None, None) => {}
            (Some(expiry_raw), Some(strike_raw), Some(right_raw)) => {
                match parse_date_cell(&expiry_raw, DateFormat::Auto) {
                    Ok((value, _)) => expiry = Some(value),
                    Err(error) => errors.push(format!("到期日：{error}")),
                }
                match parse_number(&strike_raw) {
                    Ok(value) if value > 0.0 => strike = Some(value),
                    Ok(_) => errors.push("行权价必须大于零".to_string()),
                    Err(error) => errors.push(format!("行权价：{error}")),
                }
                match normalize_right(&right_raw) {
                    Some(value) => right = Some(value),
                    None => errors.push(format!("无法识别看涨/看跌 `{right_raw}`")),
                }
            }
            _ => errors.push("期权合约需要到期日、行权价、看涨/看跌三列齐全".to_string()),
        }
    }

    let has_contract = expiry.is_some() && strike.is_some() && right.is_some();

    let kind_cell = cell(cells, mapping, Field::Kind).map(str::to_string);
    let action_cell = cell(cells, mapping, Field::Action).map(str::to_string);
    let kind = match kind_cell.as_deref().or(action_cell.as_deref()) {
        Some(text) => match kind_from_action(text, has_contract) {
            ActionResult::Kind(kind) => Some(kind),
            ActionResult::Unsupported(message) => {
                errors.push(message);
                None
            }
            ActionResult::Unknown(text) => {
                errors.push(format!("无法识别交易类型 `{text}`"));
                None
            }
        },
        None => {
            errors.push("缺少交易类型或方向列".to_string());
            None
        }
    };

    if let Some(kind) = kind {
        if is_option_kind(kind) && !has_contract {
            errors.push("期权类型缺少到期日、行权价或看涨/看跌".to_string());
        }
        if !is_option_kind(kind) && has_contract {
            errors.push("股票、分红或费用行不应带期权合约，请检查列映射".to_string());
        }
    }
    if symbol.is_empty() {
        errors.push("缺少标的代码".to_string());
    }

    let qty = match optional_number(cells, mapping, Field::Qty) {
        Some(raw) => match parse_number(&raw) {
            Ok(value) if value.fract().abs() < 1e-9 => {
                if value < 0.0 {
                    warnings.push("数量为负，已取绝对值。".to_string());
                }
                if value.abs() > f64::from(u32::MAX) {
                    errors.push("数量超出范围".to_string());
                    0
                } else {
                    value.abs() as u32
                }
            }
            Ok(_) => {
                errors.push("数量必须是整数".to_string());
                0
            }
            Err(error) => {
                errors.push(format!("数量：{error}"));
                0
            }
        },
        None => 0,
    };
    if qty == 0 && matches!(kind, Some(kind) if !matches!(kind, "fee" | "adjustment")) {
        errors.push("数量必须大于零".to_string());
    }

    let mut price = match optional_number(cells, mapping, Field::Price) {
        Some(raw) => match parse_number(&raw) {
            Ok(value) => {
                if value < 0.0 {
                    warnings.push("价格为负，已取绝对值。".to_string());
                }
                Some(value.abs())
            }
            Err(error) => {
                errors.push(format!("价格：{error}"));
                None
            }
        },
        None => None,
    };
    let fees = match optional_number(cells, mapping, Field::Fees) {
        Some(raw) => match parse_number(&raw) {
            Ok(value) => {
                if value < 0.0 {
                    warnings.push("费用为负，已按绝对值记账。".to_string());
                }
                value.abs()
            }
            Err(error) => {
                errors.push(format!("费用：{error}"));
                0.0
            }
        },
        None => 0.0,
    };
    let parsed_multiplier = match optional_number(cells, mapping, Field::Multiplier) {
        Some(raw) => match parse_number(&raw) {
            Ok(value)
                if value.fract().abs() < 1e-9
                    && (1.0..=1_000_000.0).contains(&value) =>
            {
                value as u32
            }
            Ok(_) => {
                errors.push("乘数必须是 1–1,000,000 的整数".to_string());
                100
            }
            Err(error) => {
                errors.push(format!("乘数：{error}"));
                100
            }
        },
        None => 100,
    };
    let multiplier = if kind.is_some_and(is_option_kind) {
        parsed_multiplier
    } else {
        100
    };
    let mut amount = match optional_number(cells, mapping, Field::Amount) {
        Some(raw) => match parse_number(&raw) {
            Ok(value) => Some(value),
            Err(error) => {
                errors.push(format!("金额：{error}"));
                None
            }
        },
        None => None,
    };

    if let Some(kind) = kind {
        if price.is_none() && qty > 0 {
            if let Some(total) = amount {
                let total = total.abs();
                let derived = if is_option_kind(kind) {
                    total / (f64::from(qty) * f64::from(multiplier))
                } else {
                    total / f64::from(qty)
                };
                price = Some(derived);
                warnings.push("价格由金额反推。".to_string());
            }
        }
        match kind {
            "option_expire" => {
                if price.unwrap_or(0.0) > 0.0 || fees > 0.0 {
                    warnings.push("到期作废不产生现金，价格与费用已清零。".to_string());
                }
                price = Some(0.0);
                amount = Some(0.0);
            }
            "option_assign" => {
                if price.unwrap_or(0.0) > 0.0 {
                    warnings.push("指派行不记权利金，价格已清零。".to_string());
                }
                price = Some(0.0);
                amount = Some(0.0);
            }
            "fee" | "adjustment" => {
                if amount.is_none() {
                    errors.push("费用或调整行需要金额列".to_string());
                }
                if kind == "fee" {
                    if let Some(value) = amount {
                        if value < 0.0 {
                            warnings.push("费用金额为负，已按绝对值记账。".to_string());
                            amount = Some(value.abs());
                        }
                    }
                }
            }
            "dividend" if qty == 0 => {
                errors.push("分红需要持股数量列".to_string());
            }
            _ => {}
        }
        if matches!(kind, "shares_buy" | "shares_sell") && price.unwrap_or(0.0) <= 0.0 {
            errors.push("股票买卖价格必须大于零".to_string());
        }
        if is_option_kind(kind) && price.is_none() {
            errors.push("期权行缺少价格".to_string());
        }
    }

    let note = cell(cells, mapping, Field::Note).map(str::to_string);
    let event = if errors.is_empty() {
        Some(CandidateEvent {
            date: date.unwrap_or_default(),
            kind: kind.unwrap_or_default().to_string(),
            symbol,
            qty,
            price: price.unwrap_or(0.0),
            fees,
            amount: amount.unwrap_or(0.0),
            expiry,
            strike,
            right,
            multiplier,
            note,
        })
    } else {
        None
    };
    let status = if !errors.is_empty() {
        RowStatus::Error
    } else if !warnings.is_empty() {
        RowStatus::Warning
    } else {
        RowStatus::Ok
    };
    let messages = warnings
        .into_iter()
        .chain(errors.into_iter().map(|error| format!("错误：{error}")))
        .collect::<Vec<_>>();
    CandidateRow {
        row_number,
        line,
        status,
        messages,
        cells: cells.to_vec(),
        raw: excerpt(cells),
        event,
        selected_by_default: status != RowStatus::Error,
    }
}

fn normalize_right(raw: &str) -> Option<String> {
    match raw.trim().to_lowercase().as_str() {
        "p" | "put" | "看跌" | "认沽" | "卖权" => Some("P".to_string()),
        "c" | "call" | "看涨" | "认购" | "买权" => Some("C".to_string()),
        _ => None,
    }
}

fn excerpt(cells: &[String]) -> String {
    let joined = cells.join(",");
    if joined.chars().count() <= 200 {
        joined
    } else {
        joined.chars().take(200).collect::<String>() + "…"
    }
}

pub fn build_preview(
    document: &ParsedDocument,
    mapping: ColumnMapping,
    mapping_source: &str,
    account: &str,
    existing: &BTreeSet<String>,
) -> ImportPreview {
    let mapping = ColumnMapping {
        has_header: Some(document.has_header),
        ..mapping
    };
    let mut rows = Vec::with_capacity(document.records.len());
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut counts = ImportCounts::default();

    for (offset, record) in document.records.iter().enumerate() {
        if is_blank(&record.cells) {
            continue;
        }
        let mut row = normalize_row(offset as u32 + 1, record.line, &record.cells, &mapping);
        if let Some(event) = &row.event {
            let fingerprint = fingerprint_candidate(event, account);
            if existing.contains(&fingerprint) {
                row.status = RowStatus::Duplicate;
                row.selected_by_default = false;
                row.messages
                    .push("与账本已有记录重复，默认不导入。".to_string());
            } else if !seen.insert(fingerprint) {
                row.status = RowStatus::Duplicate;
                row.selected_by_default = false;
                row.messages
                    .push("与本文件前面的记录重复，默认不导入。".to_string());
            }
        }
        match row.status {
            RowStatus::Ok => counts.ok += 1,
            RowStatus::Warning => counts.warning += 1,
            RowStatus::Duplicate => counts.duplicate += 1,
            RowStatus::Error => counts.error += 1,
        }
        if row.selected_by_default {
            counts.selected += 1;
        }
        counts.total += 1;
        rows.push(row);
    }

    let mut warnings = document.warnings.clone();
    // Reports are committed in file order within a date. A same-day roll must
    // close the old contract before opening the new one, so call that out
    // before the user commits a file whose rows are the other way around.
    let mut same_day: BTreeMap<(&str, &str), (bool, bool)> = BTreeMap::new();
    for row in &rows {
        let Some(event) = row.event.as_ref() else {
            continue;
        };
        let flags = same_day
            .entry((event.date.as_str(), event.symbol.as_str()))
            .or_default();
        if matches!(
            event.kind.as_str(),
            "option_close" | "option_expire" | "option_assign" | "shares_sell"
        ) {
            flags.0 = true;
        }
        if matches!(event.kind.as_str(), "option_open_short" | "shares_buy") {
            flags.1 = true;
        }
    }
    for ((date, symbol), (closes, opens)) in same_day {
        if closes && opens {
            warnings.push(format!(
                "检测到 {symbol} 在 {date} 同日既有平仓/卖出又有开仓/买入：提交时按文件行序入账，请确认先平后开。"
            ));
        }
    }

    ImportPreview {
        headers: document.headers.clone(),
        signature: document.signature.clone(),
        delimiter: document.delimiter.as_str().to_string(),
        header_line: document.header_line,
        mapping,
        mapping_source: mapping_source.to_string(),
        rows,
        counts,
        warnings,
    }
}

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

fn canonical_number(value: f64) -> String {
    let mut text = format!("{value:.6}");
    if text.contains('.') {
        text = text.trim_end_matches('0').trim_end_matches('.').to_string();
    }
    if text == "-0" {
        "0".to_string()
    } else {
        text
    }
}

#[allow(clippy::too_many_arguments)]
fn fingerprint(
    account: &str,
    date: &str,
    kind: &str,
    symbol: &str,
    expiry: Option<&str>,
    strike: Option<f64>,
    right: Option<&str>,
    multiplier: u32,
    qty: u32,
    price: f64,
    fees: f64,
    amount: f64,
) -> String {
    let mut parts = vec![
        account.to_string(),
        date.to_string(),
        kind.to_string(),
        symbol.to_ascii_uppercase(),
        expiry.unwrap_or_default().to_string(),
        strike.map(canonical_number).unwrap_or_default(),
        right.unwrap_or_default().to_ascii_uppercase(),
        qty.to_string(),
        canonical_number(price),
        canonical_number(fees),
    ];
    // Keep fingerprints written before multiplier and amount support identical.
    if multiplier != 100 {
        parts.push(format!("m{multiplier}"));
    }
    // Fee and adjustment events carry their real value in `amount`; without it
    // two same-day fees for the same symbol would look like duplicates. Other
    // kinds ignore `amount` when stored, so including it there would stop an
    // otherwise identical option/share row from being detected as a duplicate.
    if matches!(kind, "fee" | "adjustment") && amount != 0.0 {
        parts.push(format!("a{}", canonical_number(amount)));
    }
    let payload = parts.join("\u{1f}");
    format!("{:016x}", fnv1a(payload.as_bytes()))
}

pub fn fingerprint_candidate(event: &CandidateEvent, account: &str) -> String {
    fingerprint(
        account,
        &event.date,
        &event.kind,
        &event.symbol,
        event.expiry.as_deref(),
        event.strike,
        event.right.as_deref(),
        event.multiplier,
        event.qty,
        event.price,
        event.fees,
        event.amount,
    )
}

pub fn fingerprint_existing(event: &Event) -> String {
    let (expiry, strike, right) = match &event.contract {
        Some(contract) => (
            Some(format_date(contract.expiry)),
            Some(contract.strike),
            Some(contract.right.as_str().to_string()),
        ),
        None => (None, None, None),
    };
    fingerprint(
        &event.account_id,
        &format_date(event.occurred_at),
        crate::store::kind_to_str(event.kind),
        &event.symbol,
        expiry.as_deref(),
        strike,
        right.as_deref(),
        event
            .contract
            .as_ref()
            .map_or(100, |contract| contract.multiplier),
        event.qty,
        event.price,
        event.fees,
        event.amount,
    )
}

pub fn sanitize_origin(origin: &str) -> String {
    let cleaned: String = origin
        .chars()
        .filter(|ch| !ch.is_control())
        .take(60)
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "CSV".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::date;
    use wheel_core::{Event, OptionContract, Right};

    fn contract() -> OptionContract {
        OptionContract::new("AAPL", date!(2026 - 02 - 20), 150.0, Right::Put)
    }

    fn mapping() -> ColumnMapping {
        let mut fields = BTreeMap::new();
        fields.insert(Field::Date, 0);
        fields.insert(Field::Action, 1);
        fields.insert(Field::Symbol, 2);
        fields.insert(Field::Qty, 3);
        fields.insert(Field::Price, 4);
        fields.insert(Field::Fees, 5);
        fields.insert(Field::Expiry, 6);
        fields.insert(Field::Strike, 7);
        fields.insert(Field::Right, 8);
        ColumnMapping {
            fields,
            has_header: Some(true),
            ..ColumnMapping::default()
        }
    }

    fn row(cells: &[&str]) -> Vec<String> {
        cells.iter().map(|cell| cell.to_string()).collect()
    }

    #[test]
    fn csv_parser_handles_quotes_newlines_bom_and_crlf() {
        let text =
            "\u{feff}date,symbol\r\n\"2026-01-02\",\"AAPL, INC\"\r\n2026-01-03,\"line1\nline2\"\r\n";
        let records = parse_csv(text, ',').unwrap();
        assert_eq!(records.len(), 3);
        assert_eq!(records[1].cells, row(&["2026-01-02", "AAPL, INC"]));
        assert_eq!(records[2].cells, row(&["2026-01-03", "line1\nline2"]));
        assert_eq!(records[2].line, 3);
    }

    #[test]
    fn delimiter_detection_prefers_semicolon_and_tab() {
        assert_eq!(detect_delimiter("a;b;c\n1;2;3"), Delimiter::Semicolon);
        assert_eq!(detect_delimiter("a\tb\tc\n1\t2\t3"), Delimiter::Tab);
        assert_eq!(detect_delimiter("a,b,c\n1,2,3"), Delimiter::Comma);
        assert_eq!(detect_delimiter("\"a,b\";c\n1;2"), Delimiter::Semicolon);
    }

    #[test]
    fn maps_chinese_headers_and_detects_header_row() {
        let document = parse_document(
            "成交日期,方向,代码,数量,成交价,佣金\n2026-01-02,卖出开仓,AAPL,1,2.00,1.00\n",
            None,
            None,
        )
        .unwrap();
        assert!(document.has_header);
        let (mapping, warnings) = auto_map(&document.headers);
        assert!(warnings.is_empty());
        assert_eq!(mapping.fields.get(&Field::Date), Some(&0));
        assert_eq!(mapping.fields.get(&Field::Action), Some(&1));
        assert_eq!(mapping.fields.get(&Field::Symbol), Some(&2));
        assert_eq!(mapping.fields.get(&Field::Qty), Some(&3));
        assert_eq!(mapping.fields.get(&Field::Price), Some(&4));
        assert_eq!(mapping.fields.get(&Field::Fees), Some(&5));
    }

    #[test]
    fn date_parser_accepts_iso_slash_chinese_and_flags_us_order() {
        assert_eq!(
            parse_date_cell("2026-01-02", DateFormat::Auto)
                .unwrap()
                .0,
            "2026-01-02"
        );
        assert_eq!(
            parse_date_cell("2026/1/2", DateFormat::Auto).unwrap().0,
            "2026-01-02"
        );
        assert_eq!(
            parse_date_cell("2026年1月2日", DateFormat::Auto).unwrap().0,
            "2026-01-02"
        );
        let (value, warning) = parse_date_cell("1/2/2026", DateFormat::Auto).unwrap();
        assert_eq!(value, "2026-01-02");
        assert!(warning.is_some());
        assert!(parse_date_cell("2026-02-30", DateFormat::Auto).is_err());
    }

    #[test]
    fn number_parser_handles_currency_parentheses_and_nbsp() {
        assert_eq!(parse_number("$1,234.50").unwrap(), 1234.5);
        assert_eq!(parse_number("(1.20)").unwrap(), -1.2);
        assert_eq!(parse_number("1\u{a0}234,5").unwrap(), 1234.5);
        assert_eq!(parse_number("1.234,56").unwrap(), 1234.56);
        assert_eq!(parse_number("-0.75").unwrap(), -0.75);
        assert!(parse_number("abc").is_err());
    }

    #[test]
    fn occ_symbol_parses_compact_and_spaced_forms() {
        let compact = parse_occ_symbol("AAPL260220P00150000").unwrap();
        let spaced = parse_occ_symbol("AAPL 260220 P00150000").unwrap();
        assert_eq!(compact, spaced);
        assert_eq!(compact.underlying, "AAPL");
        assert_eq!(compact.expiry, "2026-02-20");
        assert_eq!(compact.strike, 150.0);
        assert_eq!(compact.right, "P");
        assert!(parse_occ_symbol("AAPL260220X00150000").is_none());
    }

    #[test]
    fn action_text_mapping_covers_common_broker_wording() {
        assert_eq!(
            kind_from_action("Sell to Open", true),
            ActionResult::Kind("option_open_short")
        );
        assert_eq!(
            kind_from_action("卖出开仓", true),
            ActionResult::Kind("option_open_short")
        );
        assert_eq!(
            kind_from_action("BTC", true),
            ActionResult::Kind("option_close")
        );
        assert_eq!(
            kind_from_action("Assigned", true),
            ActionResult::Kind("option_assign")
        );
        assert_eq!(
            kind_from_action("分红", false),
            ActionResult::Kind("dividend")
        );
        assert!(matches!(
            kind_from_action("Buy to Open", true),
            ActionResult::Unsupported(_)
        ));
        assert!(matches!(
            kind_from_action("whatever", false),
            ActionResult::Unknown(_)
        ));
    }

    #[test]
    fn normalize_row_maps_option_open_with_fee_warning() {
        let cells = row(&[
            "2026-01-02",
            "Sell to Open",
            "aapl",
            "1",
            "2.00",
            "-1.00",
            "2026-02-20",
            "150",
            "P",
        ]);
        let row = normalize_row(1, 2, &cells, &mapping());
        assert_eq!(row.status, RowStatus::Warning);
        let event = row.event.unwrap();
        assert_eq!(event.kind, "option_open_short");
        assert_eq!(event.symbol, "AAPL");
        assert_eq!(event.fees, 1.0);
        assert_eq!(event.expiry.as_deref(), Some("2026-02-20"));
        assert_eq!(event.strike, Some(150.0));
        assert_eq!(event.right.as_deref(), Some("P"));
    }

    #[test]
    fn normalize_row_derives_option_price_from_amount() {
        let mut mapping = mapping();
        mapping.fields.remove(&Field::Price);
        mapping.fields.insert(Field::Amount, 4);
        let cells = row(&[
            "2026-01-02",
            "Sell to Open",
            "AAPL",
            "2",
            "400",
            "0",
            "2026-02-20",
            "150",
            "P",
        ]);
        let row = normalize_row(1, 2, &cells, &mapping);
        assert_eq!(row.status, RowStatus::Warning);
        assert_eq!(row.event.unwrap().price, 2.0);
    }

    #[test]
    fn normalize_row_rejects_incomplete_contract_and_long_options() {
        let cells = row(&[
            "2026-01-02",
            "Sell to Open",
            "AAPL",
            "1",
            "2.00",
            "0",
            "2026-02-20",
            "",
            "P",
        ]);
        let parsed = normalize_row(1, 2, &cells, &mapping());
        assert_eq!(parsed.status, RowStatus::Error);
        assert!(parsed.event.is_none());

        let cells = row(&[
            "2026-01-02",
            "Buy to Open",
            "AAPL",
            "1",
            "2.00",
            "0",
            "2026-02-20",
            "150",
            "P",
        ]);
        let parsed = normalize_row(1, 2, &cells, &mapping());
        assert_eq!(parsed.status, RowStatus::Error);
        assert!(parsed
            .messages
            .iter()
            .any(|message| message.contains("暂不支持")));
    }

    #[test]
    fn dividend_requires_shares_and_derives_per_share() {
        let mut mapping = mapping();
        mapping.fields.clear();
        mapping.fields.insert(Field::Date, 0);
        mapping.fields.insert(Field::Action, 1);
        mapping.fields.insert(Field::Symbol, 2);
        mapping.fields.insert(Field::Qty, 3);
        mapping.fields.insert(Field::Amount, 4);
        let cells = row(&["2026-01-02", "Dividend", "AAPL", "100", "50"]);
        let parsed = normalize_row(1, 2, &cells, &mapping);
        assert_eq!(parsed.status, RowStatus::Warning);
        let event = parsed.event.unwrap();
        assert_eq!(event.kind, "dividend");
        assert_eq!(event.qty, 100);
        assert_eq!(event.price, 0.5);

        let cells = row(&["2026-01-02", "Dividend", "AAPL", "", "50"]);
        let parsed = normalize_row(2, 3, &cells, &mapping);
        assert_eq!(parsed.status, RowStatus::Error);
    }

    #[test]
    fn assignment_row_forces_zero_premium_and_keeps_fees() {
        let cells = row(&[
            "2026-02-20",
            "Assigned",
            "AAPL",
            "1",
            "3.00",
            "1.00",
            "2026-02-20",
            "150",
            "P",
        ]);
        let row = normalize_row(1, 2, &cells, &mapping());
        let event = row.event.unwrap();
        assert_eq!(event.kind, "option_assign");
        assert_eq!(event.price, 0.0);
        assert_eq!(event.fees, 1.0);
        assert!(row
            .messages
            .iter()
            .any(|message| message.contains("指派行不记权利金")));
    }

    #[test]
    fn fingerprints_normalize_float_noise_and_match_existing_event() {
        let candidate = CandidateEvent {
            date: "2026-01-02".to_string(),
            kind: "option_open_short".to_string(),
            symbol: "AAPL".to_string(),
            qty: 1,
            price: 2.000_000_1,
            fees: 1.0,
            amount: 0.0,
            expiry: Some("2026-02-20".to_string()),
            strike: Some(150.0),
            right: Some("P".to_string()),
            multiplier: 100,
            note: None,
        };
        let event = Event::sell_option(
            "main",
            "e1",
            1,
            date!(2026 - 01 - 02),
            contract(),
            1,
            2.0,
            1.0,
        );
        assert_eq!(
            fingerprint_candidate(&candidate, "main"),
            fingerprint_existing(&event)
        );
    }

    #[test]
    fn fingerprint_includes_amount_so_same_day_fees_are_distinct() {
        let fee = |amount: f64| CandidateEvent {
            date: "2026-01-02".to_string(),
            kind: "fee".to_string(),
            symbol: "AAPL".to_string(),
            qty: 0,
            price: 0.0,
            fees: 0.0,
            amount,
            expiry: None,
            strike: None,
            right: None,
            multiplier: 100,
            note: None,
        };
        let first = fee(2.0);
        let second = fee(3.0);
        assert_ne!(
            fingerprint_candidate(&first, "main"),
            fingerprint_candidate(&second, "main")
        );
        let event = Event::fee("main", "e1", 1, date!(2026 - 01 - 02), "AAPL", 2.0);
        assert_eq!(
            fingerprint_candidate(&first, "main"),
            fingerprint_existing(&event)
        );
    }

    #[test]
    fn preview_warns_when_same_day_close_precedes_open_order_matters() {
        let document = parse_document(
            "日期,方向,代码,数量,价格,费用,到期日,行权价,看涨看跌\n\
             2026-01-02,Sell to Open,AAPL,1,2.00,0,2026-02-20,150,P\n\
             2026-01-02,Buy to Close,AAPL,1,1.00,0,2026-02-20,150,P\n",
            None,
            None,
        )
        .unwrap();
        let (mapping, _) = auto_map(&document.headers);
        let preview = build_preview(&document, mapping, "detected", "main", &BTreeSet::new());
        assert!(preview
            .warnings
            .iter()
            .any(|warning| warning.contains("先平后开")));
    }

    #[test]
    fn preview_marks_duplicates_against_existing_and_within_file() {
        let document = parse_document(
            "日期,方向,代码,数量,价格,费用,到期日,行权价,看涨看跌\n\
             2026-01-02,Sell to Open,AAPL,1,2.00,0,2026-02-20,150,P\n\
             2026-01-02,Sell to Open,AAPL,1,2.00,0,2026-02-20,150,P\n\
             2026-01-03,Sell to Open,MSFT,1,3.00,0,2026-02-20,400,P\n",
            None,
            None,
        )
        .unwrap();
        let (mapping, _) = auto_map(&document.headers);
        let existing_event = Event::sell_option(
            "main",
            "e1",
            1,
            date!(2026 - 01 - 03),
            OptionContract::new("MSFT", date!(2026 - 02 - 20), 400.0, Right::Put),
            1,
            3.0,
            0.0,
        );
        let existing: BTreeSet<String> = [fingerprint_existing(&existing_event)].into_iter().collect();
        let preview = build_preview(&document, mapping, "detected", "main", &existing);
        assert_eq!(preview.counts.total, 3);
        assert_eq!(preview.counts.duplicate, 2);
        assert_eq!(preview.counts.selected, 1);
    }

    #[test]
    fn row_without_header_uses_generated_column_names() {
        let document = parse_document(
            "2026-01-02,Sell to Open,AAPL,1,2.00,0,2026-02-20,150,P\n",
            None,
            None,
        )
        .unwrap();
        assert!(!document.has_header);
        assert_eq!(document.headers.first().map(String::as_str), Some("列 1"));
    }

    #[test]
    fn mapping_validation_requires_date_symbol_and_kind() {
        let mut mapping = ColumnMapping::default();
        mapping.fields.insert(Field::Date, 0);
        assert!(validate_mapping(&mapping, 3).is_err());
        mapping.fields.insert(Field::Symbol, 1);
        assert!(validate_mapping(&mapping, 3).is_err());
        mapping.fields.insert(Field::Action, 2);
        assert!(validate_mapping(&mapping, 3).is_ok());
        assert!(validate_mapping(&mapping, 2).is_err());
    }
}
