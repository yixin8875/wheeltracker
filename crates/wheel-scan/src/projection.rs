//! Exact projection: append hypothetical events to a copy of the ledger and
//! replay it with the accounting engine.
//!
//! Nothing here is persisted. The scanner's numbers are the ledger's numbers
//! because both come out of the same [`wheel_core::replay`].

use wheel_core::{replay, Event};

use crate::strategy::{ScanError, ScanInput};

/// The campaign after a hypothetical set of events.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Projection {
    pub cost_b: Option<f64>,
    pub cost_c: Option<f64>,
    pub shares: u32,
    pub cost_total: f64,
    pub premium_realized: f64,
    pub premium_open: f64,
    pub dividends: f64,
    pub adjustments: f64,
    pub share_pnl: f64,
    pub closes: bool,
}

impl Projection {
    /// Same definition as `call_scenarios`: share P&L plus every premium,
    /// dividend and adjustment the campaign has realized.
    pub fn realized_total(&self) -> f64 {
        self.share_pnl + self.premium_realized + self.dividends + self.adjustments
    }
}

pub(crate) fn run(input: &ScanInput, extra: &[Event]) -> Result<Projection, ScanError> {
    let mut events = Vec::with_capacity(input.events.len() + extra.len());
    events.extend_from_slice(&input.events);
    events.extend_from_slice(extra);
    let state = replay(&input.account_id, &events, input.ledger_settings)
        .map_err(|error| ScanError::Projection(format!("{error}")))?;
    let campaign = state
        .campaign(&input.campaign_id)
        .ok_or(ScanError::NoCampaign)?;
    let include_dividends = input.ledger_settings.include_dividends_in_cost;
    Ok(Projection {
        cost_b: campaign.cost_b(include_dividends),
        cost_c: campaign.cost_c(include_dividends),
        shares: campaign.shares,
        cost_total: campaign.cost_total,
        premium_realized: campaign.premium_realized,
        premium_open: campaign.premium_open,
        dividends: campaign.dividends,
        adjustments: campaign.adjustments,
        share_pnl: campaign.share_pnl,
        closes: !campaign.is_active(),
    })
}
