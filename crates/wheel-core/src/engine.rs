//! Deterministic replay: events in, derived state out. The same event stream
//! always produces the same campaigns, positions, ledger lines and cost points,
//! which is what makes full rebuilds safe.

use std::collections::{HashMap, HashSet};
use std::fmt;

use time::Date;

use crate::campaign::{Campaign, CampaignStatus, CostPoint};
use crate::model::{Event, EventId, EventKind, OptionAction, OptionContract, Right};
use crate::premium::{EntryStatus, OptionPosition, PremiumEntry, ShareLot};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Settings {
    /// Whether dividends reduce the cost basis (track B / C').
    pub include_dividends_in_cost: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            include_dividends_in_cost: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineError {
    MissingContract {
        event: EventId,
    },
    InvalidQuantity {
        event: EventId,
    },
    DuplicateEventId {
        id: EventId,
    },
    NoOpenPosition {
        event: EventId,
        contract: String,
    },
    InsufficientOpenQty {
        event: EventId,
        contract: String,
        have: u32,
        need: u32,
    },
    InsufficientShares {
        event: EventId,
        symbol: String,
        have: u32,
        need: u32,
    },
    NoActiveCampaign {
        event: EventId,
        symbol: String,
    },
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EngineError::MissingContract { event } => {
                write!(f, "event {event} is an option event but has no contract")
            }
            EngineError::InvalidQuantity { event } => {
                write!(f, "event {event} has quantity 0")
            }
            EngineError::DuplicateEventId { id } => write!(f, "duplicate event id {id}"),
            EngineError::NoOpenPosition { event, contract } => {
                write!(f, "event {event} references {contract} but no position is open")
            }
            EngineError::InsufficientOpenQty {
                event,
                contract,
                have,
                need,
            } => write!(
                f,
                "event {event} needs {need} contracts of {contract}, only {have} open"
            ),
            EngineError::InsufficientShares {
                event,
                symbol,
                have,
                need,
            } => write!(
                f,
                "event {event} needs {need} shares of {symbol}, only {have} held"
            ),
            EngineError::NoActiveCampaign { event, symbol } => {
                write!(f, "event {event} needs an active campaign for {symbol}")
            }
        }
    }
}

impl std::error::Error for EngineError {}

#[derive(Debug, Clone, PartialEq)]
pub struct DerivedState {
    pub account_id: String,
    pub settings: Settings,
    pub campaigns: Vec<Campaign>,
    pub positions: Vec<OptionPosition>,
    pub lots: Vec<ShareLot>,
    pub premium_entries: Vec<PremiumEntry>,
}

impl DerivedState {
    pub fn campaign(&self, id: &str) -> Option<&Campaign> {
        self.campaigns.iter().find(|c| c.id == id)
    }

    pub fn active_campaign(&self, symbol: &str) -> Option<&Campaign> {
        self.campaigns
            .iter()
            .find(|c| c.symbol == symbol && c.status == CampaignStatus::Active)
    }

    pub fn positions_for(&self, campaign_id: &str) -> Vec<&OptionPosition> {
        self.positions
            .iter()
            .filter(|p| p.campaign_id == campaign_id)
            .collect()
    }

    pub fn entries_for(&self, campaign_id: &str) -> Vec<&PremiumEntry> {
        self.premium_entries
            .iter()
            .filter(|e| e.campaign_id == campaign_id)
            .collect()
    }

    pub fn total_premium_realized(&self) -> f64 {
        self.campaigns.iter().map(|c| c.premium_realized).sum()
    }

    pub fn total_premium_open(&self) -> f64 {
        self.campaigns.iter().map(|c| c.premium_open).sum()
    }

