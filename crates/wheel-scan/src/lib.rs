//! # wheel-scan
//!
//! Read-only scenario analysis for underwater stock positions. The scanner
//! never writes anything: it appends hypothetical option events to an in-memory
//! copy of the ledger, replays them through [`wheel_core`], and reports what the
//! campaign would look like afterwards. Because the projection uses the same
//! engine as the real ledger, a scanned number and the post-trade number are the
//! same number.
//!
//! The crate has no network, database or Tauri dependency so the Android client
//! can reuse it unchanged.

#![forbid(unsafe_code)]

pub mod pricing;
pub mod projection;
pub mod strategy;

pub use strategy::{
    scan, AssignmentOutcome, CampaignSummary, Candidate, ChainQuote, Flag, Preset, PriceSource,
    ScanError, ScanFilters, ScanInput, ScanOutcome, ScanSettings, Side, StrategyKind, StrategyLeg,
    StressScenario,
};
