//! SQLite snapshots: manual backups, daily automatic backups and the safety
//! copy taken before a restore. All snapshots are plain SQLite files created by
//! `VACUUM INTO`, so users can open them with any SQLite tool.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use anyhow::{bail, Context, Result};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use time::format_description::FormatItem;
use time::macros::format_description;
use time::OffsetDateTime;

use crate::{restore, store};

pub const BACKUP_DIR: &str = "backups";
const MANUAL_PREFIX: &str = "wheel-";
const AUTO_PREFIX: &str = "auto-";
const SAFETY_PREFIX: &str = "pre-restore-";
const REQUIRED_TABLES: [&str; 4] = ["settings", "accounts", "events", "prices"];
const REQUIRED_EVENT_COLUMNS: [&str; 8] = [
    "id",
    "account_id",
    "seq",
    "occurred_at",
    "kind",
    "symbol",
    "qty",
    "price",
];

const LOCAL_STAMP: &[FormatItem<'static>] =
    format_description!("[year]-[month]-[day] [hour]:[minute]:[second]");

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntry {
    pub file_name: String,
    pub kind: String,
    pub size_bytes: u64,
    pub modified_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupValidation {
    pub file_name: String,
    pub valid: bool,
    pub integrity: String,
    pub events: u64,
    pub accounts: u64,
    pub prices: u64,
    pub issues: Vec<String>,
}

pub fn dir_for(db_path: &Path) -> Result<PathBuf> {
    let parent = db_path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("database directory is unavailable"))?;
    Ok(parent.join(BACKUP_DIR))
}

/// Only plain file names inside the backup directory are accepted, so a
/// restore request can never escape it with separators or `..`.
pub fn is_safe_file_name(file_name: &str) -> bool {
    !file_name.is_empty()
        && file_name.len() <= 200
        && file_name.ends_with(".sqlite")
        && !file_name.contains('/')
        && !file_name.contains('\\')
        && !file_name.contains("..")
        && file_name != "."
        && file_name != ".."
        && !file_name.contains(':')
}

fn kind_for(file_name: &str) -> &'static str {
    if file_name.starts_with(SAFETY_PREFIX) {
        "safety"
    } else if file_name.starts_with(AUTO_PREFIX) {
        "auto"
    } else if file_name.starts_with(MANUAL_PREFIX) {
        "manual"
    } else {
        "unknown"
    }
}

fn snapshot_timestamp(time: SystemTime) -> String {
    // The `time` crate's local-offset feature is not enabled so the build stays
    // offline-safe; the UI labels this value as UTC rather than guessing.
    let snapshot = OffsetDateTime::from(time);
    snapshot
        .format(LOCAL_STAMP)
        .unwrap_or_else(|_| snapshot.to_string())
}

pub fn list(directory: &Path) -> Result<Vec<BackupEntry>> {
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut backups = Vec::new();
    for entry in std::fs::read_dir(directory)
        .with_context(|| format!("cannot read backup directory {}", directory.display()))?
    {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if !file_type.is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if !file_name.ends_with(".sqlite") || !is_safe_file_name(&file_name) {
            continue;
        }
        let metadata = entry.metadata()?;
        backups.push(BackupEntry {
            kind: kind_for(&file_name).to_string(),
            modified_at: metadata.modified().ok().map(snapshot_timestamp),
            size_bytes: metadata.len(),
            file_name,
        });
    }
    backups.sort_by(|left, right| {
        right
            .modified_at
            .cmp(&left.modified_at)
            .then_with(|| right.file_name.cmp(&left.file_name))
    });
    Ok(backups)
}

/// Create a uniquely named snapshot. The prefix determines how the list
/// classifies it; `stamp` is unix nanoseconds and also keeps names sortable.
pub fn create(conn: &Connection, directory: &Path, prefix: &str, stamp: i128) -> Result<PathBuf> {
    if !matches!(prefix, MANUAL_PREFIX | AUTO_PREFIX | SAFETY_PREFIX) {
        bail!("unsupported backup prefix `{prefix}`");
    }
    std::fs::create_dir_all(directory)
        .with_context(|| format!("cannot create backup directory {}", directory.display()))?;
    static NEXT_BACKUP: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let suffix = NEXT_BACKUP.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let path = directory.join(format!("{prefix}{stamp}-{suffix}.sqlite"));
    store::backup_to(conn, &path)?;
    Ok(path)
}