    /// Structural checks that must hold for any valid event stream.
    pub fn check_invariants(&self) -> Vec<String> {
        let mut issues = Vec::new();
        let eps = 1e-6;

        for c in &self.campaigns {
            let open_sum: f64 = self
                .premium_entries
                .iter()
                .filter(|e| e.campaign_id == c.id && e.status.is_open())
                .map(|e| e.net_premium)
                .sum();
            let closed_sum: f64 = self
                .premium_entries
                .iter()
                .filter(|e| e.campaign_id == c.id && !e.status.is_open())
                .map(|e| e.net_premium)
                .sum();

            if (open_sum - c.premium_open).abs() > eps {
                issues.push(format!(
                    "campaign {} premium_open mismatch: entries={open_sum}, state={}",
                    c.id, c.premium_open
                ));
            }
            if (closed_sum - c.premium_realized).abs() > eps {
                issues.push(format!(
                    "campaign {} premium_realized mismatch: entries={closed_sum}, state={}",
                    c.id, c.premium_realized
                ));
            }
            if c.shares == 0 && c.cost_total.abs() > eps {
                issues.push(format!(
                    "campaign {} holds zero shares but cost_total={}",
                    c.id, c.cost_total
                ));
            }
            if c.shares > 0 && c.cost_total < -eps {
                issues.push(format!(
                    "campaign {} has negative share cost {}",
                    c.id, c.cost_total
                ));
            }
            if c.status == CampaignStatus::Closed {
                if c.shares != 0 {
                    issues.push(format!(
                        "closed campaign {} still holds {} shares",
                        c.id, c.shares
                    ));
                }
                if c.ended_at.is_none() {
                    issues.push(format!("closed campaign {} has no end date", c.id));
                }
                if c.realized_pnl.is_none() {
                    issues.push(format!("closed campaign {} has no realized P&L", c.id));
                }
                if let Some(pnl) = c.realized_pnl {
                    if (c.cash_flow - pnl).abs() > eps {
                        issues.push(format!(
                            "campaign {} cash_flow={} does not match realized_pnl={pnl}",
                            c.id, c.cash_flow
                        ));
                    }
                }
            }
        }

        for p in &self.positions {
            if p.open_qty == 0 {
                issues.push(format!(
                    "position {} has zero open quantity",
                    p.contract.display()
                ));
            }
            let entry_qty: u32 = self
                .premium_entries
                .iter()
                .filter(|e| {
                    e.campaign_id == p.campaign_id
                        && e.contract.id() == p.contract.id()
                        && e.status.is_open()
                })
                .map(|e| e.open_qty)
                .sum();
            if entry_qty != p.open_qty {
                issues.push(format!(
                    "position {} open_qty={} but ledger open qty={}",
                    p.contract.display(),
                    p.open_qty,
                    entry_qty
                ));
            }
        }

        for lot in &self.lots {
            if lot.remaining_qty > lot.qty {
                issues.push(format!(
                    "lot {} remaining={} exceeds qty={}",
                    lot.id, lot.remaining_qty, lot.qty
                ));
            }
            if lot.cost_per_share < -eps {
                issues.push(format!(
                    "lot {} has negative cost per share {}",
                    lot.id, lot.cost_per_share
                ));
            }
        }

        issues
    }
}

/// Replay one account's events into derived state.
pub fn replay(
    account_id: &str,
    events: &[Event],
    settings: Settings,
) -> Result<DerivedState, EngineError> {
    let mut selected: Vec<&Event> = events
        .iter()
        .filter(|e| e.account_id == account_id)
        .collect();
    selected.sort_by(|a, b| (a.occurred_at, a.seq).cmp(&(b.occurred_at, b.seq)));

    let mut builder = Builder::new(account_id.to_string(), settings);
    for event in selected {
        builder.apply(event)?;
    }
    Ok(builder.finish())
}

struct Builder {
    account_id: String,
    settings: Settings,
    campaigns: Vec<Campaign>,
    positions: Vec<OptionPosition>,
    lots: Vec<ShareLot>,
    entries: Vec<PremiumEntry>,
    active: HashMap<String, usize>,
    next_campaign_id: u32,
    seen_ids: HashSet<String>,
}

impl Builder {
    fn new(account_id: String, settings: Settings) -> Self {
        Self {
            account_id,
            settings,
            campaigns: Vec::new(),
            positions: Vec::new(),
            lots: Vec::new(),
            entries: Vec::new(),
            active: HashMap::new(),
            next_campaign_id: 0,
            seen_ids: HashSet::new(),
        }
    }

