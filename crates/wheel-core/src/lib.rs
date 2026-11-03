//! # wheel-core
//!
//! Event-sourced accounting engine for the wheel strategy (sell puts, take
//! assignment, sell covered calls). The engine replays immutable events into a
//! deterministic view of campaigns, cost basis and premium ledger, so the whole
//! state can always be rebuilt from scratch.
//!
//! ```
//! use time::macros::date;
//! use wheel_core::{replay, Event, OptionContract, Right, Settings};
//!
//! let contract = OptionContract::new("AAPL", date!(2026 - 02 - 20), 200.0, Right::Put);
//! let events = vec![Event::sell_option(
//!     "main", "e1", 1, date!(2026 - 01 - 05), contract, 1, 5.0, 1.5,
//! )];
//! let state = replay("main", &events, Settings::default()).unwrap();
//! assert_eq!(state.campaigns.len(), 1);
//! assert!((state.campaigns[0].premium_open - 498.5).abs() < 1e-9);
//! ```

#![forbid(unsafe_code)]

pub mod campaign;
pub mod engine;
pub mod model;
pub mod premium;

pub use campaign::{Campaign, CampaignStatus, CostPoint};
pub use engine::{replay, DerivedState, EngineError, Settings};
pub use model::{Event, EventId, EventKind, OptionAction, OptionContract, Right};
pub use premium::{EntryStatus, OptionPosition, PremiumEntry, ShareLot};
