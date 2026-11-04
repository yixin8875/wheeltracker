//! Derived records: one ledger line per option lot, current short positions,
//! and share lots created by assignments or manual buys.

use time::Date;

use crate::model::{OptionContract, Right};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EntryStatus {
    Open,
    Closed,
    Expired,
    Assigned,
}

impl EntryStatus {
    pub fn is_open(self) -> bool {
        matches!(self, EntryStatus::Open)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            EntryStatus::Open => "open",
            EntryStatus::Closed => "closed",
            EntryStatus::Expired => "expired",
            EntryStatus::Assigned => "assigned",
        }
    }
}

/// One premium ledger line. A partial close splits the original line into a
/// closed line and a smaller open line, so every row has a single status.
#[derive(Debug, Clone, PartialEq)]
pub struct PremiumEntry {
    pub id: String,
    pub campaign_id: String,
    pub contract: OptionContract,
    /// Quantity this ledger line covers (original quantity at creation).
    pub qty: u32,
    /// Quantity still open on this line.
    pub open_qty: u32,
    pub opened_at: Date,
    pub closed_at: Option<Date>,
    pub status: EntryStatus,
    pub premium_gross_per_share: f64,
    pub fees: f64,
    /// Net credit per share (open fees included).
    pub credit_per_share: f64,
    pub close_cost: f64,
    /// Open lines: remaining credit. Closed lines: realized net premium.
    pub net_premium: f64,
    pub collateral: f64,
    pub open_event: String,
    pub close_event: Option<String>,
}

impl PremiumEntry {
    pub fn is_put(&self) -> bool {
        self.contract.right == Right::Put
    }

    pub fn days_held(&self) -> Option<i64> {
        self.closed_at
            .map(|closed| (closed - self.opened_at).whole_days())
    }

    pub fn annualized_return(&self) -> Option<f64> {
        if self.status.is_open() || self.collateral <= 0.0 {
            return None;
        }
        let days = self.days_held()?.max(1) as f64;
        Some(self.net_premium / self.collateral * 365.0 / days)
    }
}

/// A currently short option position, aggregated per contract.
#[derive(Debug, Clone, PartialEq)]
pub struct OptionPosition {
    pub campaign_id: String,
    pub contract: OptionContract,
    pub open_qty: u32,
    pub avg_credit_per_share: f64,
    pub opened_at: Date,
    pub open_event: String,
}

/// Shares acquired by assignment or manual purchase.
#[derive(Debug, Clone, PartialEq)]
pub struct ShareLot {
    pub id: String,
    pub campaign_id: String,
    pub symbol: String,
    pub opened_at: Date,
    pub qty: u32,
    pub remaining_qty: u32,
    pub cost_per_share: f64,
    pub origin_event: String,
}