    fn apply(&mut self, event: &Event) -> Result<(), EngineError> {
        if !self.seen_ids.insert(event.id.clone()) {
            return Err(EngineError::DuplicateEventId {
                id: event.id.clone(),
            });
        }
        match event.kind {
            EventKind::Option(OptionAction::OpenShort) => self.open_short(event),
            EventKind::Option(OptionAction::Close) => {
                self.close_position(event, EntryStatus::Closed)
            }
            EventKind::Option(OptionAction::Expire) => {
                self.close_position(event, EntryStatus::Expired)
            }
            EventKind::Option(OptionAction::Assign) => self.assign(event),
            EventKind::SharesBuy => self.shares_buy(event),
            EventKind::SharesSell => self.shares_sell(event),
            EventKind::Dividend => self.dividend(event),
            EventKind::Fee => self.adjust_cash(event, -event.amount),
            EventKind::Adjustment => self.adjust_cash(event, event.amount),
        }
    }

    fn open_short(&mut self, event: &Event) -> Result<(), EngineError> {
        let contract = event
            .contract
            .clone()
            .ok_or(EngineError::MissingContract {
                event: event.id.clone(),
            })?;
        if event.qty == 0 {
            return Err(EngineError::InvalidQuantity {
                event: event.id.clone(),
            });
        }

        let campaign_idx = self.ensure_campaign(&event.symbol, event.occurred_at);
        let campaign_id = self.campaigns[campaign_idx].id.clone();

        let shares = contract.shares_per_contract() as f64 * event.qty as f64;
        let gross = event.price * shares;
        let net = gross - event.fees;
        let credit_per_share = net / shares;

        self.campaigns[campaign_idx].premium_open += net;
        self.campaigns[campaign_idx].cash_flow += net;
        self.campaigns[campaign_idx].cycles += 1;

        let entry_id = format!("{}#{}", event.id, self.entries.len());
        self.entries.push(PremiumEntry {
            id: entry_id,
            campaign_id: campaign_id.clone(),
            contract: contract.clone(),
            qty: event.qty,
            open_qty: event.qty,
            opened_at: event.occurred_at,
            closed_at: None,
            status: EntryStatus::Open,
            premium_gross_per_share: event.price,
            fees: event.fees,
            credit_per_share,
            close_cost: 0.0,
            net_premium: net,
            collateral: contract.strike * shares,
            open_event: event.id.clone(),
            close_event: None,
        });

        self.upsert_position(
            campaign_idx,
            &contract,
            event.qty,
            event.occurred_at,
            &event.id,
        );
        self.record_cost_point(campaign_idx, event.occurred_at);
        Ok(())
    }

    fn close_position(&mut self, event: &Event, status: EntryStatus) -> Result<(), EngineError> {
        let contract = event
            .contract
            .clone()
            .ok_or(EngineError::MissingContract {
                event: event.id.clone(),
            })?;
        if event.qty == 0 {
            return Err(EngineError::InvalidQuantity {
                event: event.id.clone(),
            });
        }

        let campaign_idx = self
            .campaign_for_contract(&contract)
            .ok_or_else(|| EngineError::NoOpenPosition {
                event: event.id.clone(),
                contract: contract.display(),
            })?;
        let campaign_id = self.campaigns[campaign_idx].id.clone();
        let key = contract.id();
        let have = self.open_qty(&campaign_id, &key);
        if have < event.qty {
            return Err(EngineError::InsufficientOpenQty {
                event: event.id.clone(),
                contract: contract.display(),
                have,
                need: event.qty,
            });
        }

        let shares = contract.shares_per_contract() as f64 * event.qty as f64;
        let close_cost_per_share = if status == EntryStatus::Closed {
            event.price + event.fees / shares
        } else {
            0.0
        };

        let (credit, cost) = self.consume_entries(
            &campaign_id,
            &contract,
            event.qty,
            status,
            close_cost_per_share,
            event.occurred_at,
            &event.id,
        );

        self.campaigns[campaign_idx].premium_open -= credit;
        self.campaigns[campaign_idx].premium_realized += credit - cost;
        self.campaigns[campaign_idx].cash_flow -= cost;
        self.sync_position(&campaign_id, &key);
        self.record_cost_point(campaign_idx, event.occurred_at);
        self.maybe_close_campaign(campaign_idx, event.occurred_at);
        Ok(())
    }

