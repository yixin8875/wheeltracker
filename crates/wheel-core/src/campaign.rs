//! A campaign is one continuous run of a wheel on a single symbol: it opens the
//! first time the symbol is non-flat and closes when both shares and short
//! options are gone. Premiums belong to the campaign they were earned in, which
//! keeps cost basis from drifting across unrelated entries.

use time::Date;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CampaignStatus {
    Active,
    Closed,
}

impl CampaignStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            CampaignStatus::Active => "active",
            CampaignStatus::Closed => "closed",
        }
    }
}

/// A point on the step chart. Cost changes only on events, so one point per
/// event date (coalesced) is enough to draw the whole history.
#[derive(Debug, Clone, PartialEq)]
pub struct CostPoint {
    pub at: Date,
    pub shares: u32,
    pub cost_total: f64,
    pub premium_realized: f64,
    pub premium_open: f64,
    pub dividends: f64,
    pub cost_a: f64,
    pub cost_b: f64,
    pub cost_c: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Campaign {
    pub id: String,
    pub account_id: String,
    pub symbol: String,
    pub started_at: Date,
    pub ended_at: Option<Date>,
    pub status: CampaignStatus,
    pub shares: u32,
    /// Total cost of the shares currently held, in dollars (fees included).
    pub cost_total: f64,
    /// Net premium from closed / expired / assigned options.
    pub premium_realized: f64,
    /// Net premium from options still open.
    pub premium_open: f64,
    pub dividends: f64,
    /// Signed manual corrections.
    pub adjustments: f64,
    /// Net cash flow of every event in this campaign. For a closed campaign
    /// this must equal `realized_pnl`, which is checked by the invariants.
    pub cash_flow: f64,
    /// Cumulative realized P&L on the share leg (only filled on sales).
    pub share_pnl: f64,
    /// Whether this campaign ever held shares. A put-only campaign keeps
    /// accumulating premium until assignment; it only ends once shares existed
    /// and the position becomes flat again.
    pub ever_held_shares: bool,
    /// Total campaign P&L, set when the campaign closes.
    pub realized_pnl: Option<f64>,
    /// Number of option opens in this campaign.
    pub cycles: u32,
    pub cost_points: Vec<CostPoint>,
}

impl Campaign {
    pub fn is_active(&self) -> bool {
        self.status == CampaignStatus::Active
    }

    /// Track A: what the broker shows — pure share cost per share.
    pub fn cost_a(&self) -> Option<f64> {
        (self.shares > 0).then(|| self.cost_total / self.shares as f64)
    }

    /// Track B: effective cost per share, net of realized premium.
    pub fn cost_b(&self, include_dividends: bool) -> Option<f64> {
        let dividends = if include_dividends {
            self.dividends
        } else {
            0.0
        };
        self.cost_a()
            .map(|_| (self.cost_total - self.premium_realized - dividends) / self.shares as f64)
    }

    /// Track C': theoretical cost including premium from still-open options.
    pub fn cost_c(&self, include_dividends: bool) -> Option<f64> {
        let dividends = if include_dividends {
            self.dividends
        } else {
            0.0
        };
        self.cost_a().map(|_| {
            (self.cost_total - self.premium_realized - self.premium_open - dividends)
                / self.shares as f64
        })
    }

    pub fn days_held(&self, today: Date) -> i64 {
        let end = self.ended_at.unwrap_or(today);
        (end - self.started_at).whole_days()
    }
}
