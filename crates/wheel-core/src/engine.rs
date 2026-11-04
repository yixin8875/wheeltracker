//! Deterministic replay: events in, derived state out. The same event stream
//! always produces the same campaigns, positions, ledger lines and cost points,
//! which is what makes full rebuilds safe.

use std::collections::{HashMap, HashSet};
use std::fmt;

use time::Date;

use crate::campaign::{Campaign, CampaignStatus, CostPoint};
use crate::model::{Event, EventId, EventKind, OptionAction, OptionContract, Right, SplitTerms};
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

#[derive(Debug, Clone, PartialEq)]
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
    MissingSplitTerms {
        event: EventId,
    },
    InvalidSplitTerms {
        event: EventId,
    },
    NonIntegralOptionAdjustment {
        event: EventId,
        contract: String,
        numerator: u32,
        denominator: u32,
    },
    FractionalSplitNeedsCashInLieu {
        event: EventId,
        symbol: String,
        exact_shares: f64,
    },
    UnexpectedCashInLieu {
        event: EventId,
    },
    SplitOverflow {
        event: EventId,
    },
    AdjustedContractRequired {
        event: EventId,
        contract: String,
    },
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EngineError::MissingContract { .. } => {
                write!(f, "这笔期权交易缺少合约信息（到期日、行权价或方向）。")
            }
            EngineError::InvalidQuantity { .. } => {
                write!(f, "交易数量必须大于 0。")
            }
            EngineError::DuplicateEventId { id } => write!(f, "交易编号重复：{id}。"),
            EngineError::NoOpenPosition { contract, .. } => {
                write!(f, "合约 {contract} 当前没有未平仓持仓，无法平仓或指派。")
            }
            EngineError::InsufficientOpenQty {
                contract,
                have,
                need,
                ..
            } => write!(
                f,
                "合约 {contract} 当前只有 {have} 手未平仓，本次需要 {need} 手。"
            ),
            EngineError::InsufficientShares {
                symbol,
                have,
                need,
                ..
            } => write!(
                f,
                "股票 {symbol} 当前只有 {have} 股，本次需要 {need} 股。"
            ),
            EngineError::NoActiveCampaign { symbol, .. } => {
                write!(f, "{symbol} 当前没有进行中的战役，无法记录这笔交易。")
            }
            EngineError::MissingSplitTerms { .. } => {
                write!(f, "拆股交易缺少拆股比例。")
            }
            EngineError::InvalidSplitTerms { .. } => {
                write!(f, "拆股比例无效：分子与分母必须为正整数。")
            }
            EngineError::NonIntegralOptionAdjustment {
                contract,
                numerator,
                denominator,
                ..
            } => write!(
                f,
                "按 {numerator}:{denominator} 拆股后，合约 {contract} 的每手股数不是整数，无法自动调整；请手动录入调整后的合约。"
            ),
            EngineError::FractionalSplitNeedsCashInLieu {
                symbol,
                exact_shares,
                ..
            } => write!(
                f,
                "拆股后产生 {exact_shares} 股 {symbol} 零股，请填写券商的零股现金补偿金额（没有补偿可填 0）。"
            ),
            EngineError::UnexpectedCashInLieu { .. } => write!(
                f,
                "本次拆股没有产生零股，不能填写零股现金补偿。"
            ),
            EngineError::SplitOverflow { .. } => {
                write!(f, "拆股后的股数超出支持范围。")
            }
            EngineError::AdjustedContractRequired { contract, .. } => write!(
                f,
                "合约 {contract} 是拆股前的旧合约，请使用调整后的行权价和每手股数录入。"
            ),
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
    /// Campaign actually affected by each successfully replayed event.
    pub event_campaigns: HashMap<EventId, String>,
    /// Dividend amount realized by each dividend event. The event only stores a
    /// per-share rate; when quantity is omitted the engine resolves it against
    /// the holding at that point, so reports must use this amount rather than
    /// re-multiplying the rate.
    pub event_dividends: HashMap<EventId, f64>,
    /// Realized share-leg P&L attributed to each sale, call assignment, or
    /// cash-in-lieu event. The sum per campaign equals `Campaign.share_pnl`.
    pub event_share_pnl: HashMap<EventId, f64>,
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
            let share_pnl_sum: f64 = self
                .event_share_pnl
                .iter()
                .filter(|(event_id, _)| self.event_campaigns.get(*event_id) == Some(&c.id))
                .map(|(_, pnl)| *pnl)
                .sum();
            if (share_pnl_sum - c.share_pnl).abs() > eps {
                issues.push(format!(
                    "campaign {} share_pnl mismatch: events={share_pnl_sum}, state={}",
                    c.id, c.share_pnl
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
    event_campaigns: HashMap<EventId, String>,
    event_dividends: HashMap<EventId, f64>,
    event_share_pnl: HashMap<EventId, f64>,
    /// Pre-split contract id -> current adjusted contract. Used so a later
    /// close/expire/assign that still references the old contract resolves to
    /// the adjusted open position.
    split_aliases: HashMap<String, OptionContract>,
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
            event_campaigns: HashMap::new(),
            event_dividends: HashMap::new(),
            event_share_pnl: HashMap::new(),
            split_aliases: HashMap::new(),
        }
    }

    fn apply(&mut self, event: &Event) -> Result<(), EngineError> {
        if !self.seen_ids.insert(event.id.clone()) {
            return Err(EngineError::DuplicateEventId {
                id: event.id.clone(),
            });
        }
        let before = self.active_campaign_idx(&event.symbol);
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
            EventKind::Split => self.split(event),
        }?;
        if let Some(idx) = before.or_else(|| self.active_campaign_idx(&event.symbol)) {
            self.event_campaigns
                .insert(event.id.clone(), self.campaigns[idx].id.clone());
        }
        Ok(())
    }

    fn open_short(&mut self, event: &Event) -> Result<(), EngineError> {
        let contract = event.contract.clone().ok_or(EngineError::MissingContract {
            event: event.id.clone(),
        })?;
        if self.canonical_contract(&contract).id() != contract.id() {
            return Err(EngineError::AdjustedContractRequired {
                event: event.id.clone(),
                contract: contract.display(),
            });
        }
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
        let requested = event.contract.clone().ok_or(EngineError::MissingContract {
            event: event.id.clone(),
        })?;
        let contract = self.canonical_contract(&requested);
        if event.qty == 0 {
            return Err(EngineError::InvalidQuantity {
                event: event.id.clone(),
            });
        }

        let campaign_idx =
            self.campaign_for_contract(&contract)
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
        let requested = event.contract.clone().ok_or(EngineError::MissingContract {
            event: event.id.clone(),
        })?;
        let contract = self.canonical_contract(&requested);
        if event.qty == 0 {
            return Err(EngineError::InvalidQuantity {
                event: event.id.clone(),
            });
        }

        let campaign_idx =
            self.campaign_for_contract(&contract)
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
                self.event_share_pnl
                    .insert(event.id.clone(), proceeds - allocated);
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
        let campaign_idx = self.active_campaign_idx(&event.symbol).ok_or_else(|| {
            EngineError::NoActiveCampaign {
                event: event.id.clone(),
                symbol: event.symbol.clone(),
            }
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
        self.event_share_pnl
            .insert(event.id.clone(), proceeds - allocated);
        self.consume_lots(&campaign_id, event.qty);
        self.record_cost_point(campaign_idx, event.occurred_at);
        self.maybe_close_campaign(campaign_idx, event.occurred_at);
        Ok(())
    }

    fn dividend(&mut self, event: &Event) -> Result<(), EngineError> {
        let campaign_idx = self.active_campaign_idx(&event.symbol).ok_or_else(|| {
            EngineError::NoActiveCampaign {
                event: event.id.clone(),
                symbol: event.symbol.clone(),
            }
        })?;
        let shares = if event.qty > 0 {
            event.qty
        } else {
            self.campaigns[campaign_idx].shares
        };
        let amount = event.price * shares as f64;
        self.campaigns[campaign_idx].dividends += amount;
        self.campaigns[campaign_idx].cash_flow += amount;
        self.event_dividends.insert(event.id.clone(), amount);
        self.record_cost_point(campaign_idx, event.occurred_at);
        Ok(())
    }

    fn split(&mut self, event: &Event) -> Result<(), EngineError> {
        let terms = event.split.ok_or(EngineError::MissingSplitTerms {
            event: event.id.clone(),
        })?;
        if terms.numerator == 0
            || terms.denominator == 0
            || terms.numerator > 1_000_000
            || terms.denominator > 1_000_000
            || terms
                .cash_in_lieu
                .is_some_and(|cash| !cash.is_finite() || cash < 0.0)
        {
            return Err(EngineError::InvalidSplitTerms {
                event: event.id.clone(),
            });
        }
        let Some(campaign_idx) = self.active_campaign_idx(&event.symbol) else {
            // A split far from any position is a harmless historical note.
            return Ok(());
        };
        let campaign_id = self.campaigns[campaign_idx].id.clone();
        let ratio = f64::from(terms.numerator) / f64::from(terms.denominator);

        // Adjust every open contract first, so one non-integral multiplier
        // rejects the whole split before any state changes.
        let mut adjusted: HashMap<String, OptionContract> = HashMap::new();
        for contract in self
            .entries
            .iter()
            .filter(|entry| {
                entry.campaign_id == campaign_id && entry.status.is_open() && entry.open_qty > 0
            })
            .map(|entry| &entry.contract)
            .chain(
                self.positions
                    .iter()
                    .filter(|position| position.campaign_id == campaign_id && position.open_qty > 0)
                    .map(|position| &position.contract),
            )
        {
            let next =
                adjusted_contract(contract, terms).ok_or_else(|| {
                    EngineError::NonIntegralOptionAdjustment {
                        event: event.id.clone(),
                        contract: contract.display(),
                        numerator: terms.numerator,
                        denominator: terms.denominator,
                    }
                })?;
            adjusted.insert(contract.id(), next);
        }

        let exact = f64::from(self.campaigns[campaign_idx].shares) * ratio;
        if !exact.is_finite() || exact > f64::from(u32::MAX) {
            return Err(EngineError::SplitOverflow {
                event: event.id.clone(),
            });
        }
        let new_shares = exact.floor();
        let fractional = exact - new_shares;
        let has_fraction = fractional > 1e-9;
        if has_fraction && terms.cash_in_lieu.is_none() {
            return Err(EngineError::FractionalSplitNeedsCashInLieu {
                event: event.id.clone(),
                symbol: event.symbol.clone(),
                exact_shares: exact,
            });
        }
        if !has_fraction && terms.cash_in_lieu.is_some_and(|cash| cash.abs() > 1e-9) {
            return Err(EngineError::UnexpectedCashInLieu {
                event: event.id.clone(),
            });
        }
        let cash_in_lieu = terms.cash_in_lieu.unwrap_or(0.0);

        let campaign = &mut self.campaigns[campaign_idx];
        let allocated = if has_fraction && exact > 0.0 {
            campaign.cost_total * fractional / exact
        } else {
            0.0
        };
        campaign.shares = new_shares as u32;
        campaign.cost_total -= allocated;
        if campaign.shares == 0 {
            campaign.cost_total = 0.0;
        }
        if has_fraction {
            campaign.cash_flow += cash_in_lieu;
            campaign.share_pnl += cash_in_lieu - allocated;
        }

        for lot in self
            .lots
            .iter_mut()
            .filter(|lot| lot.campaign_id == campaign_id && lot.remaining_qty > 0)
        {
            let old_remaining = f64::from(lot.remaining_qty);
            let new_remaining = (old_remaining * ratio).floor();
            let new_qty = (f64::from(lot.qty) * ratio).floor();
            lot.qty = new_qty as u32;
            lot.remaining_qty = new_remaining as u32;
            lot.cost_per_share = if new_remaining > 0.0 {
                lot.cost_per_share * old_remaining / new_remaining
            } else {
                0.0
            };
        }

        for entry in self.entries.iter_mut().filter(|entry| {
            entry.campaign_id == campaign_id && entry.status.is_open() && entry.open_qty > 0
        }) {
            if let Some(next) = adjusted.get(&entry.contract.id()).cloned() {
                entry.premium_gross_per_share /= ratio;
                entry.credit_per_share /= ratio;
                entry.contract = next;
            }
        }
        for position in self
            .positions
            .iter_mut()
            .filter(|position| position.campaign_id == campaign_id && position.open_qty > 0)
        {
            if let Some(next) = adjusted.get(&position.contract.id()).cloned() {
                position.avg_credit_per_share /= ratio;
                position.contract = next;
            }
        }

        for (old_id, next) in adjusted {
            for alias in self.split_aliases.values_mut() {
                if alias.id() == old_id {
                    *alias = next.clone();
                }
            }
            if next.id() != old_id {
                self.split_aliases.insert(old_id, next);
            }
        }

        if has_fraction {
            self.event_share_pnl
                .insert(event.id.clone(), cash_in_lieu - allocated);
        }
        self.record_cost_point(campaign_idx, event.occurred_at);
        self.maybe_close_campaign(campaign_idx, event.occurred_at);
        Ok(())
    }

    fn adjust_cash(&mut self, event: &Event, delta: f64) -> Result<(), EngineError> {
        let campaign_idx = self.active_campaign_idx(&event.symbol).ok_or_else(|| {
            EngineError::NoActiveCampaign {
                event: event.id.clone(),
                symbol: event.symbol.clone(),
            }
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

    /// Resolve a pre-split contract to the currently adjusted contract.
    /// Exact current contracts have no alias and are returned unchanged.
    fn canonical_contract(&self, contract: &OptionContract) -> OptionContract {
        let mut current = contract.clone();
        let mut seen = HashSet::new();
        while let Some(next) = self.split_aliases.get(&current.id()) {
            if !seen.insert(current.id()) {
                break;
            }
            current = next.clone();
        }
        current
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
            position.avg_credit_per_share = if qty > 0 { weighted / qty as f64 } else { 0.0 };
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
            event_campaigns: self.event_campaigns,
            event_dividends: self.event_dividends,
            event_share_pnl: self.event_share_pnl,
        }
    }
}

/// Apply split terms to one option contract. Returns `None` when the adjusted
/// multiplier would not be a whole number or the strike cannot be represented.
fn adjusted_contract(contract: &OptionContract, terms: SplitTerms) -> Option<OptionContract> {
    let numerator = u64::from(terms.numerator);
    let denominator = u64::from(terms.denominator);
    if numerator == 0 || denominator == 0 {
        return None;
    }
    let scaled = u64::from(contract.multiplier).checked_mul(numerator)?;
    if scaled % denominator != 0 {
        return None;
    }
    let multiplier = u32::try_from(scaled / denominator).ok()?;
    if multiplier == 0 {
        return None;
    }
    let strike = contract.strike * denominator as f64 / numerator as f64;
    if !strike.is_finite() {
        return None;
    }
    // Match OptionContract::id(), which formats the strike to four decimals.
    let strike = (strike * 10_000.0).round() / 10_000.0;
    if strike <= 0.0 {
        return None;
    }
    Some(OptionContract {
        underlying: contract.underlying.clone(),
        expiry: contract.expiry,
        strike,
        right: contract.right,
        multiplier,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::date;

    #[test]
    fn event_campaigns_keep_closing_assignment_and_same_day_reopening_separate() {
        let at = date!(2026 - 01 - 02);
        let call = OptionContract::new("AAPL", date!(2026 - 02 - 20), 110.0, Right::Call);
        let mut events = vec![
            Event::buy_shares("main", "buy", 1, at, "AAPL", 100, 100.0, 0.0),
            Event::sell_option("main", "open", 2, at, call.clone(), 1, 2.0, 0.0),
            Event::dividend("main", "dividend", 3, at, "AAPL", 1.0, 100),
            Event::fee("main", "fee", 4, at, "AAPL", 2.0),
            Event::adjustment("main", "adjustment", 5, at, "AAPL", -3.0),
            Event::assign_option("main", "assignment", 6, at, call.clone(), 1, 0.0),
            Event::buy_shares("main", "reopen", 7, at, "AAPL", 100, 120.0, 0.0),
            Event::sell_option("main", "new-call", 8, at, call.clone(), 1, 2.0, 0.0),
            Event::close_option("main", "close-call", 9, at, call, 1, 1.0, 0.0),
            Event::buy_shares("other", "other-account", 1, at, "AAPL", 100, 1.0, 0.0),
        ];
        // Replay order, rather than the input vector or calendar date alone, owns events.
        events.reverse();
        let state = replay("main", &events, Settings::default()).unwrap();
        assert_eq!(state.event_campaigns.len(), 9);
        for id in ["buy", "open", "dividend", "fee", "adjustment", "assignment"] {
            assert_eq!(state.event_campaigns[id], "main#c0");
        }
        for id in ["reopen", "new-call", "close-call"] {
            assert_eq!(state.event_campaigns[id], "main#c1");
        }
        assert!(!state.campaign("main#c0").unwrap().is_active());
        assert!(state.campaign("main#c1").unwrap().is_active());
        assert!(state.check_invariants().is_empty());
    }

    #[test]
    fn dividend_report_amount_uses_the_holding_when_quantity_is_omitted() {
        let at = date!(2026 - 01 - 02);
        let events = vec![
            Event::buy_shares("main", "buy", 1, at, "AAPL", 100, 100.0, 0.0),
            Event::dividend("main", "div-known", 2, at, "AAPL", 1.0, 100),
            Event::dividend("main", "div-fallback", 3, at, "AAPL", 0.5, 0),
        ];
        let state = replay("main", &events, Settings::default()).unwrap();
        assert_eq!(state.event_dividends["div-known"], 100.0);
        assert_eq!(state.event_dividends["div-fallback"], 50.0);
    }
}