    fn assign(&mut self, event: &Event) -> Result<(), EngineError> {
        let contract = event
            .contract
            .clone()
            .ok_or(EngineError::MissingContract {
                event: event.id.clone(),
            })?;
        if event.qty == 0 {
            return Err(EngineError::InvalidQuantity {
                event: event.id.clone(),
            });
        }

        let campaign_idx = self
            .campaign_for_contract(&contract)
            .ok_or_else(|| EngineError::NoOpenPosition {
                event: event.id.clone(),
                contract: contract.display(),
            })?;
        let campaign_id = self.campaigns[campaign_idx].id.clone();
        let key = contract.id();
        let have = self.open_qty(&campaign_id, &key);
        if have < event.qty {
            return Err(EngineError::InsufficientOpenQty {
                event: event.id.clone(),
                contract: contract.display(),
                have,
                need: event.qty,
            });
        }

        let shares_qty = contract.multiplier * event.qty;
        if contract.right == Right::Call {
            let held = self.campaigns[campaign_idx].shares;
            if held < shares_qty {
                return Err(EngineError::InsufficientShares {
                    event: event.id.clone(),
                    symbol: event.symbol.clone(),
                    have: held,
                    need: shares_qty,
                });
            }
        }

        let (credit, _) = self.consume_entries(
            &campaign_id,
            &contract,
            event.qty,
            EntryStatus::Assigned,
            0.0,
            event.occurred_at,
            &event.id,
        );
        self.campaigns[campaign_idx].premium_open -= credit;
        self.campaigns[campaign_idx].premium_realized += credit;

        match contract.right {
            Right::Put => {
                let lot_cost_total = contract.strike * shares_qty as f64 + event.fees;
                let cost_per_share = lot_cost_total / shares_qty as f64;
                {
                    let campaign = &mut self.campaigns[campaign_idx];
                    campaign.shares += shares_qty;
                    campaign.cost_total += lot_cost_total;
                    campaign.ever_held_shares = true;
                    campaign.cash_flow -= contract.strike * shares_qty as f64 + event.fees;
                }
                self.lots.push(ShareLot {
                    id: format!("{}#lot{}", event.id, self.lots.len()),
                    campaign_id: campaign_id.clone(),
                    symbol: event.symbol.clone(),
                    opened_at: event.occurred_at,
                    qty: shares_qty,
                    remaining_qty: shares_qty,
                    cost_per_share,
                    origin_event: event.id.clone(),
                });
            }
            Right::Call => {
                let allocated = {
                    let campaign = &self.campaigns[campaign_idx];
                    campaign.cost_total * (shares_qty as f64 / campaign.shares as f64)
                };
                let proceeds = contract.strike * shares_qty as f64 - event.fees;
                {
                    let campaign = &mut self.campaigns[campaign_idx];
                    campaign.share_pnl += proceeds - allocated;
                    campaign.shares -= shares_qty;
                    campaign.cost_total -= allocated;
                    campaign.cash_flow += proceeds;
                    if campaign.shares == 0 {
                        campaign.cost_total = 0.0;
                    }
                }
                self.consume_lots(&campaign_id, shares_qty);
            }
        }

        self.sync_position(&campaign_id, &key);
        self.record_cost_point(campaign_idx, event.occurred_at);
        self.maybe_close_campaign(campaign_idx, event.occurred_at);
        Ok(())
    }

