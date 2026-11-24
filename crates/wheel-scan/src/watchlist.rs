//! Cash-secured-put scan for a watchlist.
//!
//! Unlike [`crate::strategy::scan`], this scan needs no campaign and no shares:
//! the user is looking for a first entry on a symbol they follow. It therefore
//! only returns short puts, sizes them against the account's recorded cash and
//! never projects a ledger scenario. Every number shown here is a quote
//! metric, not an accounting result.

use serde::Serialize;
use time::Date;
use wheel_core::Right;

use crate::pricing;
use crate::strategy::{
    liquid, otm_distance, pick_price, ChainQuote, Flag, PriceSource, ScanFilters, ScanSettings,
};

/// Everything the watchlist scanner needs for one symbol.
pub struct WatchlistInput<'a> {
    pub symbol: String,
    pub today: Date,
    pub price: f64,
    /// `None` when the account has never recorded a deposit or withdrawal.
    pub cash: Option<f64>,
    pub chain_stale: bool,
    pub quotes: &'a [ChainQuote],
    pub settings: ScanSettings,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CspCandidate {
    pub symbol: String,
    pub expiry: String,
    pub dte: i64,
    pub strike: f64,
    /// Always `"P"`; kept explicit so the UI can build an entry request.
    pub right: String,
    /// Per-share credit used for sizing.
    pub per_share: f64,
    pub price_source: PriceSource,
    pub qty: u32,
    /// Strike collateral for `qty` contracts.
    pub cash_required: f64,
    /// Credit after fees for `qty` contracts.
    pub premium_total: f64,
    pub fees: f64,
    pub annualized: f64,
    pub delta: Option<f64>,
    pub prob_itm: Option<f64>,
    /// Per-share breakeven after the credit (`strike - per_share`).
    pub breakeven: f64,
    /// OTM distance as a fraction of the current price.
    pub otm_pct: f64,
    pub open_interest: Option<i64>,
    pub multiplier: u32,
    pub flags: Vec<Flag>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchlistOutcome {
    pub symbol: String,
    pub chain_stale: bool,
    pub scanned_quotes: usize,
    pub filters: ScanFilters,
    pub candidates: Vec<CspCandidate>,
}

/// Scan one symbol's chain for sellable cash-secured puts. The caller decides
/// which symbols to scan and supplies their latest price; this function has no
/// database or network dependency.
pub fn scan_watchlist(input: &WatchlistInput) -> WatchlistOutcome {
    let mut filters = ScanFilters {
        total_quotes: input.quotes.len(),
        ..ScanFilters::default()
    };
    let mut candidates = Vec::new();
    let mut scanned_quotes = 0usize;

    if !(input.price.is_finite() && input.price > 0.0) {
        return WatchlistOutcome {
            symbol: input.symbol.clone(),
            chain_stale: input.chain_stale,
            scanned_quotes,
            filters,
            candidates,
        };
    }

    for quote in input.quotes {
        if quote.right != Right::Put {
            filters.calls_disabled += 1;
            continue;
        }
        if !quote.strike.is_finite() || quote.strike <= 0.0 || quote.multiplier == 0 {
            filters.invalid_quotes += 1;
            continue;
        }
        let dte = (quote.expiry - input.today).whole_days();
        if dte < input.settings.dte_min || dte > input.settings.dte_max {
            filters.outside_dte += 1;
            continue;
        }
        scanned_quotes += 1;

        let Some(per_share) = pick_price(quote, input.settings.price_source) else {
            filters.missing_price += 1;
            continue;
        };
        let liquid_quote = liquid(quote, &input.settings);
        if input.settings.liquidity_filter && !liquid_quote {
            filters.illiquid += 1;
            continue;
        }

        let years = dte as f64 / 365.0;
        let vol = quote.iv.or_else(|| {
            pricing::implied_vol(
                per_share,
                input.price,
                quote.strike,
                years,
                input.settings.risk_free_rate,
                input.settings.dividend_yield,
                Right::Put,
            )
        });
        let delta = vol.and_then(|vol| {
            pricing::delta(
                input.price,
                quote.strike,
                years,
                input.settings.risk_free_rate,
                input.settings.dividend_yield,
                vol,
                Right::Put,
            )
        });
        let filter_delta = delta
            .map(f64::abs)
            .unwrap_or_else(|| otm_distance(input.price, quote.strike, Right::Put));
        if filter_delta < input.settings.delta_min || filter_delta > input.settings.delta_max {
            filters.outside_delta += 1;
            continue;
        }
        if quote.strike > input.price * input.settings.put_max_strike_ratio + 1e-9 {
            filters.put_strike_too_high += 1;
            continue;
        }

        let required = quote.strike * f64::from(quote.multiplier);
        let qty = match input.cash {
            Some(cash) if cash.is_finite() && cash > 0.0 => {
                (cash / required).floor().max(0.0) as u32
            }
            // Without a recorded balance a single contract is a sizing hint,
            // not a claim that the account can afford it.
            _ => 1,
        };
        if qty == 0 {
            filters.no_quantity += 1;
            continue;
        }

        let fees = input.settings.fee_per_contract * f64::from(qty);
        let premium_total = per_share * f64::from(quote.multiplier) * f64::from(qty) - fees;
        if !(premium_total.is_finite() && premium_total > 0.0) {
            filters.no_premium += 1;
            continue;
        }
        let cash_required = required * f64::from(qty);
        let annualized = if cash_required > 0.0 && dte > 0 {
            premium_total / cash_required * 365.0 / dte as f64
        } else {
            0.0
        };
        let prob_itm = vol.and_then(|vol| {
            pricing::prob_itm(
                input.price,
                quote.strike,
                years,
                input.settings.risk_free_rate,
                input.settings.dividend_yield,
                vol,
                Right::Put,
            )
        });

        let mut flags = Vec::new();
        if input.chain_stale {
            flags.push(Flag::ChainStale);
        }
        if !liquid_quote {
            flags.push(Flag::Illiquid);
        }
        if input.cash.is_none() {
            flags.push(Flag::InsufficientCash);
        }
        if delta.is_some_and(|delta| delta.abs() > 0.60) {
            flags.push(Flag::DeepItm);
        }
        if dte <= 3 && ((quote.strike - input.price) / input.price).abs() <= 0.02 {
            flags.push(Flag::NearExpiry);
        }

        candidates.push(CspCandidate {
            symbol: input.symbol.clone(),
            expiry: quote.expiry.to_string(),
            dte,
            strike: quote.strike,
            right: "P".to_string(),
            per_share,
            price_source: input.settings.price_source,
            qty,
            cash_required,
            premium_total,
            fees,
            annualized,
            delta,
            prob_itm,
            breakeven: quote.strike - per_share,
            otm_pct: (input.price - quote.strike) / input.price,
            open_interest: quote.open_interest,
            multiplier: quote.multiplier,
            flags,
        });
    }

    candidates.sort_by(|left, right| {
        right
            .annualized
            .total_cmp(&left.annualized)
            .then_with(|| left.strike.total_cmp(&right.strike))
    });
    candidates.truncate(input.settings.projection_limit.max(1) * 2);

    WatchlistOutcome {
        symbol: input.symbol.clone(),
        chain_stale: input.chain_stale,
        scanned_quotes,
        filters,
        candidates,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::date;

    fn settings() -> ScanSettings {
        ScanSettings {
            dte_min: 7,
            dte_max: 60,
            delta_min: 0.0,
            delta_max: 1.0,
            liquidity_filter: false,
            price_source: PriceSource::Mark,
            fee_per_contract: 0.0,
            put_max_strike_ratio: 1.0,
            ..ScanSettings::default()
        }
    }

    fn quote(expiry: Date, strike: f64, mark: f64) -> ChainQuote {
        ChainQuote {
            expiry,
            strike,
            right: Right::Put,
            bid: Some(mark),
            ask: Some(mark + 0.05),
            mark: Some(mark),
            iv: Some(0.40),
            open_interest: Some(500),
            volume: Some(50),
            multiplier: 100,
        }
    }

    #[test]
    fn sizes_contracts_against_cash_and_orders_by_annualized_return() {
        let today = date!(2026 - 01 - 02);
        let quotes = vec![
            quote(today + time::Duration::days(30), 90.0, 1.0),
            quote(today + time::Duration::days(30), 95.0, 2.0),
        ];
        let outcome = scan_watchlist(&WatchlistInput {
            symbol: "AAPL".into(),
            today,
            price: 100.0,
            cash: Some(20_000.0),
            chain_stale: false,
            quotes: &quotes,
            settings: settings(),
        });
        assert_eq!(outcome.candidates.len(), 2);
        // 95 put: 2.00 × 100 × 2 contracts = 400 credit on 19,000 collateral.
        let best = &outcome.candidates[0];
        assert_eq!(best.strike, 95.0);
        assert_eq!(best.qty, 2);
        assert!((best.cash_required - 19_000.0).abs() < 1e-9);
        assert!(best.annualized > outcome.candidates[1].annualized);
        assert!((best.breakeven - 93.0).abs() < 1e-9);
        assert!((best.otm_pct - 0.05).abs() < 1e-9);
    }

    #[test]
    fn untracked_cash_shows_one_contract_with_a_warning_flag() {
        let today = date!(2026 - 01 - 02);
        let quotes = vec![quote(today + time::Duration::days(30), 90.0, 1.0)];
        let outcome = scan_watchlist(&WatchlistInput {
            symbol: "AAPL".into(),
            today,
            price: 100.0,
            cash: None,
            chain_stale: false,
            quotes: &quotes,
            settings: settings(),
        });
        assert_eq!(outcome.candidates.len(), 1);
        assert_eq!(outcome.candidates[0].qty, 1);
        assert!(outcome.candidates[0]
            .flags
            .contains(&Flag::InsufficientCash));
    }

    #[test]
    fn skips_contracts_the_account_cannot_secure_and_calls() {
        let today = date!(2026 - 01 - 02);
        let mut call = quote(today + time::Duration::days(30), 110.0, 1.0);
        call.right = Right::Call;
        let quotes = vec![call, quote(today + time::Duration::days(30), 100.0, 1.0)];
        let outcome = scan_watchlist(&WatchlistInput {
            symbol: "AAPL".into(),
            today,
            price: 100.0,
            cash: Some(5_000.0),
            chain_stale: false,
            quotes: &quotes,
            settings: settings(),
        });
        assert!(outcome.candidates.is_empty());
        assert_eq!(outcome.filters.calls_disabled, 1);
        assert_eq!(outcome.filters.no_quantity, 1);
    }

    #[test]
    fn missing_price_returns_an_empty_outcome_instead_of_panicking() {
        let today = date!(2026 - 01 - 02);
        let quotes = vec![quote(today + time::Duration::days(30), 90.0, 1.0)];
        let outcome = scan_watchlist(&WatchlistInput {
            symbol: "AAPL".into(),
            today,
            price: f64::NAN,
            cash: Some(10_000.0),
            chain_stale: false,
            quotes: &quotes,
            settings: settings(),
        });
        assert!(outcome.candidates.is_empty());
    }
}