pub fn validate(directory: &Path, file_name: &str) -> Result<BackupValidation> {
    if !is_safe_file_name(file_name) {
        bail!("无效的备份文件名");
    }
    let path = directory.join(file_name);
    if !path.is_file() {
        bail!("备份文件不存在");
    }
    let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .with_context(|| format!("cannot open backup {}", path.display()))?;
    let mut issues = Vec::new();
    let integrity: String = match conn.query_row("PRAGMA integrity_check", [], |row| row.get(0)) {
        Ok(value) => value,
        Err(error) => {
            issues.push(format!("完整性检查失败：{error}"));
            String::new()
        }
    };
    if !integrity.is_empty() && integrity != "ok" {
        issues.push(format!("SQLite 完整性检查返回 {integrity}"));
    }
    for table in REQUIRED_TABLES {
        let exists: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |row| row.get::<_, i64>(0).map(|count| count > 0),
            )
            .unwrap_or(false);
        if !exists {
            issues.push(format!("缺少数据表 {table}"));
        }
    }
    if !issues.iter().any(|issue| issue.contains("events")) {
        let mut statement = conn.prepare("PRAGMA table_info(events)")?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for column in REQUIRED_EVENT_COLUMNS {
            if !columns.iter().any(|name| name == column) {
                issues.push(format!("事件表缺少列 {column}"));
            }
        }
    }
    let count = |table: &str| -> u64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap_or(0)
        .max(0) as u64
    };
    let valid = issues.is_empty() && integrity == "ok";
    let (events, accounts, prices) = if valid {
        (count("events"), count("accounts"), count("prices"))
    } else {
        (0, 0, 0)
    };
    Ok(BackupValidation {
        file_name: file_name.to_string(),
        valid,
        integrity,
        events,
        accounts,
        prices,
        issues,
    })
}

fn auto_stamp(file_name: &str) -> Option<i128> {
    let stem = file_name
        .strip_prefix(AUTO_PREFIX)?
        .strip_suffix(".sqlite")?;
    let (stamp, suffix) = stem.split_once('-')?;
    if suffix.is_empty() || !suffix.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    stamp.parse::<i128>().ok()
}

/// Delete only automatic snapshots beyond `keep`, newest first. Manual and
/// safety snapshots, unreadable names, directories and links are untouched.
pub fn prune_auto(directory: &Path, keep: u32) -> Result<usize> {
    let keep = keep.max(1) as usize;
    let mut automatic: Vec<(i128, PathBuf)> = Vec::new();
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if let Some(stamp) = auto_stamp(&file_name) {
            automatic.push((stamp, entry.path()));
        }
    }
    automatic.sort_by_key(|left| std::cmp::Reverse(left.0));
    let mut removed = 0;
    for (_, path) in automatic.into_iter().skip(keep) {
        std::fs::remove_file(&path)
            .with_context(|| format!("cannot remove old backup {}", path.display()))?;
        removed += 1;
    }
    Ok(removed)
}

