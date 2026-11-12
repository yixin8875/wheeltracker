//! DTOs sent to the frontend. Field names are camelCase over IPC.

use serde::Serialize;
use time::Date;
use wheel_core::{
    Campaign, CostPoint, DerivedState, Event, OptionPosition, PremiumEntry, Right, ShareLot,
};

fn date_str(date: Date) -> String {
    date.to_string()
}

pub fn summary(derived: &DerivedState) -> SummaryView {
    let open_contracts = derived.positions.iter().map(|position| position.open_qty).sum();
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
    let cash_coverage = (cash_tracked && collateral > 0.0).then(|| derived.account_cash / collateral);
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
