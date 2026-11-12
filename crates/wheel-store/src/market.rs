//! Tencent public US equity data. Provider assignment text is parsed, never executed.
use crate::views::{MarketQuote, QuoteFailure, SymbolMatch};
use reqwest::Client;
use std::{collections::HashSet, time::Duration};
use time::{macros::format_description, PrimitiveDateTime};
pub const SOURCE: &str = "腾讯财经";
pub const MAX_SYMBOLS: usize = 50;

pub fn normalize_symbol(value: &str) -> Result<String, String> {
    let symbol = value.trim().to_ascii_uppercase();
    if symbol.is_empty()
        || symbol.len() > 20
        || !symbol.as_bytes()[0].is_ascii_uppercase()
        || !symbol
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
    {
        return Err("请输入有效的美股代码（字母开头，最多 20 个字母、数字、点或连字符）".into());
    }
    Ok(symbol.to_string())
}
// Exchange suffixes belong to provider identities, never to user-entered tickers.
fn provider_symbol(value: &str) -> Result<String, String> {
    let upper = value.trim().to_ascii_uppercase();
    let symbol = [".OQ", ".AM", ".N", ".O", ".P"]
        .iter()
        .find_map(|suffix| upper.strip_suffix(suffix))
        .unwrap_or(&upper);
    normalize_symbol(symbol)
}
fn client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("行情客户端初始化失败: {e}"))
}
async fn text(response: reqwest::Response) -> Result<String, String> {
    response
        .error_for_status()
        .map_err(|e| format!("行情服务请求失败: {e}"))?
        .text_with_charset("gbk")
        .await
        .map_err(|e| format!("行情响应解码失败: {e}"))
}
// Only accept an exact named assignment with one JSON-compatible quoted string.
fn assignment(body: &str, variable: &str) -> Result<String, String> {
    let body = body.trim().trim_start_matches('\u{feff}');
    let (lhs, rhs) = body.split_once('=').ok_or("行情响应缺少赋值")?;
    if lhs.trim() != variable {
        return Err("行情响应标识不匹配".into());
    }
    let rhs = rhs.trim().strip_suffix(';').unwrap_or(rhs.trim()).trim();
    serde_json::from_str::<String>(rhs).map_err(|_| "行情响应字符串格式无效".into())
}
pub fn parse_search(body: &str) -> Result<Vec<SymbolMatch>, String> {
    let value = assignment(body, "v_hint")?;
    let mut seen = HashSet::new();
    let mut matches = Vec::new();
    for entry in value.split('^') {
        let fields: Vec<_> = entry.split('~').collect();
        if fields.len() < 3 || fields[0] != "us" || fields[2].trim().is_empty() {
            continue;
        }
        let Ok(symbol) = provider_symbol(fields[1]) else {
            continue;
        };
        if seen.insert(symbol.clone()) {
            matches.push(SymbolMatch {
                symbol,
                name: fields[2].to_string(),
                exchange: "US".into(),
            });
        }
        if matches.len() == 20 {
            break;
        }
    }
    Ok(matches)
}
pub async fn search(query: &str) -> Result<Vec<SymbolMatch>, String> {
    let query = query.trim();
    if query.chars().count() > 80 {
        return Err("搜索内容最多 80 个字符".into());
    }
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let response = client()?
        .get("https://smartbox.gtimg.cn/s3/")
        .query(&[("q", query), ("t", "us")])
        .send()
        .await
        .map_err(|e| format!("标的查询失败: {e}"))?;
    parse_search(&text(response).await?)
}
pub fn validate_timestamp(value: &str) -> Result<(), String> {
    if value.len() != 19 || !value.is_ascii() {
        return Err("行情时间格式无效".into());
    }
    PrimitiveDateTime::parse(
        value,
        format_description!("[year]-[month]-[day] [hour]:[minute]:[second]"),
    )
    .map_err(|_| "行情时间无效".to_string())?;
    Ok(())
}
fn optional_number(value: &str, positive: bool) -> Result<Option<f64>, String> {
    if value.trim().is_empty() || value == "-" {
        return Ok(None);
    }
    let number: f64 = value.parse().map_err(|_| "行情数值无效")?;
    if !number.is_finite() || (positive && number <= 0.0) {
        return Err("行情数值超出有效范围".into());
    }
    Ok(Some(number))
}
fn parse_quote(statement: &str, symbol: &str) -> Result<MarketQuote, String> {
    let value = assignment(statement, &format!("v_us{symbol}"))?;
    let fields: Vec<_> = value.split('~').collect();
    if fields.len() <= 46 {
        return Err("行情响应字段不完整".into());
    }
    if fields[2].trim().to_ascii_uppercase() != symbol && provider_symbol(fields[2])? != symbol {
        return Err("行情代码与请求不一致".into());
    }
    if fields[35] != "USD" {
        return Err("行情币种不是 USD".into());
    }
    let price = optional_number(fields[3], true)?.ok_or("行情缺少价格")?;
    validate_timestamp(fields[30])?;
    let name = if fields[46].trim().is_empty() {
        fields[1]
    } else {
        fields[46]
    };
    if name.trim().is_empty() {
        return Err("行情缺少标的名称".into());
    }
    Ok(MarketQuote {
        symbol: symbol.into(),
        name: name.into(),
        price,
        previous_close: optional_number(fields[4], true)?,
        change_percent: optional_number(fields[32], false)?,
        quoted_at: fields[30].into(),
        source: SOURCE.into(),
        currency: "USD".into(),
    })
}
// Split semicolons only outside strings; company names may contain semicolons.
fn statements(body: &str) -> Vec<&str> {
    let mut result = Vec::new();
    let (mut start, mut quoted, mut escaped) = (0, false, false);
    for (index, ch) in body.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if quoted && ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '"' {
            quoted = !quoted;
        }
        if ch == ';' && !quoted {
            result.push(body[start..=index].trim());
            start = index + 1;
        }
    }
    if !body[start..].trim().is_empty() {
        result.push(body[start..].trim());
    }
    result
}
pub fn parse_batch(body: &str, symbols: &[String]) -> (Vec<MarketQuote>, Vec<QuoteFailure>) {
    let lines = statements(body);
    let mut updated = Vec::new();
    let mut failed = Vec::new();
    for symbol in symbols {
        let variable = format!("v_us{symbol}");
        let matching: Vec<_> = lines
            .iter()
            .filter(|line| {
                line.split_once('=')
                    .is_some_and(|(lhs, _)| lhs.trim() == variable)
            })
            .collect();
        let quote = if matching.len() == 1 {
            parse_quote(matching[0], symbol)
        } else {
            Err("行情缺失或包含重复响应".into())
        };
        match quote {
            Ok(quote) => updated.push(quote),
            Err(error) => failed.push(QuoteFailure {
                symbol: symbol.clone(),
                error,
            }),
        }
    }
    (updated, failed)
}
pub async fn fetch_batch(
    symbols: &[String],
) -> Result<(Vec<MarketQuote>, Vec<QuoteFailure>), String> {
    if symbols.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }
    if symbols.len() > MAX_SYMBOLS {
        return Err("一次最多刷新 50 个标的".into());
    }
    let codes = symbols
        .iter()
        .map(|s| normalize_symbol(s).map(|s| format!("us{s}")))
        .collect::<Result<Vec<_>, _>>()?
        .join(",");
    let response = client()?
        .get("https://qt.gtimg.cn/")
        .query(&[("q", codes)])
        .send()
        .await
        .map_err(|e| format!("行情加载失败: {e}"))?;
    Ok(parse_batch(&text(response).await?, symbols))
}
pub async fn fetch(symbol: &str) -> Result<MarketQuote, String> {
    let symbol = normalize_symbol(symbol)?;
    let (mut quotes, failed) = fetch_batch(&[symbol]).await?;
    quotes.pop().ok_or_else(|| {
        failed
            .into_iter()
            .next()
            .map_or_else(|| "行情缺失".into(), |f| f.error)
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(symbol: &str) -> String {
        let mut fields = vec![""; 47];
        fields[1] = "苹果";
        fields[2] = symbol;
        fields[3] = "338.32";
        fields[4] = "344.63";
        fields[30] = "2026-11-02 16:00:02";
        fields[32] = "-1.83";
        fields[35] = "USD";
        fields[46] = "Apple Inc; Company";
        format!(
            "v_us{}={};",
            provider_symbol(symbol).unwrap(),
            serde_json::to_string(&fields.join("~")).unwrap()
        )
    }
    #[test]
    fn search_keeps_class_shares_etfs_and_unicode() {
        let result = parse_search(r#"v_hint="us~brk.b.n~Berkshire~*~GP^us~spy~SPDR ETF~*~ETF^us~aapl.oq~苹果~*~GP^hk~00700~Tencent~*~GP";"#).unwrap();
        assert_eq!(
            result.iter().map(|s| s.symbol.as_str()).collect::<Vec<_>>(),
            ["BRK.B", "SPY", "AAPL"]
        );
        assert_eq!(result[2].name, "苹果");
        let escaped = format!(
            r#"v_hint="us~aapl.oq~{0}u82f9{0}u679c~*~GP";"#,
            char::from(92)
        );
        assert_eq!(parse_search(&escaped).unwrap()[0].name, "苹果");
        assert_eq!(normalize_symbol(" brk.b ").unwrap(), "BRK.B");
        assert_eq!(normalize_symbol("brk.a").unwrap(), "BRK.A");
        assert_eq!(provider_symbol("brk.a.n").unwrap(), "BRK.A");
        assert_eq!(provider_symbol("spy.am").unwrap(), "SPY");
        assert_eq!(
            parse_quote(&fixture("BRK.A.N"), "BRK.A").unwrap().symbol,
            "BRK.A"
        );
        assert_eq!(
            parse_quote(&fixture("SPY.AM"), "SPY").unwrap().symbol,
            "SPY"
        );
        for symbol in [
            "",
            "../A",
            "A,B",
            "A/B",
            "1A",
            "A中",
            "ABCDEFGHIJKLMNOPQRSTU",
        ] {
            assert!(normalize_symbol(symbol).is_err());
        }
        assert!(parse_search("v_hint=alert(1);").is_err());
        assert!(parse_search("v_hint=\"\";alert(1)").is_err());
    }
    #[test]
    fn quote_validates_identity_currency_price_and_time() {
        let body = fixture("BRK.B.N");
        let quote = parse_quote(&body, "BRK.B").unwrap();
        assert_eq!(quote.symbol, "BRK.B");
        assert_eq!(quote.price, 338.32);
        assert_eq!(quote.quoted_at, "2026-11-02 16:00:02");
        for body in [
            body.replace("USD", "HKD"),
            body.replace("338.32", "0"),
            body.replace("338.32", "NaN"),
            body.replace("338.32", "-1"),
            body.replace("2026-11-02", "2026-02-30"),
            body.replace("16:00:02", "25:00:02"),
            body.replace("BRK.B.N", "MSFT.OQ"),
            "v_usBRK.B=\"\";".into(),
        ] {
            assert!(parse_quote(&body, "BRK.B").is_err(), "{body}");
        }
        let (good, failed) = parse_batch(
            &(fixture("AAPL.OQ") + &fixture("BRK.B.N")),
            &["AAPL".into(), "BRK.B".into(), "MISSING".into()],
        );
        assert_eq!(good.len(), 2);
        assert_eq!(failed.len(), 1);
        assert_eq!(good[0].name, "Apple Inc; Company");
    }
    #[test]
    fn recorded_provider_layout_uses_currency_before_volume() {
        let body = r#"v_usAAPL="200~Apple~AAPL.OQ~338.32~344.63~342.67~64757691~0~0~329.00~120~0~0~0~0~0~0~0~0~329.10~80~0~0~0~0~0~0~0~0~~2026-11-02 16:00:02~-6.31~-1.83~343.80~335.82~USD~64757691~21950929283~0.44~38.80~~45.35~~2.32~49344.34036~49375.02978~Apple Inc.~8.72~351.73~242.76~40~45.92~0.31~49375.02978~24.78~-1.63~GP~148.75~36.08~-1.35~1.63~8.07~14594180000~14585108878~1.41~36.88~1.06~338.97~~~~~";"#;
        let quote = parse_quote(body, "AAPL").unwrap();
        assert_eq!(quote.currency, "USD");
        assert_eq!(quote.price, 338.32);
        assert_eq!(quote.previous_close, Some(344.63));
        assert_eq!(quote.change_percent, Some(-1.83));
        assert_eq!(quote.name, "Apple Inc.");
        assert_eq!(quote.quoted_at, "2026-11-02 16:00:02");
    }
    #[tokio::test]
    async fn gbk_http_text_decodes_provider_names() {
        let response = http::Response::builder()
            .body(vec![0xc6, 0xbb, 0xb9, 0xfb])
            .unwrap();
        assert_eq!(
            text(reqwest::Response::from(response)).await.unwrap(),
            "苹果"
        );
    }
    #[tokio::test]
    #[ignore = "requires live Tencent HTTPS endpoints"]
    async fn live_search_and_quote() {
        assert!(search("apple")
            .await
            .unwrap()
            .iter()
            .any(|s| s.symbol == "AAPL"));
        assert!(fetch("AAPL").await.unwrap().price > 0.0);
        let (quotes, failures) = fetch_batch(&[
            "AAPL".into(),
            "MSFT".into(),
            "BRK.B".into(),
            "BRK.A".into(),
            "SPY".into(),
        ])
        .await
        .unwrap();
        assert!(failures.is_empty(), "{failures:?}");
        assert_eq!(quotes.len(), 5);
        assert!(search("SPY")
            .await
            .unwrap()
            .iter()
            .any(|s| s.symbol == "SPY"));
    }
}
