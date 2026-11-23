//! DTOs sent to the frontend. Field names are camelCase over IPC.

use serde::Serialize;
use time::macros::format_description;
use time::{Date, OffsetDateTime, PrimitiveDateTime};
use wheel_core::{
    Campaign, CostPoint, DerivedState, Event, OptionPosition, PremiumEntry, Right, ShareLot,
};

use crate::option_chain::{ChainSnapshot, OptionQuote, ParseOutcome, ParsedQuote};

fn date_str(date: Date) -> String {
    date.to_string()
}

pub fn summary(derived: &DerivedState) -> SummaryView {
    let open_contracts = derived
        .positions
        .iter()
        .map(|position| position.open_qty)
        .sum();
    // `Sum` for floats folds from -0.0, which would render as "-0" in the UI
    // when no Put is open; normalize the empty/zero total to positive zero.
    let mut collateral: f64 = derived
        .positions
        .iter()
        .filter(|position| position.contract.right == Right::Put)
        .map(|position| {
            position.contract.strike
                * f64::from(position.contract.multiplier)
                * f64::from(position.open_qty)
        })
        .sum();
    if collateral == 0.0 {
        collateral = 0.0;
    }
    let shares_held = derived
        .campaigns
        .iter()
        .filter(|campaign| campaign.is_active())
        .map(|campaign| campaign.shares)
        .sum();
    let cash_tracked = derived.cash_deposits > 0.0 || derived.cash_withdrawals > 0.0;
    let cash_coverage =
        (cash_tracked && collateral > 0.0).then(|| derived.account_cash / collateral);
    let cash_shortfall: f64 = if cash_tracked {
        (collateral - derived.account_cash).max(0.0)
    } else {
        0.0
    };
    SummaryView {
        premium_realized: derived.total_premium_realized(),
        premium_open: derived.total_premium_open(),
        active_campaigns: derived
            .campaigns
            .iter()
            .filter(|campaign| campaign.is_active())
            .count(),
        open_positions: derived.positions.len(),
        open_contracts,
        collateral,
        shares_held,
        account_cash: derived.account_cash,
        cash_deposits: derived.cash_deposits,
        cash_withdrawals: derived.cash_withdrawals,
        cash_tracked,
        cash_coverage,
        cash_shortfall,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardView {
    pub account_id: String,
    pub as_of: String,
    pub summary: SummaryView,
    pub campaigns: Vec<CampaignCardView>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryView {
    pub premium_realized: f64,
    pub premium_open: f64,
    pub active_campaigns: usize,
    pub open_positions: usize,
    pub open_contracts: u32,
    pub collateral: f64,
    pub shares_held: u32,
    pub account_cash: f64,
    pub cash_deposits: f64,
    pub cash_withdrawals: f64,
    pub cash_tracked: bool,
    pub cash_coverage: Option<f64>,
    pub cash_shortfall: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CampaignCardView {
    pub id: String,
    pub symbol: String,
    pub status: String,
    pub shares: u32,
    pub cost_a: Option<f64>,
    pub cost_b: Option<f64>,
    pub cost_c: Option<f64>,
    pub premium_realized: f64,
    pub premium_open: f64,
    pub dividends: f64,
    pub adjustments: f64,
    pub price: Option<f64>,
    pub safety_margin: Option<f64>,
    pub next_option: Option<OptionSummaryView>,
    pub realized_pnl: Option<f64>,
    pub share_pnl: f64,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub cycles: u32,
    pub cost_points: Vec<CostPointView>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptionSummaryView {
    pub contract: String,
    pub right: String,
    pub strike: f64,
    pub expiry: String,
    pub days_left: i64,
    pub open_qty: u32,
    pub multiplier: u32,
    pub avg_credit: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostPointView {
    pub at: String,
    pub shares: u32,
    pub premium_realized: f64,
    pub premium_open: f64,
    pub cost_a: f64,
    pub cost_b: f64,
    pub cost_c: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryView {
    pub id: String,
    pub campaign_id: String,
    pub symbol: String,
    pub contract: String,
    pub right: String,
    pub multiplier: u32,
    pub qty: u32,
    pub open_qty: u32,
    pub opened_at: String,
    pub closed_at: Option<String>,
    pub status: String,
    pub premium_gross: f64,
    pub fees: f64,
    pub close_cost: f64,
    pub net_premium: f64,
    pub collateral: f64,
    pub days_held: Option<i64>,
    pub annualized_return: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionView {
    pub campaign_id: String,
    pub symbol: String,
    pub contract: String,
    pub right: String,
    pub strike: f64,
    pub expiry: String,
    pub days_left: i64,
    pub open_qty: u32,
    pub multiplier: u32,
    pub avg_credit: f64,
    pub opened_at: String,
    /// Latest stored chain mark per share; `None` when the contract has no
    /// usable quote. Never recomputed from bid/ask at read time.
    pub mark: Option<f64>,
    /// `fresh` / `delayed` / `stale` / `missing`, from the chain snapshot.
    pub chain_status: String,
    pub chain_fetched_at: Option<String>,
    /// Cost to buy the short back at `mark`; not a market value like stocks.
    pub close_cost: Option<f64>,
    pub unrealized_pnl: Option<f64>,
    /// P&L divided by the net credit received, so 100% means the whole
    /// premium would be kept.
    pub unrealized_pct: Option<f64>,
    /// P&L divided by the strike collateral; Put positions only.
    pub collateral_return_pct: Option<f64>,
}

/// Valuation of one open short option against its stored chain quote.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct OptionValuation {
    pub mark: Option<f64>,
    pub close_cost: Option<f64>,
    pub unrealized_pnl: Option<f64>,
    pub unrealized_pct: Option<f64>,
    pub collateral_return_pct: Option<f64>,
}

/// Only contracts that have not reached expiry are valued. An expired but
/// unsettled position keeps its last pre-expiry quote in the table, which must
/// not be mistaken for a live price.
pub fn option_valuation(
    position: &OptionPosition,
    quote: Option<&OptionQuote>,
    today: Date,
) -> OptionValuation {
    if position.contract.expiry < today {
        return OptionValuation::default();
    }
    let Some(mark) = quote.and_then(|quote| quote.mark) else {
        return OptionValuation::default();
    };
    let shares = f64::from(position.contract.multiplier) * f64::from(position.open_qty);
    let credit = position.avg_credit_per_share * shares;
    let close_cost = mark * shares;
    let unrealized_pnl = credit - close_cost;
    let unrealized_pct = (credit > 0.0).then(|| unrealized_pnl / credit);
    let collateral = position.contract.strike * shares;
    let collateral_return_pct = (position.contract.right == Right::Put && collateral > 0.0)
        .then(|| unrealized_pnl / collateral);
    OptionValuation {
        mark: Some(mark),
        close_cost: Some(close_cost),
        unrealized_pnl: Some(unrealized_pnl),
        unrealized_pct,
        collateral_return_pct,
    }
}

pub fn apply_valuation(
    view: &mut PositionView,
    valuation: &OptionValuation,
    chain_status: String,
    chain_fetched_at: Option<String>,
) {
    view.mark = valuation.mark;
    view.close_cost = valuation.close_cost;
    view.unrealized_pnl = valuation.unrealized_pnl;
    view.unrealized_pct = valuation.unrealized_pct;
    view.collateral_return_pct = valuation.collateral_return_pct;
    view.chain_status = chain_status;
    view.chain_fetched_at = chain_fetched_at;
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LotView {
    pub id: String,
    pub symbol: String,
    pub opened_at: String,
    pub qty: u32,
    pub remaining_qty: u32,
    pub cost_per_share: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CampaignDetailView {
    pub campaign: CampaignCardView,
    pub entries: Vec<EntryView>,
    pub positions: Vec<PositionView>,
    pub lots: Vec<LotView>,
    pub events: Vec<EventView>,
    pub call_scenarios: Vec<CallScenario>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallScenario {
    pub contract: String,
    pub qty: u32,
    pub shares_sold: u32,
    pub strike: f64,
    pub assignment_fees: f64,
    pub sale_proceeds: f64,
    pub share_pnl: f64,
    pub premium_realized: f64,
    pub dividends: f64,
    pub adjustments: f64,
    pub realized_total: f64,
    pub remaining_shares: u32,
    pub remaining_contracts: u32,
    pub closes_campaign: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerView {
    pub entries: Vec<EntryView>,
    pub total_net: f64,
    pub total_collateral: f64,
    pub count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthlyIncomeView {
    pub months: Vec<MonthIncomeView>,
    pub total: MonthIncomeTotalView,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthIncomeView {
    /// `YYYY-MM`, ordered ascending and including only months with activity.
    pub month: String,
    pub premium: f64,
    pub dividends: f64,
    pub fees: f64,
    pub adjustments: f64,
    pub total: f64,
    pub cumulative: f64,
    pub closed_entries: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthIncomeTotalView {
    pub premium: f64,
    pub dividends: f64,
    pub fees: f64,
    pub adjustments: f64,
    pub total: f64,
    pub closed_entries: u32,
    pub month_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnualReportView {
    /// Years with at least one realized/income event, ascending.
    pub available_years: Vec<i32>,
    pub years: Vec<AnnualYearView>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnualYearView {
    pub year: i32,
    /// Only months with activity, ascending and with the year's cumulative.
    pub months: Vec<AnnualMonthView>,
    /// Descending by absolute total.
    pub symbols: Vec<AnnualSymbolView>,
    pub total: AnnualTotalView,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnualMonthView {
    /// `YYYY-MM`.
    pub month: String,
    pub premium: f64,
    pub share_pnl: f64,
    pub dividends: f64,
    pub fees: f64,
    pub adjustments: f64,
    pub total: f64,
    pub cumulative: f64,
    pub closed_entries: u32,
    pub share_events: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnualSymbolView {
    pub symbol: String,
    pub premium: f64,
    pub share_pnl: f64,
    pub dividends: f64,
    pub fees: f64,
    pub adjustments: f64,
    pub total: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnualTotalView {
    pub premium: f64,
    pub share_pnl: f64,
    pub dividends: f64,
    pub fees: f64,
    pub adjustments: f64,
    pub total: f64,
    pub closed_entries: u32,
    pub share_events: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceView {
    pub symbol: String,
    pub date: String,
    pub close: f64,
    pub source: String,
    pub quoted_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolMatch {
    pub symbol: String,
    pub name: String,
    pub exchange: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketQuote {
    pub symbol: String,
    pub name: String,
    pub price: f64,
    pub previous_close: Option<f64>,
    pub change_percent: Option<f64>,
    pub quoted_at: String,
    pub source: String,
    pub currency: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteFailure {
    pub symbol: String,
    pub error: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshQuotesView {
    pub updated: Vec<PriceView>,
    pub failed: Vec<QuoteFailure>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfoView {
    pub version: String,
    pub db_path: String,
}

pub fn campaign_card(
    campaign: &Campaign,
    state: &DerivedState,
    price: Option<f64>,
    today: Date,
) -> CampaignCardView {
    let cost_b = campaign.cost_b(state.settings.include_dividends_in_cost);
    let safety_margin = match (price, cost_b) {
        (Some(price), Some(cost_b)) if cost_b.abs() > f64::EPSILON => {
            Some((price - cost_b) / cost_b)
        }
        _ => None,
    };

    let next_option = state
        .positions_for(&campaign.id)
        .into_iter()
        .min_by_key(|position| position.contract.expiry)
        .map(|position| option_summary(position, today));

    CampaignCardView {
        id: campaign.id.clone(),
        symbol: campaign.symbol.clone(),
        status: campaign.status.as_str().to_string(),
        shares: campaign.shares,
        cost_a: campaign.cost_a(),
        cost_b,
        cost_c: campaign.cost_c(state.settings.include_dividends_in_cost),
        premium_realized: campaign.premium_realized,
        premium_open: campaign.premium_open,
        dividends: campaign.dividends,
        adjustments: campaign.adjustments,
        price,
        safety_margin,
        next_option,
        realized_pnl: campaign.realized_pnl,
        share_pnl: campaign.share_pnl,
        started_at: date_str(campaign.started_at),
        ended_at: campaign.ended_at.map(date_str),
        cycles: campaign.cycles,
        cost_points: campaign.cost_points.iter().map(cost_point).collect(),
    }
}

pub fn cost_point(point: &CostPoint) -> CostPointView {
    CostPointView {
        at: date_str(point.at),
        shares: point.shares,
        premium_realized: point.premium_realized,
        premium_open: point.premium_open,
        cost_a: point.cost_a,
        cost_b: point.cost_b,
        cost_c: point.cost_c,
    }
}

pub fn option_summary(position: &OptionPosition, today: Date) -> OptionSummaryView {
    OptionSummaryView {
        contract: position.contract.display(),
        right: position.contract.right.as_str().to_string(),
        strike: position.contract.strike,
        expiry: date_str(position.contract.expiry),
        days_left: (position.contract.expiry - today).whole_days(),
        open_qty: position.open_qty,
        multiplier: position.contract.multiplier,
        avg_credit: position.avg_credit_per_share,
    }
}

pub fn entry(entry: &PremiumEntry) -> EntryView {
    EntryView {
        id: entry.id.clone(),
        campaign_id: entry.campaign_id.clone(),
        symbol: entry.contract.underlying.clone(),
        contract: entry.contract.display(),
        right: entry.contract.right.as_str().to_string(),
        multiplier: entry.contract.multiplier,
        qty: entry.qty,
        open_qty: entry.open_qty,
        opened_at: date_str(entry.opened_at),
        closed_at: entry.closed_at.map(date_str),
        status: entry.status.as_str().to_string(),
        premium_gross: entry.premium_gross_per_share
            * f64::from(entry.qty)
            * f64::from(entry.contract.multiplier),
        fees: entry.fees,
        close_cost: entry.close_cost,
        net_premium: entry.net_premium,
        collateral: entry.collateral,
        days_held: entry.days_held(),
        annualized_return: entry.annualized_return(),
    }
}

pub fn position(position: &OptionPosition, today: Date) -> PositionView {
    PositionView {
        campaign_id: position.campaign_id.clone(),
        symbol: position.contract.underlying.clone(),
        contract: position.contract.display(),
        right: position.contract.right.as_str().to_string(),
        strike: position.contract.strike,
        expiry: date_str(position.contract.expiry),
        days_left: (position.contract.expiry - today).whole_days(),
        open_qty: position.open_qty,
        multiplier: position.contract.multiplier,
        avg_credit: position.avg_credit_per_share,
        opened_at: date_str(position.opened_at),
        mark: None,
        chain_status: "missing".to_string(),
        chain_fetched_at: None,
        close_cost: None,
        unrealized_pnl: None,
        unrealized_pct: None,
        collateral_return_pct: None,
    }
}

pub fn lot(lot: &ShareLot) -> LotView {
    LotView {
        id: lot.id.clone(),
        symbol: lot.symbol.clone(),
        opened_at: date_str(lot.opened_at),
        qty: lot.qty,
        remaining_qty: lot.remaining_qty,
        cost_per_share: lot.cost_per_share,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventView {
    pub id: String,
    pub account_id: String,
    pub seq: u64,
    pub date: String,
    pub kind: String,
    pub symbol: String,
    pub qty: u32,
    pub price: f64,
    pub fees: f64,
    pub amount: f64,
    pub expiry: Option<String>,
    pub strike: Option<f64>,
    pub right: Option<String>,
    pub multiplier: Option<u32>,
    pub split_numerator: Option<u32>,
    pub split_denominator: Option<u32>,
    pub split_cash_in_lieu: Option<f64>,
    pub note: String,
}

pub fn event_view(event: Event) -> EventView {
    EventView {
        expiry: event.contract.as_ref().map(|c| c.expiry.to_string()),
        strike: event.contract.as_ref().map(|c| c.strike),
        right: event
            .contract
            .as_ref()
            .map(|c| c.right.as_str().to_string()),
        multiplier: event.contract.as_ref().map(|c| c.multiplier),
        split_numerator: event.split.map(|terms| terms.numerator),
        split_denominator: event.split.map(|terms| terms.denominator),
        split_cash_in_lieu: event.split.and_then(|terms| terms.cash_in_lieu),
        date: event.occurred_at.to_string(),
        kind: crate::store::kind_to_str(event.kind).to_string(),
        id: event.id,
        account_id: event.account_id,
        seq: event.seq,
        symbol: event.symbol,
        qty: event.qty,
        price: event.price,
        fees: event.fees,
        amount: event.amount,
        note: event.note,
    }
}

// ---------------------------------------------------------------------------
// Option-chain views
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainStatusView {
    pub symbol: String,
    pub source: String,
    pub as_of: String,
    pub fetched_at: String,
    pub underlying: Option<f64>,
    pub quote_count: i64,
    pub status: String,
    pub notes: String,
}

pub fn chain_status(
    snapshot: Option<&ChainSnapshot>,
    quote_count: i64,
    now: OffsetDateTime,
) -> ChainStatusView {
    let Some(snapshot) = snapshot else {
        return ChainStatusView {
            symbol: String::new(),
            source: String::new(),
            as_of: String::new(),
            fetched_at: String::new(),
            underlying: None,
            quote_count: 0,
            status: "missing".to_string(),
            notes: String::new(),
        };
    };
    let status = chain_freshness(&snapshot.fetched_at, now);
    ChainStatusView {
        symbol: snapshot.symbol.clone(),
        source: snapshot.source.clone(),
        as_of: snapshot.as_of.clone(),
        fetched_at: snapshot.fetched_at.clone(),
        underlying: snapshot.underlying,
        quote_count,
        status,
        notes: snapshot.notes.clone(),
    }
}

/// `fresh` ≤ 15 min, `delayed` ≤ 24 h, otherwise `stale`. Exposed so the
/// scanner can warn per row without re-reading the whole status view.
pub fn chain_freshness(fetched_at: &str, now: OffsetDateTime) -> String {
    let Ok(fetched) = PrimitiveDateTime::parse(
        fetched_at,
        format_description!("[year]-[month]-[day] [hour]:[minute]:[second]"),
    ) else {
        return "stale".to_string();
    };
    let age = now - fetched.assume_utc();
    if age.whole_minutes() <= 15 {
        "fresh".to_string()
    } else if age.whole_hours() <= 24 {
        "delayed".to_string()
    } else {
        "stale".to_string()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainQuoteView {
    pub expiry: String,
    pub strike: f64,
    pub right: String,
    pub bid: Option<f64>,
    pub ask: Option<f64>,
    pub last: Option<f64>,
    pub mark: Option<f64>,
    pub iv: Option<f64>,
    pub open_interest: Option<i64>,
    pub volume: Option<i64>,
}

pub fn chain_quote(quote: &ParsedQuote) -> ChainQuoteView {
    ChainQuoteView {
        expiry: date_str(quote.expiry),
        strike: quote.strike,
        right: quote.right.as_str().to_string(),
        bid: quote.bid,
        ask: quote.ask,
        last: quote.last,
        mark: quote.mark(),
        iv: quote.iv,
        open_interest: quote.open_interest,
        volume: quote.volume,
    }
}

/// A stored quote as read back from SQLite, including option-chain Greeks that
/// may have been filled in after import.
pub fn chain_quote_row(quote: &OptionQuote) -> ChainQuoteView {
    ChainQuoteView {
        expiry: date_str(quote.expiry),
        strike: quote.strike,
        right: quote.right.as_str().to_string(),
        bid: quote.bid,
        ask: quote.ask,
        last: quote.last,
        mark: quote.mark,
        iv: quote.iv,
        open_interest: quote.open_interest,
        volume: quote.volume,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainRowErrorView {
    pub line: usize,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainImportPreviewView {
    pub headers: Vec<String>,
    pub delimiter: String,
    pub rows: Vec<ChainQuoteView>,
    pub errors: Vec<ChainRowErrorView>,
    pub valid: usize,
    pub invalid: usize,
}

pub fn chain_import_preview(outcome: ParseOutcome) -> ChainImportPreviewView {
    let valid = outcome.rows.len();
    let invalid = outcome.errors.len();
    ChainImportPreviewView {
        headers: outcome.headers,
        delimiter: outcome.delimiter.to_string(),
        rows: outcome.rows.iter().map(chain_quote).collect(),
        errors: outcome
            .errors
            .iter()
            .map(|error| ChainRowErrorView {
                line: error.line,
                message: error.message.clone(),
            })
            .collect(),
        valid,
        invalid,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::date;
    use wheel_core::OptionContract;

    fn position(
        strike: f64,
        right: Right,
        multiplier: u32,
        qty: u32,
        credit: f64,
        expiry: Date,
    ) -> OptionPosition {
        let mut contract = OptionContract::new("AAPL", expiry, strike, right);
        contract.multiplier = multiplier;
        OptionPosition {
            campaign_id: "campaign".to_string(),
            contract,
            open_qty: qty,
            avg_credit_per_share: credit,
            opened_at: date!(2026 - 01 - 02),
            open_event: "open".to_string(),
        }
    }

    fn quote(expiry: Date, strike: f64, right: Right, mark: Option<f64>) -> OptionQuote {
        OptionQuote {
            symbol: "AAPL".to_string(),
            expiry,
            strike,
            right,
            bid: None,
            ask: None,
            last: None,
            mark,
            iv: None,
            delta: None,
            gamma: None,
            theta: None,
            vega: None,
            open_interest: None,
            volume: None,
            multiplier: 100,
        }
    }

    #[test]
    fn short_option_profit_and_loss_follow_the_mark() {
        let today = date!(2026 - 11 - 23);
        let expiry = date!(2026 - 12 - 18);
        let put = position(50.0, Right::Put, 100, 2, 2.0, expiry);

        let profit = option_valuation(
            &put,
            Some(&quote(expiry, 50.0, Right::Put, Some(0.5))),
            today,
        );
        assert_eq!(profit.mark, Some(0.5));
        assert_eq!(profit.close_cost, Some(100.0));
        assert_eq!(profit.unrealized_pnl, Some(300.0));
        assert!((profit.unrealized_pct.unwrap() - 0.75).abs() < 1e-9);
        assert!((profit.collateral_return_pct.unwrap() - 0.03).abs() < 1e-9);

        let loss = option_valuation(
            &put,
            Some(&quote(expiry, 50.0, Right::Put, Some(3.0))),
            today,
        );
        assert_eq!(loss.unrealized_pnl, Some(-200.0));
        assert!((loss.unrealized_pct.unwrap() + 0.5).abs() < 1e-9);
    }

    #[test]
    fn missing_or_expired_quotes_are_unpriced() {
        let today = date!(2026 - 11 - 23);
        let expiry = date!(2026 - 12 - 18);
        let call = position(160.0, Right::Call, 100, 1, 3.0, expiry);

        assert_eq!(
            option_valuation(&call, None, today),
            OptionValuation::default()
        );
        assert_eq!(
            option_valuation(&call, Some(&quote(expiry, 160.0, Right::Call, None)), today),
            OptionValuation::default()
        );

        let expired = date!(2026 - 10 - 17);
        let stale = position(160.0, Right::Call, 100, 1, 3.0, expired);
        assert_eq!(
            option_valuation(
                &stale,
                Some(&quote(expired, 160.0, Right::Call, Some(1.0))),
                today
            ),
            OptionValuation::default()
        );
    }

    #[test]
    fn split_adjusted_contract_uses_position_multiplier() {
        let today = date!(2026 - 11 - 23);
        let expiry = date!(2026 - 12 - 18);
        // A 2:1 split halves the credit and strike but doubles the multiplier.
        let put = position(75.0, Right::Put, 200, 1, 1.0, expiry);
        let valuation = option_valuation(
            &put,
            Some(&quote(expiry, 75.0, Right::Put, Some(0.25))),
            today,
        );
        assert_eq!(valuation.close_cost, Some(50.0));
        assert_eq!(valuation.unrealized_pnl, Some(150.0));
        assert!((valuation.unrealized_pct.unwrap() - 0.75).abs() < 1e-9);
    }

    #[test]
    fn calls_do_not_report_collateral_return() {
        let today = date!(2026 - 11 - 23);
        let expiry = date!(2026 - 12 - 18);
        let call = position(160.0, Right::Call, 100, 1, 3.0, expiry);
        let valuation = option_valuation(
            &call,
            Some(&quote(expiry, 160.0, Right::Call, Some(1.0))),
            today,
        );
        assert!(valuation.collateral_return_pct.is_none());
        assert_eq!(valuation.unrealized_pnl, Some(200.0));
    }
}
