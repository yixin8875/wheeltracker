//! # wheel-store
//!
//! Persistence and presentation layer shared by the desktop and mobile shells:
//! the SQLite event log, camelCase IPC views, market quote storage, portable
//! backups and crash-safe restore.
//!
//! This crate never depends on Tauri. Shells own their connection, app data
//! directory and credential storage; everything below that line lives here so
//! both clients replay the same ledger with the same code.

pub mod backup;
pub mod crypto;
pub mod events;
pub mod market;
pub mod restore;
pub mod store;
pub mod views;
