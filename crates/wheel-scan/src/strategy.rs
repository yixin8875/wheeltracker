//! Candidate generation and scenario metrics for the cost-reduction scanner.
//!
//! A candidate is only a set of legs plus a description. Every number that can
//! be checked against the ledger (cost after expiry, assignment result, remaining
//! shares) is produced by [`crate::projection`], never by a second accounting
//! formula.

use std::fmt;

use serde::{Deserialize, Serialize, Serializer};
use time::Date;
use wheel_core::{replay, Event, OptionContract, Right, Settings};

use crate::pricing;
use crate::projection;

/// Guard against a runaway chain producing a multi-second scan.
pub const DEFAULT_PROJECTION_LIMIT: usize = 40;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScanError {
    /// No usable latest price for the underlying.
    NoPrice,
    /// The campaign no longer holds shares, so there is nothing to repair.
    NoShares,
    /// The campaign id is not in the replayed ledger.
    NoCampaign,
    /// A hypothetical replay failed; the candidate is dropped, not shown.
    Projection(String),
}

impl fmt::Display for ScanError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ScanError::NoPrice => f.write_str("缺少标的最新价格，请先更新行情"),
            ScanError::NoShares => f.write_str("该战役当前没有持股"),
            ScanError::NoCampaign => f.write_str("找不到要扫描的战役"),
            ScanError::Projection(message) => write!(f, "情景投影失败: {message}"),
        }
    }
}

impl std::error::Error for ScanError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    Short,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StrategyKind {
    CoveredCall,
    CashSecuredPut,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PriceSource {
    Bid,
    Mark,
}

/// Presets only change filtering and ordering. There is deliberately no
/// composite score: the table shows the trade-offs instead of hiding them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Preset {
    SteadyIncome,
    Balanced,
    Aggressive,
    AddPosition,
}