    fn shares_buy(&mut self, event: &Event) -> Result<(), EngineError> {
        if event.qty == 0 {
            return Err(EngineError::InvalidQuantity {
                event: event.id.clone(),
            });
        }
        let campaign_idx = self.ensure_campaign(&event.symbol, event.occurred_at);
        let campaign_id = self.campaigns[campaign_idx].id.clone();
        let total_cost = event.price * event.qty as f64 + event.fees;
        let cost_per_share = total_cost / event.qty as f64;
        {
            let campaign = &mut self.campaigns[campaign_idx];
            campaign.shares += event.qty;
            campaign.cost_total += total_cost;
            campaign.ever_held_shares = true;
            campaign.cash_flow -= total_cost;
        }
        self.lots.push(ShareLot {
            id: format!("{}#lot{}", event.id, self.lots.len()),
            campaign_id,
            symbol: event.symbol.clone(),
            opened_at: event.occurred_at,
            qty: event.qty,
            remaining_qty: event.qty,
            cost_per_share,
            origin_event: event.id.clone(),
        });
        self.record_cost_point(campaign_idx, event.occurred_at);
        Ok(())
    }

    fn shares_sell(&mut self, event: &Event) -> Result<(), EngineError> {
        if event.qty == 0 {
            return Err(EngineError::InvalidQuantity {
                event: event.id.clone(),
            });
        }
        let campaign_idx =
            self.active_campaign_idx(&event.symbol)
                .ok_or_else(|| EngineError::NoActiveCampaign {
                    event: event.id.clone(),
                    symbol: event.symbol.clone(),
                })?;
        let campaign_id = self.campaigns[campaign_idx].id.clone();
        let held = self.campaigns[campaign_idx].shares;
        if held < event.qty {
            return Err(EngineError::InsufficientShares {
                event: event.id.clone(),
                symbol: event.symbol.clone(),
                have: held,
                need: event.qty,
            });
        }

        let allocated = self.campaigns[campaign_idx].cost_total * (event.qty as f64 / held as f64);
        let proceeds = event.price * event.qty as f64 - event.fees;
        {
            let campaign = &mut self.campaigns[campaign_idx];
            campaign.share_pnl += proceeds - allocated;
            campaign.shares -= event.qty;
            campaign.cost_total -= allocated;
            campaign.cash_flow += proceeds;
            if campaign.shares == 0 {
                campaign.cost_total = 0.0;
            }
        }
        self.consume_lots(&campaign_id, event.qty);
        self.record_cost_point(campaign_idx, event.occurred_at);
        self.maybe_close_campaign(campaign_idx, event.occurred_at);
        Ok(())
    }

    fn dividend(&mut self, event: &Event) -> Result<(), EngineError> {
        let campaign_idx =
            self.active_campaign_idx(&event.symbol)
                .ok_or_else(|| EngineError::NoActiveCampaign {
                    event: event.id.clone(),
                    symbol: event.symbol.clone(),
                })?;
        let shares = if event.qty > 0 {
            event.qty
        } else {
            self.campaigns[campaign_idx].shares
        };
        let amount = event.price * shares as f64;
        self.campaigns[campaign_idx].dividends += amount;
        self.campaigns[campaign_idx].cash_flow += amount;
        self.record_cost_point(campaign_idx, event.occurred_at);
        Ok(())
    }

    fn adjust_cash(&mut self, event: &Event, delta: f64) -> Result<(), EngineError> {
        let campaign_idx =
            self.active_campaign_idx(&event.symbol)
                .ok_or_else(|| EngineError::NoActiveCampaign {
                    event: event.id.clone(),
                    symbol: event.symbol.clone(),
                })?;
        self.campaigns[campaign_idx].adjustments += delta;
        self.campaigns[campaign_idx].cash_flow += delta;
        Ok(())
    }

    fn ensure_campaign(&mut self, symbol: &str, at: Date) -> usize {
        if let Some(&idx) = self.active.get(symbol) {
            return idx;
        }
        let idx = self.campaigns.len();
        let id = format!("{}#c{}", self.account_id, self.next_campaign_id);
        self.next_campaign_id += 1;
        self.campaigns.push(Campaign {
            id,
            account_id: self.account_id.clone(),
            symbol: symbol.to_string(),
            started_at: at,
            ended_at: None,
            status: CampaignStatus::Active,
            shares: 0,
            cost_total: 0.0,
            premium_realized: 0.0,
            premium_open: 0.0,
            dividends: 0.0,
            adjustments: 0.0,
            cash_flow: 0.0,
            share_pnl: 0.0,
            ever_held_shares: false,
            realized_pnl: None,
            cycles: 0,
            cost_points: Vec::new(),
        });
        self.active.insert(symbol.to_string(), idx);
        idx
    }

