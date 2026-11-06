//! Domain vocabulary: options, contracts and the immutable trade events that
//! are the single source of truth for everything the engine derives.

use std::fmt;

use time::Date;

pub type EventId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Right {
    Put,
    Call,
}

impl Right {
    pub fn as_str(self) -> &'static str {
        match self {
            Right::Put => "P",
            Right::Call => "C",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Right::Put => "Sell Put",
            Right::Call => "Sell Call",
        }
    }
}

impl fmt::Display for Right {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct OptionContract {
    pub underlying: String,
    pub expiry: Date,
    pub strike: f64,
    pub right: Right,
    pub multiplier: u32,
}

impl OptionContract {
    pub fn new(underlying: impl Into<String>, expiry: Date, strike: f64, right: Right) -> Self {
        Self {
            underlying: underlying.into(),
            expiry,
            strike,
            right,
            multiplier: 100,
        }
    }

    /// Stable identity used for grouping positions and ledger entries.
    pub fn id(&self) -> String {
        format!(
            "{}|{}|{:.4}|{}|{}",
            self.underlying,
            self.expiry,
            self.strike,
            self.right.as_str(),
            self.multiplier
        )
    }

    pub fn shares_per_contract(&self) -> u32 {
        self.multiplier
    }

    pub fn display(&self) -> String {
        format!(
            "{} {} {}{}",
            self.underlying,
            self.expiry,
            format_strike(self.strike),
            self.right.as_str()
        )
    }
}

fn format_strike(strike: f64) -> String {
    if (strike.fract()).abs() < f64::EPSILON {
        format!("{strike:.0}")
    } else {
        format!("{strike:.2}")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum OptionAction {
    /// Sell to open (STO).
    OpenShort,
    /// Buy to close (BTC).
    Close,
    /// Expired worthless.
    Expire,
    /// Assigned / exercised.
    Assign,
}

/// Stock split / reverse split terms. New shares are
/// `old_shares * numerator / denominator`; any fraction is compensated in cash
/// and never kept as a fractional position.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SplitTerms {
    pub numerator: u32,
    pub denominator: u32,
    /// Cash received for the fractional share; `None` when the split is exact.
    pub cash_in_lieu: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EventKind {
    Option(OptionAction),
    SharesBuy,
    SharesSell,
    Dividend,
    Fee,
    Adjustment,
    Split,
    /// Cash moved into the account from outside the trading ledger.
    CashDeposit,
    /// Cash moved out of the account to the outside world.
    CashWithdrawal,
}

impl EventKind {
    /// Account-level cash movements have no symbol and belong to no campaign.
    pub fn is_cash_transfer(self) -> bool {
        matches!(self, EventKind::CashDeposit | EventKind::CashWithdrawal)
    }
}

/// An immutable fact. Everything else in the crate is derived from a stream of
/// these, so a full rebuild is always possible.
#[derive(Debug, Clone, PartialEq)]
pub struct Event {
    pub account_id: String,
    pub id: EventId,
    pub seq: u64,
    pub occurred_at: Date,
    pub kind: EventKind,
    pub symbol: String,
    pub contract: Option<OptionContract>,
    /// Option contracts for option events, shares for share events.
    pub qty: u32,
    /// Per-share premium for options, per-share price for shares,
    /// per-share dividend for dividends.
    pub price: f64,
    pub fees: f64,
    /// Signed cash amount for `Fee` / `Adjustment` events.
    pub amount: f64,
    /// Split terms for `EventKind::Split`; `None` for every other kind.
    pub split: Option<SplitTerms>,
    pub note: String,
}

impl Event {
    pub fn new(
        account_id: impl Into<String>,
        id: impl Into<String>,
        seq: u64,
        occurred_at: Date,
        kind: EventKind,
        symbol: impl Into<String>,
    ) -> Self {
        Self {
            account_id: account_id.into(),
            id: id.into(),
            seq,
            occurred_at,
            kind,
            symbol: symbol.into(),
            contract: None,
            qty: 0,
            price: 0.0,
            fees: 0.0,
            amount: 0.0,
            split: None,
            note: String::new(),
        }
    }

    pub fn contract(mut self, contract: OptionContract) -> Self {
        self.contract = Some(contract);
        self
    }

    pub fn qty(mut self, qty: u32) -> Self {
        self.qty = qty;
        self
    }

    pub fn price(mut self, price: f64) -> Self {
        self.price = price;
        self
    }

    pub fn fees(mut self, fees: f64) -> Self {
        self.fees = fees;
        self
    }

    pub fn amount(mut self, amount: f64) -> Self {
        self.amount = amount;
        self
    }

    pub fn note(mut self, note: impl Into<String>) -> Self {
        self.note = note.into();
        self
    }

    /// Sell to open a short option.
    pub fn sell_option(
        account_id: &str,
        id: &str,
        seq: u64,
        at: Date,
        contract: OptionContract,
        qty: u32,
        premium: f64,
        fees: f64,
    ) -> Self {
        let symbol = contract.underlying.clone();
        Self::new(
            account_id,
            id,
            seq,
            at,
            EventKind::Option(OptionAction::OpenShort),
            symbol,
        )
        .contract(contract)
        .qty(qty)
        .price(premium)
        .fees(fees)
    }

    /// Buy to close a short option.
    pub fn close_option(
        account_id: &str,
        id: &str,
        seq: u64,
        at: Date,
        contract: OptionContract,
        qty: u32,
        price: f64,
        fees: f64,
    ) -> Self {
        let symbol = contract.underlying.clone();
        Self::new(
            account_id,
            id,
            seq,
            at,
            EventKind::Option(OptionAction::Close),
            symbol,
        )
        .contract(contract)
        .qty(qty)
        .price(price)
        .fees(fees)
    }

    pub fn expire_option(
        account_id: &str,
        id: &str,
        seq: u64,
        at: Date,
        contract: OptionContract,
        qty: u32,
    ) -> Self {
        let symbol = contract.underlying.clone();
        Self::new(
            account_id,
            id,
            seq,
            at,
            EventKind::Option(OptionAction::Expire),
            symbol,
        )
        .contract(contract)
        .qty(qty)
    }

    pub fn assign_option(
        account_id: &str,
        id: &str,
        seq: u64,
        at: Date,
        contract: OptionContract,
        qty: u32,
        fees: f64,
    ) -> Self {
        let symbol = contract.underlying.clone();
        Self::new(
            account_id,
            id,
            seq,
            at,
            EventKind::Option(OptionAction::Assign),
            symbol,
        )
        .contract(contract)
        .qty(qty)
        .fees(fees)
    }

    pub fn buy_shares(
        account_id: &str,
        id: &str,
        seq: u64,
        at: Date,
        symbol: &str,
        qty: u32,
        price: f64,
        fees: f64,
    ) -> Self {
        Self::new(account_id, id, seq, at, EventKind::SharesBuy, symbol)
            .qty(qty)
            .price(price)
            .fees(fees)
    }

    pub fn sell_shares(
        account_id: &str,
        id: &str,
        seq: u64,
        at: Date,
        symbol: &str,
        qty: u32,
        price: f64,
        fees: f64,
    ) -> Self {
        Self::new(account_id, id, seq, at, EventKind::SharesSell, symbol)
            .qty(qty)
            .price(price)
            .fees(fees)
    }

    pub fn dividend(
        account_id: &str,
        id: &str,
        seq: u64,
        at: Date,
        symbol: &str,
        per_share: f64,
        shares: u32,
    ) -> Self {
        Self::new(account_id, id, seq, at, EventKind::Dividend, symbol)
            .price(per_share)
            .qty(shares)
    }

    pub fn fee(account_id: &str, id: &str, seq: u64, at: Date, symbol: &str, amount: f64) -> Self {
        Self::new(account_id, id, seq, at, EventKind::Fee, symbol).amount(amount)
    }

    pub fn adjustment(
        account_id: &str,
        id: &str,
        seq: u64,
        at: Date,
        symbol: &str,
        amount: f64,
    ) -> Self {
        Self::new(account_id, id, seq, at, EventKind::Adjustment, symbol).amount(amount)
    }

    /// Deposit cash into the account. `amount` is a positive dollar value.
    pub fn cash_deposit(account_id: &str, id: &str, seq: u64, at: Date, amount: f64) -> Self {
        Self::new(account_id, id, seq, at, EventKind::CashDeposit, "").amount(amount)
    }

    /// Withdraw cash from the account. `amount` is a positive dollar value.
    pub fn cash_withdrawal(account_id: &str, id: &str, seq: u64, at: Date, amount: f64) -> Self {
        Self::new(account_id, id, seq, at, EventKind::CashWithdrawal, "").amount(amount)
    }

    /// Apply a stock split or reverse split to every open position of `symbol`.
    pub fn stock_split(
        account_id: &str,
        id: &str,
        seq: u64,
        at: Date,
        symbol: &str,
        numerator: u32,
        denominator: u32,
        cash_in_lieu: Option<f64>,
    ) -> Self {
        let mut event = Self::new(account_id, id, seq, at, EventKind::Split, symbol);
        event.split = Some(SplitTerms {
            numerator,
            denominator,
            cash_in_lieu,
        });
        event
    }
}

impl fmt::Display for Event {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.kind {
            EventKind::Option(action) => {
                let contract = self
                    .contract
                    .as_ref()
                    .map(OptionContract::display)
                    .unwrap_or_else(|| format!("{} <missing contract>", self.symbol));
                write!(
                    f,
                    "{} {:?} {} x{} @{:.2}",
                    self.occurred_at, action, contract, self.qty, self.price
                )
            }
            EventKind::Split => {
                let terms = self.split.unwrap_or(SplitTerms {
                    numerator: 1,
                    denominator: 1,
                    cash_in_lieu: None,
                });
                write!(
                    f,
                    "{} split {} {}:{} cash_in_lieu={:?}",
                    self.occurred_at, self.symbol, terms.numerator, terms.denominator,
                    terms.cash_in_lieu
                )
            }
            EventKind::CashDeposit => {
                write!(f, "{} 入金 {:.2}", self.occurred_at, self.amount)
            }
            EventKind::CashWithdrawal => {
                write!(f, "{} 出金 {:.2}", self.occurred_at, self.amount)
            }
            other => write!(
                f,
                "{} {:?} {} qty={} price={:.2}",
                self.occurred_at, other, self.symbol, self.qty, self.price
            ),
        }
    }
}