/// Run at most one automatic backup per UTC day. A pending restore suppresses
/// the snapshot so the about-to-be-replaced database is not kept as "today's".
pub fn run_if_due(
    conn: &Connection,
    db_path: &Path,
    today: &str,
    stamp: i128,
) -> Result<Option<PathBuf>> {
    let preferences = store::get_preferences(conn)?;
    if !preferences.auto_backup_enabled {
        return Ok(None);
    }
    if store::get_last_auto_backup_day(conn)?.as_deref() == Some(today) {
        return Ok(None);
    }
    let directory = dir_for(db_path)?;
    let data_dir = directory.parent().unwrap_or(Path::new("."));
    if restore::is_pending(data_dir)? {
        return Ok(None);
    }
    let path = create(conn, &directory, AUTO_PREFIX, stamp)?;
    store::set_last_auto_backup_day(conn, today)?;
    if let Err(error) = prune_auto(&directory, preferences.auto_backup_keep) {
        // A successful snapshot must not be rolled back just because retention
        // cleanup failed; the next run tries again.
        eprintln!("automatic backup cleanup failed: {error:#}");
    }
    Ok(Some(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "wheel-backup-{label}-{}-{}",
            std::process::id(),
            OffsetDateTime::now_utc().unix_timestamp_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn conn_at(directory: &Path) -> Connection {
        store::open(&directory.join("wheel.db")).unwrap()
    }

    #[test]
    fn list_classifies_only_plain_sqlite_files() {
        let directory = temp_dir("list");
        std::fs::write(directory.join("wheel-1.sqlite"), b"x").unwrap();
        std::fs::write(directory.join("auto-2.sqlite"), b"x").unwrap();
        std::fs::write(directory.join("pre-restore-3.sqlite"), b"x").unwrap();
        std::fs::write(directory.join("other.sqlite"), b"x").unwrap();
        std::fs::write(directory.join("notes.txt"), b"x").unwrap();
        std::fs::create_dir(directory.join("folder.sqlite")).unwrap();
        let listed = list(&directory).unwrap();
        let kinds: Vec<(String, String)> = listed
            .into_iter()
            .map(|entry| (entry.file_name, entry.kind))
            .collect();
        assert_eq!(kinds.len(), 4);
        assert!(kinds.contains(&("wheel-1.sqlite".into(), "manual".into())));
        assert!(kinds.contains(&("auto-2.sqlite".into(), "auto".into())));
        assert!(kinds.contains(&("pre-restore-3.sqlite".into(), "safety".into())));
        assert!(kinds.contains(&("other.sqlite".into(), "unknown".into())));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn prune_removes_only_old_automatic_snapshots() {
        let directory = temp_dir("prune");
        for stamp in 1..=5 {
            std::fs::write(directory.join(format!("auto-{stamp}-0.sqlite")), b"x").unwrap();
        }
        std::fs::write(directory.join("wheel-1-0.sqlite"), b"x").unwrap();
        std::fs::write(directory.join("pre-restore-1-0.sqlite"), b"x").unwrap();
        std::fs::write(directory.join("auto-not-a-number.sqlite"), b"x").unwrap();
        std::fs::create_dir(directory.join("auto-9-0.sqlite")).unwrap();
        assert_eq!(prune_auto(&directory, 2).unwrap(), 3);
        let remaining: Vec<String> = list(&directory)
            .unwrap()
            .into_iter()
            .map(|entry| entry.file_name)
            .collect();
        assert!(remaining.contains(&"auto-5-0.sqlite".into()));
        assert!(remaining.contains(&"auto-4-0.sqlite".into()));
        assert!(!remaining.contains(&"auto-3-0.sqlite".into()));
        assert!(remaining.contains(&"wheel-1-0.sqlite".into()));
        assert!(remaining.contains(&"pre-restore-1-0.sqlite".into()));
        assert!(remaining.contains(&"auto-not-a-number.sqlite".into()));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn validation_accepts_real_snapshot_and_rejects_bad_inputs() {
        let directory = temp_dir("validate");
        let conn = conn_at(&directory);
        store::ensure_account(&conn, "main", "Test").unwrap();
        store::insert_event(
            &conn,
            &wheel_core::Event::buy_shares(
                "main",
                "buy",
                1,
                store::parse_date("2026-01-02").unwrap(),
                "AAPL",
                100,
                150.0,
                0.0,
            ),
        )
        .unwrap();
        let backups = dir_for(&directory.join("wheel.db")).unwrap();
        let path = create(&conn, &backups, MANUAL_PREFIX, 42).unwrap();
        let file_name = path.file_name().unwrap().to_string_lossy().into_owned();
        let validation = validate(&backups, &file_name).unwrap();
        assert!(validation.valid);
        assert_eq!(validation.integrity, "ok");
        assert_eq!(validation.events, 1);
        assert_eq!(validation.accounts, 1);
        assert!(validation.issues.is_empty());

        for name in [
            "../wheel-1.sqlite",
            "sub/wheel-1.sqlite",
            "sub\\wheel-1.sqlite",
            "wheel-1.txt",
            "",
        ] {
            assert!(validate(&backups, name).is_err());
        }
        assert!(validate(&backups, "missing.sqlite").is_err());

        std::fs::write(backups.join("wheel-corrupt.sqlite"), b"not a database").unwrap();
        let validation = validate(&backups, "wheel-corrupt.sqlite").unwrap();
        assert!(!validation.valid);
        assert!(!validation.issues.is_empty());

        let empty = Connection::open(backups.join("wheel-empty.sqlite")).unwrap();
        empty.execute_batch("CREATE TABLE unrelated (id TEXT);").unwrap();
        drop(empty);
        let validation = validate(&backups, "wheel-empty.sqlite").unwrap();
        assert!(!validation.valid);
        assert!(validation.issues.iter().any(|issue| issue.contains("settings")));
        drop(conn);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn automatic_backup_runs_once_per_day_and_updates_retention() {
        let directory = temp_dir("schedule");
        let conn = conn_at(&directory);
        store::set_preferences(
            &conn,
            store::Preferences {
                reminder_lead_days: 7,
                auto_backup_enabled: true,
                auto_backup_keep: 2,
            },
        )
        .unwrap();
        let db_path = directory.join("wheel.db");
        assert!(run_if_due(&conn, &db_path, "2026-01-02", 100)
            .unwrap()
            .is_some());
        assert!(run_if_due(&conn, &db_path, "2026-01-02", 101)
            .unwrap()
            .is_none());
        assert!(run_if_due(&conn, &db_path, "2026-01-03", 102)
            .unwrap()
            .is_some());
        assert!(run_if_due(&conn, &db_path, "2026-01-04", 103)
            .unwrap()
            .is_some());
        let automatic = list(&dir_for(&db_path).unwrap())
            .unwrap()
            .into_iter()
            .filter(|entry| entry.kind == "auto")
            .count();
        assert_eq!(automatic, 2);
        store::set_preferences(
            &conn,
            store::Preferences {
                auto_backup_enabled: false,
                ..store::get_preferences(&conn).unwrap()
            },
        )
        .unwrap();
        assert!(run_if_due(&conn, &db_path, "2026-01-05", 104)
            .unwrap()
            .is_none());
        drop(conn);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