    fn active_campaign_idx(&self, symbol: &str) -> Option<usize> {
        self.active.get(symbol).copied()
    }

    fn campaign_for_contract(&self, contract: &OptionContract) -> Option<usize> {
        let key = contract.id();
        let campaign_id = self
            .positions
            .iter()
            .find(|p| p.open_qty > 0 && p.contract.id() == key)?
            .campaign_id
            .clone();
        self.campaigns
            .iter()
            .position(|c| c.id == campaign_id && c.status == CampaignStatus::Active)
    }

    fn open_qty(&self, campaign_id: &str, contract_key: &str) -> u32 {
        self.positions
            .iter()
            .find(|p| p.campaign_id == campaign_id && p.contract.id() == contract_key)
            .map(|p| p.open_qty)
            .unwrap_or(0)
    }

    fn upsert_position(
        &mut self,
        campaign_idx: usize,
        contract: &OptionContract,
        add_qty: u32,
        at: Date,
        event_id: &str,
    ) {
        let campaign_id = self.campaigns[campaign_idx].id.clone();
        let key = contract.id();
        if let Some(position) = self
            .positions
            .iter_mut()
            .find(|p| p.campaign_id == campaign_id && p.contract.id() == key)
        {
            position.open_qty += add_qty;
            if at < position.opened_at {
                position.opened_at = at;
            }
        } else {
            self.positions.push(OptionPosition {
                campaign_id: campaign_id.clone(),
                contract: contract.clone(),
                open_qty: add_qty,
                avg_credit_per_share: 0.0,
                opened_at: at,
                open_event: event_id.to_string(),
            });
        }
        self.sync_position(&campaign_id, &key);
    }

    fn sync_position(&mut self, campaign_id: &str, contract_key: &str) {
        let mut qty: u32 = 0;
        let mut weighted = 0.0f64;
        for entry in self.entries.iter().filter(|e| {
            e.status.is_open()
                && e.open_qty > 0
                && e.campaign_id == campaign_id
                && e.contract.id() == contract_key
        }) {
            qty += entry.open_qty;
            weighted += entry.credit_per_share * entry.open_qty as f64;
        }
        if let Some(position) = self
            .positions
            .iter_mut()
            .find(|p| p.campaign_id == campaign_id && p.contract.id() == contract_key)
        {
            position.open_qty = qty;
            position.avg_credit_per_share = if qty > 0 {
                weighted / qty as f64
            } else {
                0.0
            };
        }
        self.positions.retain(|p| p.open_qty > 0);
    }

    /// Consume open ledger lines FIFO and return (credit released, close cost).
    fn consume_entries(
        &mut self,
        campaign_id: &str,
        contract: &OptionContract,
        qty: u32,
        status: EntryStatus,
        close_cost_per_share: f64,
        at: Date,
        event_id: &str,
    ) -> (f64, f64) {
        let key = contract.id();
        let shares_per = contract.shares_per_contract() as f64;
        let mut need = qty;
        let mut total_credit = 0.0;
        let mut total_cost = 0.0;
        let mut i = 0;

        while i < self.entries.len() && need > 0 {
            let matches = {
                let entry = &self.entries[i];
                entry.campaign_id == campaign_id
                    && entry.contract.id() == key
                    && entry.status.is_open()
                    && entry.open_qty > 0
            };
            if !matches {
                i += 1;
                continue;
            }

            let entry_qty = self.entries[i].qty;
            let entry_open = self.entries[i].open_qty;
            let take = need.min(entry_open);
            let credit = self.entries[i].credit_per_share * shares_per * take as f64;
            let cost = close_cost_per_share * shares_per * take as f64;
            let fee_share = self.entries[i].fees * take as f64 / entry_qty.max(1) as f64;

            if take == entry_open {
                let entry = &mut self.entries[i];
                entry.open_qty = 0;
                entry.status = status;
                entry.closed_at = Some(at);
                entry.close_event = Some(event_id.to_string());
                entry.close_cost = cost;
                entry.net_premium = credit - cost;
                entry.fees = fee_share;
            } else {
                {
                    let entry = &mut self.entries[i];
                    entry.qty -= take;
                    entry.open_qty = entry.qty;
                    entry.fees -= fee_share;
                    entry.net_premium = entry.credit_per_share * shares_per * entry.qty as f64;
                }
                let new_id = format!("{}#{}", event_id, self.entries.len());
                let closed = PremiumEntry {
                    id: new_id,
                    campaign_id: campaign_id.to_string(),
                    contract: contract.clone(),
                    qty: take,
                    open_qty: 0,
                    opened_at: self.entries[i].opened_at,
                    closed_at: Some(at),
                    status,
                    premium_gross_per_share: self.entries[i].premium_gross_per_share,
                    fees: fee_share,
                    credit_per_share: self.entries[i].credit_per_share,
                    close_cost: cost,
                    net_premium: credit - cost,
                    collateral: contract.strike * shares_per * take as f64,
                    open_event: self.entries[i].open_event.clone(),
                    close_event: Some(event_id.to_string()),
                };
                self.entries.push(closed);
            }

            total_credit += credit;
            total_cost += cost;
            need -= take;
            i += 1;
        }

        (total_credit, total_cost)
    }