impl Preset {
    /// The delta band the UI applies to its sliders when this preset is picked.
    /// The engine uses `ScanSettings::delta_min/delta_max`, so there is a single
    /// effective range at any moment.
    pub fn delta_bounds(self) -> (f64, f64) {
        match self {
            Preset::SteadyIncome => (0.0, 0.20),
            Preset::Balanced => (0.20, 0.30),
            Preset::Aggressive => (0.30, 0.45),
            Preset::AddPosition => (0.15, 0.30),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Preset::SteadyIncome => "steady_income",
            Preset::Balanced => "balanced",
            Preset::Aggressive => "aggressive",
            Preset::AddPosition => "add_position",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Flag {
    /// A covered call struck below the current cost basis.
    LocksLoss,
    /// A put assignment that increases the share count.
    AddsShares,
    /// Selling the put would need more cash than the account shows.
    InsufficientCash,
    /// Some shares are uncovered, or the share count is not a whole lot.
    PartialCoverage,
    /// Delta above 0.60: early-assignment risk.
    DeepItm,
    /// Three days or less from expiry and close to the strike (pin risk).
    NearExpiry,
    /// Open interest or spread outside the configured liquidity floor.
    Illiquid,
    /// The chain snapshot is more than one trading day old.
    ChainStale,
    /// A price had to be estimated instead of quoted.
    EstimatedPrice,
    /// The chain window crosses an ex-dividend date (reserved for v2).
    DividendNear,
}

/// A chain row as the scanner needs it. Deliberately independent of the storage
/// crate so the Android client can feed the engine directly.
#[derive(Debug, Clone)]
pub struct ChainQuote {
    pub expiry: Date,
    pub strike: f64,
    pub right: Right,
    pub bid: Option<f64>,
    pub ask: Option<f64>,
    pub mark: Option<f64>,
    pub iv: Option<f64>,
    pub open_interest: Option<i64>,
    pub volume: Option<i64>,
    pub multiplier: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScanSettings {
    pub dte_min: i64,
    pub dte_max: i64,
    pub delta_min: f64,
    pub delta_max: f64,
    /// Show calls struck below cost basis (locked loss for premium).
    pub allow_locked_loss: bool,
    /// Cash-secured puts are opt-in: assignment doubles down on a losing stock.
    pub allow_puts: bool,
    /// Cap assignment at this multiple of the current share count.
    pub max_shares_multiple: u32,
    /// Extra cash the user is willing to commit, on top of recorded cash.
    pub max_extra_capital: Option<f64>,
    pub fee_per_contract: f64,
    pub price_source: PriceSource,
    pub liquidity_filter: bool,
    pub min_open_interest: i64,
    pub max_spread_pct: f64,
    pub risk_free_rate: f64,
    pub dividend_yield: f64,
    /// Puts must be struck below this fraction of the current price.
    pub put_max_strike_ratio: f64,
    pub preset: Preset,
    pub projection_limit: usize,
}

impl Default for ScanSettings {
    fn default() -> Self {
        Self {
            dte_min: 14,
            dte_max: 45,
            delta_min: 0.15,
            delta_max: 0.35,
            allow_locked_loss: false,
            allow_puts: false,
            max_shares_multiple: 2,
            max_extra_capital: None,
            fee_per_contract: 0.65,
            price_source: PriceSource::Bid,
            liquidity_filter: true,
            min_open_interest: 100,
            max_spread_pct: 0.10,
            risk_free_rate: 0.04,
            dividend_yield: 0.0,
            put_max_strike_ratio: 0.98,
            preset: Preset::Balanced,
            projection_limit: DEFAULT_PROJECTION_LIMIT,
        }
    }
}

/// Everything the scanner needs, already loaded by the caller.
pub struct ScanInput {
    pub account_id: String,
    pub campaign_id: String,
    pub today: Date,
    pub price: f64,
    pub cash: f64,
    pub cash_tracked: bool,
    /// Shares already committed to open calls (qty × multiplier).
    pub covered_shares: u32,
    pub chain_stale: bool,
    pub events: Vec<Event>,
    pub ledger_settings: Settings,
    pub quotes: Vec<ChainQuote>,
    pub settings: ScanSettings,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CampaignSummary {
    pub id: String,
    pub symbol: String,
    pub shares: u32,
    pub cost_a: Option<f64>,
    pub cost_b: Option<f64>,
    pub cost_c: Option<f64>,
    pub price: f64,
    pub unrealized_pnl: Option<f64>,
    pub unrealized_pct: Option<f64>,
    pub premium_realized: f64,
    pub covered_shares: u32,
    pub free_shares: u32,
    pub cash: f64,
    pub cash_tracked: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StrategyLeg {
    pub side: Side,
    #[serde(serialize_with = "serialize_date")]
    pub expiry: Date,
    pub strike: f64,
    #[serde(serialize_with = "serialize_right")]
    pub right: Right,
    pub qty: u32,
    /// Per-share credit used for sizing (bid, or mid when configured).
    pub price: f64,
    pub price_source: PriceSource,
    pub multiplier: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssignmentOutcome {
    pub shares_after: u32,
    pub shares_change: i64,
    pub cost_b_after: Option<f64>,
    /// Campaign total after the assignment, including the new premium.
    pub realized_pnl: f64,
    /// Positive magnitude when the assignment realizes a loss.
    pub locked_loss: f64,
    pub remaining_shares: u32,
    pub remaining_cost_b: Option<f64>,
    pub closes_campaign: bool,
    /// Call assignment only.
    pub sale_proceeds: f64,
    /// Put assignment only.
    pub capital_added: f64,
}

/// One price scenario after a put assignment, compared with doing nothing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StressScenario {
    pub price: f64,
    /// Economic P&L including the share position at `price`.
    pub pnl: f64,
    /// The same P&L if the put had not been sold.
    pub baseline_pnl: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub id: String,
    pub kind: StrategyKind,
    pub legs: Vec<StrategyLeg>,
    /// Credit after fees, in dollars.
    pub premium_total: f64,
    pub fees: f64,
    /// Cost B after the option expires worthless.
    pub cost_b_after: Option<f64>,
    /// Cost C' immediately after opening (credit still open).
    pub cost_c_after: Option<f64>,
    pub cost_reduction_per_share: f64,
    pub breakeven: Option<f64>,
    pub annualized: f64,
    pub prob_itm: Option<f64>,
    pub delta: Option<f64>,
    /// Calls only: room to the strike as a fraction of the current price.
    pub upside_cap: Option<f64>,
    /// Cash required by a put (strike × multiplier × qty); zero for calls.
    pub capital: f64,
    pub assignment: Option<AssignmentOutcome>,
    pub stress: Vec<StressScenario>,
    pub flags: Vec<Flag>,
}

/// Why quotes were skipped, in the order the scanner applies its filters. The
/// desktop UI shows these counts when a scan returns nothing, so an empty
/// result is explainable instead of looking like a broken chain.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanFilters {
    pub total_quotes: usize,
    pub invalid_quotes: usize,
    pub outside_dte: usize,
    pub calls_disabled: usize,
    pub puts_disabled: usize,
    pub missing_price: usize,
    pub illiquid: usize,
    pub outside_delta: usize,
    pub below_cost: usize,
    pub put_strike_too_high: usize,
    pub no_quantity: usize,
    pub no_premium: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanOutcome {
    pub campaign: CampaignSummary,
    pub chain_stale: bool,
    /// Quotes inside the expiry window that were considered.
    pub scanned_quotes: usize,
    /// Candidates dropped because a hypothetical replay failed.
    pub dropped: usize,
    pub filters: ScanFilters,
    pub candidates: Vec<Candidate>,
}

pub fn scan(input: &ScanInput) -> Result<ScanOutcome, ScanError> {
    if !(input.price.is_finite() && input.price > 0.0) {
        return Err(ScanError::NoPrice);
    }
    let state = replay(&input.account_id, &input.events, input.ledger_settings)
        .map_err(|error| ScanError::Projection(error.to_string()))?;
    let campaign = state
        .campaign(&input.campaign_id)
        .ok_or(ScanError::NoCampaign)?;
    if campaign.shares == 0 {
        return Err(ScanError::NoShares);
    }

    let settings = input.settings;
    let include_dividends = input.ledger_settings.include_dividends_in_cost;
    let cost_b = campaign.cost_b(include_dividends);
    let cost_a = campaign.cost_a();
    let cost_c = campaign.cost_c(include_dividends);
    let covered_shares = input.covered_shares.min(campaign.shares);
    let free_shares = campaign.shares - covered_shares;
    let dividends_in_cost = if include_dividends {
        campaign.dividends
    } else {
        0.0
    };
    let allow_locked = settings.allow_locked_loss || settings.preset == Preset::Aggressive;
    let allow_calls = settings.preset != Preset::AddPosition;
    let allow_puts = settings.allow_puts && input.cash_tracked;

    let context = Context {
        symbol: &campaign.symbol,
        base_seq: input
            .events
            .iter()
            .map(|event| event.seq)
            .max()
            .unwrap_or(0)
            + 1,
        shares: campaign.shares,
        cost_total: campaign.cost_total,
        cost_b,
        premium_realized: campaign.premium_realized,
        dividends: campaign.dividends,
        adjustments: campaign.adjustments,
    };

    let mut provisional = Vec::new();
    let mut scanned_quotes = 0usize;
    let mut filters = ScanFilters {
        total_quotes: input.quotes.len(),
        ..ScanFilters::default()
    };
    for quote in &input.quotes {
        if !quote.strike.is_finite() || quote.strike <= 0.0 || quote.multiplier == 0 {
            filters.invalid_quotes += 1;
            continue;
        }
        let dte = (quote.expiry - input.today).whole_days();
        if dte < settings.dte_min || dte > settings.dte_max {
            filters.outside_dte += 1;
            continue;
        }
        let is_call = quote.right == Right::Call;
        if is_call && !allow_calls {
            filters.calls_disabled += 1;
            continue;
        }
        if !is_call && !allow_puts {
            filters.puts_disabled += 1;
            continue;
        }
        scanned_quotes += 1;

        let Some(per_share) = pick_price(quote, settings.price_source) else {
            filters.missing_price += 1;
            continue;
        };
        let liquid_quote = liquid(quote, &settings);
        if settings.liquidity_filter && !liquid_quote {
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
                settings.risk_free_rate,
                settings.dividend_yield,
                quote.right,
            )
        });
        let delta = vol.and_then(|vol| {
            pricing::delta(
                input.price,
                quote.strike,
                years,
                settings.risk_free_rate,
                settings.dividend_yield,
                vol,
                quote.right,
            )
        });
        // Without Greeks, OTM distance stands in for delta only in filtering;
        // it is never displayed as a probability.
        let filter_delta = delta
            .map(f64::abs)
            .unwrap_or_else(|| otm_distance(input.price, quote.strike, quote.right));
        if filter_delta < settings.delta_min || filter_delta > settings.delta_max {
            filters.outside_delta += 1;
            continue;
        }
        let prob_itm = vol.and_then(|vol| {
            pricing::prob_itm(
                input.price,
                quote.strike,
                years,
                settings.risk_free_rate,
                settings.dividend_yield,
                vol,
                quote.right,
            )
        });

        if is_call {
            if let (Some(basis), false) = (cost_b, allow_locked) {
                if quote.strike + 1e-9 < basis {
                    filters.below_cost += 1;
                    continue;
                }
            }
        } else if quote.strike > input.price * settings.put_max_strike_ratio + 1e-9 {
            filters.put_strike_too_high += 1;
            continue;
        }

        let qty = if is_call {
            free_shares / quote.multiplier
        } else {
            put_quantity(
                input,
                &settings,
                campaign.shares,
                quote.strike,
                quote.multiplier,
            )
        };
        if qty == 0 {
            filters.no_quantity += 1;
            continue;
        }

        let fees = settings.fee_per_contract * f64::from(qty);
        let premium_total = per_share * f64::from(quote.multiplier) * f64::from(qty) - fees;
        if !(premium_total.is_finite() && premium_total > 0.0) {
            filters.no_premium += 1;
            continue;
        }

        let strike_capital = quote.strike * f64::from(quote.multiplier) * f64::from(qty);
        let annualized = if strike_capital > 0.0 && dte > 0 {
            premium_total / strike_capital * 365.0 / dte as f64
        } else {
            0.0
        };

        let cost_after_expire =
            (campaign.cost_total - campaign.premium_realized - premium_total - dividends_in_cost)
                / f64::from(campaign.shares);
        let cost_immediate = (campaign.cost_total
            - campaign.premium_realized
            - campaign.premium_open
            - premium_total
            - dividends_in_cost)
            / f64::from(campaign.shares);
        let reduction = cost_b.map(|basis| basis - cost_after_expire).unwrap_or(0.0);

        let mut flags = Vec::new();
        if input.chain_stale {
            flags.push(Flag::ChainStale);
        }
        if !liquid_quote {
            flags.push(Flag::Illiquid);
        }
        if campaign.shares % quote.multiplier != 0 || covered_shares > 0 {
            flags.push(Flag::PartialCoverage);
        }
        if is_call {
            if cost_b.is_some_and(|basis| quote.strike < basis) {
                flags.push(Flag::LocksLoss);
            }
        } else if strike_capital > input.cash {
            flags.push(Flag::InsufficientCash);
        }
        if delta.is_some_and(|delta| delta.abs() > 0.60) {
            flags.push(Flag::DeepItm);
        }
        if dte <= 3 && ((quote.strike - input.price) / input.price).abs() <= 0.02 {
            flags.push(Flag::NearExpiry);
        }

        let kind = if is_call {
            StrategyKind::CoveredCall
        } else {
            StrategyKind::CashSecuredPut
        };
        let id = format!(
            "{}|{}|{}",
            if is_call { "cc" } else { "csp" },
            quote.expiry,
            format_strike(quote.strike)
        );
        provisional.push(Candidate {
            id,
            kind,
            legs: vec![StrategyLeg {
                side: Side::Short,
                expiry: quote.expiry,
                strike: quote.strike,
                right: quote.right,
                qty,
                price: per_share,
                price_source: settings.price_source,
                multiplier: quote.multiplier,
            }],
            premium_total,
            fees,
            cost_b_after: Some(cost_after_expire),
            cost_c_after: Some(cost_immediate),
            cost_reduction_per_share: reduction,
            breakeven: Some(cost_after_expire),
            annualized,
            prob_itm,
            delta,
            upside_cap: is_call.then(|| (quote.strike - input.price) / input.price),
            capital: if is_call { 0.0 } else { strike_capital },
            assignment: None,
            stress: Vec::new(),
            flags,
        });
    }

    sort_candidates(&mut provisional, settings.preset);
    provisional.truncate(settings.projection_limit.max(1));

    let mut dropped = 0usize;
    let mut candidates = Vec::with_capacity(provisional.len());
    for (index, mut candidate) in provisional.into_iter().enumerate() {
        match project_candidate(input, &context, index, &mut candidate) {
            Ok(()) => candidates.push(candidate),
            Err(_) => dropped += 1,
        }
    }
    sort_candidates(&mut candidates, settings.preset);

    Ok(ScanOutcome {
        campaign: CampaignSummary {
            id: campaign.id.clone(),
            symbol: campaign.symbol.clone(),
            shares: campaign.shares,
            cost_a,
            cost_b,
            cost_c,
            price: input.price,
            unrealized_pnl: cost_b.map(|basis| (input.price - basis) * f64::from(campaign.shares)),
            unrealized_pct: cost_b.map(|basis| (input.price - basis) / basis),
            premium_realized: campaign.premium_realized,
            covered_shares,
            free_shares,
            cash: input.cash,
            cash_tracked: input.cash_tracked,
        },
        chain_stale: input.chain_stale,
        scanned_quotes,
        dropped,
        filters,
        candidates,
    })
}

struct Context<'a> {
    symbol: &'a str,
    base_seq: u64,
    shares: u32,
    cost_total: f64,
    cost_b: Option<f64>,
    premium_realized: f64,
    dividends: f64,
    adjustments: f64,
}

fn project_candidate(
    input: &ScanInput,
    context: &Context<'_>,
    index: usize,
    candidate: &mut Candidate,
) -> Result<(), ScanError> {
    let leg = candidate
        .legs
        .first()
        .cloned()
        .ok_or_else(|| ScanError::Projection("候选缺少策略腿".to_string()))?;
    let contract = OptionContract {
        underlying: context.symbol.to_string(),
        expiry: leg.expiry,
        strike: leg.strike,
        right: leg.right,
        multiplier: leg.multiplier,
    };
    let open = Event::sell_option(
        &input.account_id,
        &format!("scan-{index}-open"),
        context.base_seq,
        input.today,
        contract.clone(),
        leg.qty,
        leg.price,
        candidate.fees,
    );
    let expire = Event::expire_option(
        &input.account_id,
        &format!("scan-{index}-expire"),
        context.base_seq + 1,
        leg.expiry,
        contract.clone(),
        leg.qty,
    );
    let assign = Event::assign_option(
        &input.account_id,
        &format!("scan-{index}-assign"),
        context.base_seq + 2,
        leg.expiry,
        contract.clone(),
        leg.qty,
        0.0,
    );

    let opened = projection::run(input, std::slice::from_ref(&open))?;
    let expired = projection::run(input, &[open.clone(), expire])?;
    let assigned = projection::run(input, &[open, assign])?;

    candidate.cost_c_after = opened.cost_c;
    candidate.cost_b_after = expired.cost_b;
    candidate.breakeven = expired.cost_b;
    candidate.cost_reduction_per_share = match (context.cost_b, expired.cost_b) {
        (Some(before), Some(after)) => before - after,
        _ => 0.0,
    };

    let shares_sold = context.shares.saturating_sub(assigned.shares);
    let shares_added = assigned.shares.saturating_sub(context.shares);
    let realized = assigned.realized_total();
    if !realized.is_finite() {
        return Err(ScanError::Projection("投影产生非有限盈亏".to_string()));
    }
    let is_call = leg.right == Right::Call;
    candidate.assignment = Some(AssignmentOutcome {
        shares_after: assigned.shares,
        shares_change: i64::from(assigned.shares) - i64::from(context.shares),
        cost_b_after: assigned.cost_b,
        realized_pnl: realized,
        locked_loss: if realized < 0.0 { -realized } else { 0.0 },
        remaining_shares: assigned.shares,
        remaining_cost_b: assigned.cost_b,
        closes_campaign: assigned.closes,
        sale_proceeds: if is_call {
            leg.strike * f64::from(shares_sold)
        } else {
            0.0
        },
        capital_added: if is_call {
            0.0
        } else {
            leg.strike * f64::from(shares_added)
        },
    });

    if !is_call {
        if assigned.shares > context.shares {
            candidate.flags.push(Flag::AddsShares);
        }
        let baseline = |price: f64| {
            price * f64::from(context.shares) - context.cost_total
                + context.premium_realized
                + context.dividends
                + context.adjustments
        };
        for factor in [0.9, 0.8] {
            let price = input.price * factor;
            let pnl = price * f64::from(assigned.shares) - assigned.cost_total + realized;
            candidate.stress.push(StressScenario {
                price,
                pnl,
                baseline_pnl: baseline(price),
            });
        }
    }

    candidate.flags.sort();
    candidate.flags.dedup();
    Ok(())
}

pub(crate) fn pick_price(quote: &ChainQuote, source: PriceSource) -> Option<f64> {
    let price = match source {
        PriceSource::Bid => quote.bid,
        PriceSource::Mark => quote.mark,
    }?;
    (price.is_finite() && price > 0.0).then_some(price)
}

pub(crate) fn liquid(quote: &ChainQuote, settings: &ScanSettings) -> bool {
    let open_interest_ok = quote
        .open_interest
        .is_some_and(|open_interest| open_interest >= settings.min_open_interest);
    let spread_ok = match (quote.bid, quote.ask) {
        (Some(bid), Some(ask)) if bid > 0.0 && ask >= bid => {
            let mid = 0.5 * (bid + ask);
            (ask - bid) / mid <= settings.max_spread_pct + 1e-9
        }
        _ => false,
    };
    open_interest_ok && spread_ok
}

pub(crate) fn otm_distance(price: f64, strike: f64, right: Right) -> f64 {
    match right {
        Right::Call => (strike - price) / price,
        Right::Put => (price - strike) / price,
    }
}

fn put_quantity(
    input: &ScanInput,
    settings: &ScanSettings,
    shares: u32,
    strike: f64,
    multiplier: u32,
) -> u32 {
    if !input.cash_tracked || input.cash <= 0.0 {
        return 0;
    }
    let per_contract = strike * f64::from(multiplier);
    if per_contract <= 0.0 || multiplier == 0 {
        return 0;
    }
    let capital = settings
        .max_extra_capital
        .map_or(input.cash, |extra| input.cash.min(extra));
    let by_cash = (capital / per_contract).floor().max(0.0);

    // Cap the assignment at a multiple of the existing position so a repair
    // trade cannot silently double the concentration.
    let max_shares = u64::from(shares) * u64::from(settings.max_shares_multiple);
    let by_shares = (max_shares / u64::from(multiplier)) as f64;
    let quantity = by_cash.min(by_shares);
    if !quantity.is_finite() || quantity < 1.0 {
        return 0;
    }
    quantity.min(f64::from(u32::MAX)) as u32
}

/// Ordering only; every displayed number comes from the projection.
fn sort_candidates(candidates: &mut [Candidate], preset: Preset) {
    candidates.sort_by(|left, right| {
        let ordering = match preset {
            Preset::SteadyIncome => right.annualized.total_cmp(&left.annualized),
            Preset::Balanced => right
                .cost_reduction_per_share
                .total_cmp(&left.cost_reduction_per_share),
            Preset::Aggressive => left
                .cost_b_after
                .unwrap_or(f64::MAX)
                .total_cmp(&right.cost_b_after.unwrap_or(f64::MAX)),
            Preset::AddPosition => left
                .assignment
                .as_ref()
                .and_then(|assignment| assignment.cost_b_after)
                .or(left.cost_b_after)
                .unwrap_or(f64::MAX)
                .total_cmp(
                    &right
                        .assignment
                        .as_ref()
                        .and_then(|assignment| assignment.cost_b_after)
                        .or(right.cost_b_after)
                        .unwrap_or(f64::MAX),
                ),
        };
        ordering.then_with(|| left.id.cmp(&right.id))
    });
}

fn format_strike(strike: f64) -> String {
    if (strike.fract()).abs() < f64::EPSILON {
        format!("{strike:.0}")
    } else {
        format!("{strike:.2}")
    }
}

fn serialize_date<S: Serializer>(date: &Date, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&date.to_string())
}

fn serialize_right<S: Serializer>(right: &Right, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(right.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::date;

    const TODAY: Date = date!(2026 - 11 - 18);
    const EXPIRY: Date = date!(2026 - 12 - 18);

    fn long_events(shares: u32, price: f64, cash: f64) -> Vec<Event> {
        let mut events = Vec::new();
        if cash > 0.0 {
            events.push(Event::cash_deposit(
                "main",
                "d1",
                1,
                date!(2026 - 01 - 02),
                cash,
            ));
        }
        events.push(Event::buy_shares(
            "main",
            "b1",
            2,
            date!(2026 - 01 - 02),
            "AAPL",
            shares,
            price,
            0.0,
        ));
        events
    }

    fn quote(expiry: Date, strike: f64, right: Right, bid: f64, ask: f64, oi: i64) -> ChainQuote {
        ChainQuote {
            expiry,
            strike,
            right,
            bid: Some(bid),
            ask: Some(ask),
            mark: Some((bid + ask) / 2.0),
            iv: None,
            open_interest: Some(oi),
            volume: Some(500),
            multiplier: 100,
        }
    }

    fn input(
        events: Vec<Event>,
        cash: f64,
        cash_tracked: bool,
        quotes: Vec<ChainQuote>,
        settings: ScanSettings,
    ) -> ScanInput {
        ScanInput {
            account_id: "main".to_string(),
            campaign_id: "main#c0".to_string(),
            today: TODAY,
            price: 150.0,
            cash,
            cash_tracked,
            covered_shares: 0,
            chain_stale: false,
            events,
            ledger_settings: Settings::default(),
            quotes,
            settings,
        }
    }

    #[test]
    fn covered_call_matches_the_ledger_projection() {
        let events = long_events(1000, 200.0, 0.0);
        let scan_input = input(
            events.clone(),
            // no cash is needed for a covered call
            0.0,
            false,
            vec![quote(EXPIRY, 160.0, Right::Call, 3.20, 3.30, 5_000)],
            ScanSettings {
                allow_locked_loss: true,
                delta_min: 0.10,
                delta_max: 0.45,
                ..ScanSettings::default()
            },
        );
        let outcome = scan(&scan_input).unwrap();
        let candidate = outcome
            .candidates
            .iter()
            .find(|candidate| candidate.kind == StrategyKind::CoveredCall)
            .expect("covered call candidate");

        assert_eq!(candidate.legs[0].qty, 10);
        assert!((candidate.legs[0].price - 3.20).abs() < 1e-9);
        assert!((candidate.premium_total - 3_193.5).abs() < 1e-6);
        assert!((candidate.cost_b_after.unwrap() - 196.80).abs() < 0.02);
        assert!((candidate.cost_reduction_per_share - 3.20).abs() < 0.02);

        let assignment = candidate.assignment.as_ref().unwrap();
        assert_eq!(assignment.shares_after, 0);
        assert!(assignment.closes_campaign);
        assert!((assignment.realized_pnl + 36_800.0).abs() < 10.0);
        assert!(candidate.flags.contains(&Flag::LocksLoss));
        assert!(candidate.stress.is_empty());

        // Hypothetical events never touch the caller's stream.
        assert_eq!(scan_input.events.len(), events.len());
    }

    #[test]
    fn cash_secured_put_shows_dilution_and_downside() {
        let events = long_events(500, 200.0, 30_000.0);
        let scan_input = input(
            events,
            30_000.0,
            true,
            vec![quote(EXPIRY, 140.0, Right::Put, 4.00, 4.10, 4_000)],
            ScanSettings {
                allow_puts: true,
                delta_min: 0.10,
                delta_max: 0.45,
                ..ScanSettings::default()
            },
        );
        let outcome = scan(&scan_input).unwrap();
        let candidate = outcome
            .candidates
            .iter()
            .find(|candidate| candidate.kind == StrategyKind::CashSecuredPut)
            .expect("put candidate");

        assert_eq!(candidate.legs[0].qty, 2);
        assert!((candidate.capital - 28_000.0).abs() < 1e-6);
        assert!((candidate.cost_b_after.unwrap() - 198.40).abs() < 0.02);

        let assignment = candidate.assignment.as_ref().unwrap();
        assert_eq!(assignment.shares_after, 700);
        assert_eq!(assignment.shares_change, 200);
        assert!((assignment.capital_added - 28_000.0).abs() < 1e-6);
        assert!((assignment.cost_b_after.unwrap() - 181.71).abs() < 0.02);
        assert!(candidate.flags.contains(&Flag::AddsShares));
        assert_eq!(candidate.stress.len(), 2);

        // T5: at 130 after assignment the position is -36,200; doing nothing
        // would have been -35,000, so the put adds 1,200 of floating loss.
        let net_cost = assignment.cost_b_after.unwrap() * 700.0;
        let pnl = 130.0 * 700.0 - net_cost;
        let baseline = (130.0 - outcome.campaign.cost_b.unwrap()) * 500.0;
        assert!((pnl + 36_200.0).abs() < 5.0);
        assert!((pnl - baseline + 1_200.0).abs() < 5.0);
    }

    #[test]
    fn locked_loss_is_hidden_unless_allowed() {
        let events = long_events(1000, 200.0, 0.0);
        let strict = input(
            events,
            0.0,
            false,
            vec![quote(EXPIRY, 160.0, Right::Call, 3.20, 3.30, 5_000)],
            ScanSettings {
                allow_locked_loss: false,
                preset: Preset::Balanced,
                delta_min: 0.10,
                delta_max: 0.45,
                ..ScanSettings::default()
            },
        );
        let outcome = scan(&strict).unwrap();
        assert!(outcome.candidates.is_empty());
        assert_eq!(outcome.filters.below_cost, 1);
    }

    #[test]
    fn scan_reports_filter_counts_for_an_empty_result() {
        let events = long_events(1000, 200.0, 0.0);
        let quotes = vec![
            quote(date!(2027 - 06 - 18), 160.0, Right::Call, 3.20, 3.30, 5_000),
            quote(EXPIRY, 140.0, Right::Put, 4.00, 4.10, 4_000),
            quote(EXPIRY, 160.0, Right::Call, 1.00, 2.00, 5_000),
            quote(EXPIRY, 160.0, Right::Call, 3.20, 3.30, 5_000),
        ];
        let outcome = scan(&input(
            events,
            0.0,
            false,
            quotes,
            ScanSettings {
                delta_min: 0.10,
                delta_max: 0.45,
                ..ScanSettings::default()
            },
        ))
        .unwrap();

        assert!(outcome.candidates.is_empty());
        assert_eq!(outcome.filters.total_quotes, 4);
        assert_eq!(outcome.filters.outside_dte, 1);
        assert_eq!(outcome.filters.puts_disabled, 1);
        assert_eq!(outcome.filters.illiquid, 1);
        assert_eq!(outcome.filters.below_cost, 1);
    }

    #[test]
    fn scan_counts_quotes_that_cannot_fill_a_contract() {
        let events = long_events(1000, 200.0, 0.0);
        let mut scan_input = input(
            events,
            0.0,
            false,
            vec![quote(EXPIRY, 160.0, Right::Call, 3.20, 3.30, 5_000)],
            ScanSettings {
                allow_locked_loss: true,
                delta_min: 0.10,
                delta_max: 0.45,
                ..ScanSettings::default()
            },
        );
        // Every share is already committed to an open call.
        scan_input.covered_shares = 1000;

        let outcome = scan(&scan_input).unwrap();
        assert!(outcome.candidates.is_empty());
        assert_eq!(outcome.filters.no_quantity, 1);
    }

    #[test]
    fn missing_price_is_rejected() {
        let events = long_events(1000, 200.0, 0.0);
        let mut scan_input = input(
            events,
            0.0,
            false,
            vec![quote(EXPIRY, 160.0, Right::Call, 3.20, 3.30, 5_000)],
            ScanSettings::default(),
        );
        scan_input.price = 0.0;
        assert_eq!(scan(&scan_input).unwrap_err(), ScanError::NoPrice);
    }
}