    fn consume_lots(&mut self, campaign_id: &str, mut qty: u32) {
        for lot in self
            .lots
            .iter_mut()
            .filter(|lot| lot.campaign_id == campaign_id && lot.remaining_qty > 0)
        {
            if qty == 0 {
                break;
            }
            let take = qty.min(lot.remaining_qty);
            lot.remaining_qty -= take;
            qty -= take;
        }
    }

    fn record_cost_point(&mut self, campaign_idx: usize, at: Date) {
        {
            // Subtracting equal amounts can leave IEEE-754 negative zero;
            // normalize it so reports never show "-0.00".
            let campaign = &mut self.campaigns[campaign_idx];
            if campaign.premium_open.abs() < 1e-9 {
                campaign.premium_open = 0.0;
            }
            if campaign.premium_realized.abs() < 1e-9 {
                campaign.premium_realized = 0.0;
            }
        }
        let campaign = &self.campaigns[campaign_idx];
        if campaign.shares == 0 {
            return;
        }
        let point = CostPoint {
            at,
            shares: campaign.shares,
            cost_total: campaign.cost_total,
            premium_realized: campaign.premium_realized,
            premium_open: campaign.premium_open,
            dividends: campaign.dividends,
            cost_a: campaign.cost_a().unwrap_or(0.0),
            cost_b: campaign
                .cost_b(self.settings.include_dividends_in_cost)
                .unwrap_or(0.0),
            cost_c: campaign
                .cost_c(self.settings.include_dividends_in_cost)
                .unwrap_or(0.0),
        };
        let points = &mut self.campaigns[campaign_idx].cost_points;
        if let Some(last) = points.last_mut() {
            if last.at == at {
                *last = point;
                return;
            }
        }
        points.push(point);
    }

    fn maybe_close_campaign(&mut self, campaign_idx: usize, at: Date) {
        let campaign_id = self.campaigns[campaign_idx].id.clone();
        let has_open_positions = self
            .positions
            .iter()
            .any(|p| p.campaign_id == campaign_id && p.open_qty > 0);
        let campaign = &mut self.campaigns[campaign_idx];
        if campaign.ever_held_shares
            && campaign.shares == 0
            && !has_open_positions
            && campaign.status == CampaignStatus::Active
        {
            campaign.status = CampaignStatus::Closed;
            campaign.ended_at = Some(at);
            campaign.realized_pnl = Some(
                campaign.share_pnl
                    + campaign.premium_realized
                    + campaign.dividends
                    + campaign.adjustments,
            );
            let symbol = campaign.symbol.clone();
            self.active.remove(&symbol);
        }
    }

    fn finish(self) -> DerivedState {
        DerivedState {
            account_id: self.account_id,
            settings: self.settings,
            campaigns: self.campaigns,
            positions: self.positions,
            lots: self.lots,
            premium_entries: self.entries,
        }
    }
}
