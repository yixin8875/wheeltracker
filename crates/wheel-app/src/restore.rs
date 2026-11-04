//! Crash-safe restore. A staged restore only writes a marker; the database is
//! replaced on the next launch before SQLite opens it. The current database and
//! its WAL/SHM companions are archived first, never overwritten in place.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::backup;

const RESTORE_DIR: &str = "restore";
const PENDING_FILE: &str = "pending.json";
const LAST_RESULT_FILE: &str = "last-result.json";
const DATABASE_FILE: &str = "wheel.db";
const DATABASE_COMPANIONS: [&str; 3] = ["wheel.db-wal", "wheel.db-shm", "wheel.db-journal"];
const KEEP_ARCHIVE_SETS: usize = 3;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingRestore {
    pub version: u32,
    pub backup_file: String,
    pub safety_file: String,
    pub requested_at: String,
    /// Version 2 only: the decrypted SQLite copy waiting in the restore
    /// directory. It is removed once the restore finishes or fails.
    #[serde(default)]
    pub staged_file: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub ok: bool,
    pub message: String,
    pub at: String,
    pub backup_file: Option<String>,
    pub safety_file: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RestoreStatus {
    pub pending: Option<PendingRestore>,
    pub last_result: Option<RestoreResult>,
    pub failed: Vec<String>,
}

pub fn restore_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(RESTORE_DIR)
}

fn marker_path(data_dir: &Path) -> PathBuf {
    restore_dir(data_dir).join(PENDING_FILE)
}

fn last_result_path(data_dir: &Path) -> PathBuf {
    restore_dir(data_dir).join(LAST_RESULT_FILE)
}

pub fn is_pending(data_dir: &Path) -> Result<bool> {
    Ok(marker_path(data_dir).is_file())
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, bytes)
        .with_context(|| format!("cannot write {}", temporary.display()))?;
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    std::fs::rename(&temporary, path)
        .with_context(|| format!("cannot finalize {}", path.display()))?;
    Ok(())
}

fn write_result(data_dir: &Path, result: &RestoreResult) -> Result<()> {
    let json = serde_json::to_vec_pretty(result)?;
    write_atomic(&last_result_path(data_dir), &json)
}

fn isolate_marker(data_dir: &Path, prefix: &str, stamp: i128) -> Result<()> {
    let source = marker_path(data_dir);
    if !source.exists() {
        return Ok(());
    }
    let target = restore_dir(data_dir).join(format!("{prefix}-{stamp}.json"));
    std::fs::rename(source, target)?;
    Ok(())
}

fn now_stamp() -> String {
    OffsetDateTime::now_utc().to_string()
}

/// Validate the chosen snapshot, take a pre-restore safety copy and record the
/// request. The active database is not touched here. Encrypted snapshots are
/// decrypted once, at staging time, into the restore
/// directory. The plaintext copy stays there only until the next launch swaps
/// it in, so the backup itself keeps its password protection at rest.
pub fn stage_with_password(
    conn: &Connection,
    data_dir: &Path,
    file_name: &str,
    stamp: i128,
    password: Option<&str>,
) -> Result<PendingRestore> {
    if is_pending(data_dir)? {
        bail!("已有一项恢复等待重启，请重启应用后再操作");
    }
    let backups = data_dir.join(backup::BACKUP_DIR);
    let validation = backup::validate_with_password(&backups, file_name, password)?;
    if !validation.valid {
        bail!("备份未通过校验：{}", validation.issues.join("；"));
    }

    let mut staged: Option<PathBuf> = None;
    if backup::is_encrypted_file_name(file_name) {
        let directory = restore_dir(data_dir);
        std::fs::create_dir_all(&directory)?;
        let staged_name = format!("staged-{stamp}.sqlite");
        let staged_path = directory.join(&staged_name);
        if let Err(error) = backup::materialize(&backups, file_name, password, &staged_path) {
            let _ = std::fs::remove_file(&staged_path);
            return Err(error);
        }
        let staged_validation = backup::validate(&directory, &staged_name)?;
        if !staged_validation.valid {
            let _ = std::fs::remove_file(&staged_path);
            bail!(
                "暂存的恢复副本未通过校验：{}",
                staged_validation.issues.join("；")
            );
        }
        staged = Some(staged_path);
    }

    let safety = backup::create(conn, &backups, "pre-restore-", stamp)?;
    let safety_file = safety
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| anyhow::anyhow!("safety snapshot has no file name"))?;
    let staged_file = staged
        .as_ref()
        .and_then(|path| path.file_name())
        .map(|name| name.to_string_lossy().into_owned());
    let pending = PendingRestore {
        version: if staged_file.is_some() { 2 } else { 1 },
        backup_file: file_name.to_string(),
        safety_file,
        requested_at: now_stamp(),
        staged_file,
    };
    let json = serde_json::to_vec_pretty(&pending)?;
    if let Err(error) = write_atomic(&marker_path(data_dir), &json) {
        let _ = std::fs::remove_file(&safety);
        if let Some(path) = staged {
            let _ = std::fs::remove_file(path);
        }
        return Err(error);
    }
    Ok(pending)
}

fn remove_staged(data_dir: &Path, pending: &PendingRestore) {
    let Some(name) = pending.staged_file.as_deref() else {
        return;
    };
    if backup::is_safe_file_name(name) {
        let _ = std::fs::remove_file(restore_dir(data_dir).join(name));
    }
}

fn move_aside(data_dir: &Path, archive_set: &Path) -> Result<Vec<(PathBuf, PathBuf)>> {
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut names = vec![DATABASE_FILE];
    names.extend(DATABASE_COMPANIONS);
    for name in names {
        let source = data_dir.join(name);
        if !source.exists() {
            continue;
        }
        let target = archive_set.join(name);
        if let Err(error) = std::fs::rename(&source, &target) {
            // Put back everything already moved so the live database stays whole.
            rollback(&moved)?;
            return Err(error).with_context(|| format!("cannot archive {}", source.display()));
        }
        moved.push((source, target));
    }
    Ok(moved)
}

fn rollback(moved: &[(PathBuf, PathBuf)]) -> Result<()> {
    for (original, archived) in moved.iter().rev() {
        std::fs::rename(archived, original).with_context(|| {
            format!(
                "cannot restore {} from {}; start the app with the original database to recover",
                original.display(),
                archived.display()
            )
        })?;
    }
    Ok(())
}

fn fail_restore(
    data_dir: &Path,
    pending: &PendingRestore,
    stamp: i128,
    message: String,
) -> Result<RestoreResult> {
    remove_staged(data_dir, pending);
    let result = RestoreResult {
        ok: false,
        message,
        at: now_stamp(),
        backup_file: Some(pending.backup_file.clone()),
        safety_file: Some(pending.safety_file.clone()),
    };
    write_result(data_dir, &result)?;
    isolate_marker(data_dir, "failed", stamp)?;
    Ok(result)
}

fn prune_archive(archive: &Path) {
    let Ok(entries) = std::fs::read_dir(archive) else {
        return;
    };
    let mut sets: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .map(|entry| entry.path())
        .collect();
    sets.sort_by(|left, right| right.file_name().cmp(&left.file_name()));
    for stale in sets.into_iter().skip(KEEP_ARCHIVE_SETS) {
        if let Err(error) = std::fs::remove_dir_all(&stale) {
            eprintln!(
                "cannot remove old restore archive {}: {error}",
                stale.display()
            );
        }
    }
}

/// Apply a staged restore. Must run before `store::open`. On any failure before
/// the new database is installed, the original remains usable and the marker is
/// quarantined; a rollback failure aborts startup instead of creating an empty DB.
pub fn apply_pending(data_dir: &Path, stamp: i128) -> Result<Option<RestoreResult>> {
    let marker = marker_path(data_dir);
    if !marker.is_file() {
        return Ok(None);
    }
    let pending: PendingRestore = match std::fs::read(&marker)
        .context("read restore marker")
        .and_then(|bytes| {
            serde_json::from_slice::<PendingRestore>(&bytes).context("parse restore marker")
        })
    {
        Ok(pending) if matches!(pending.version, 1 | 2) => pending,
        Ok(pending) => {
            let result = RestoreResult {
                ok: false,
                message: format!("不支持的恢复标记版本 {}", pending.version),
                at: now_stamp(),
                backup_file: None,
                safety_file: None,
            };
            write_result(data_dir, &result)?;
            isolate_marker(data_dir, "failed", stamp)?;
            return Ok(Some(result));
        }
        Err(error) => {
            let result = RestoreResult {
                ok: false,
                message: format!("恢复标记无法读取：{error:#}"),
                at: now_stamp(),
                backup_file: None,
                safety_file: None,
            };
            write_result(data_dir, &result)?;
            isolate_marker(data_dir, "failed", stamp)?;
            return Ok(Some(result));
        }
    };

    let backups = data_dir.join(backup::BACKUP_DIR);
    if !backup::is_safe_file_name(&pending.backup_file) {
        return fail_restore(data_dir, &pending, stamp, "恢复标记包含无效文件名".into()).map(Some);
    }

    // Version 2 restores reuse the decrypted copy prepared while staging; the
    // password is long gone by the time the app restarts.
    let staged_source = match (pending.version, pending.staged_file.as_deref()) {
        (2, Some(name)) if backup::is_safe_file_name(name) => {
            let directory = restore_dir(data_dir);
            if !directory.join(name).is_file() {
                return fail_restore(
                    data_dir,
                    &pending,
                    stamp,
                    "暂存的恢复副本不存在，请重新暂存恢复".into(),
                )
                .map(Some);
            }
            match backup::validate(&directory, name) {
                Ok(validation) if validation.valid => Some(directory.join(name)),
                Ok(validation) => {
                    return fail_restore(
                        data_dir,
                        &pending,
                        stamp,
                        format!("暂存副本未通过校验：{}", validation.issues.join("；")),
                    )
                    .map(Some)
                }
                Err(error) => {
                    return fail_restore(
                        data_dir,
                        &pending,
                        stamp,
                        format!("无法读取暂存副本：{error:#}"),
                    )
                    .map(Some)
                }
            }
        }
        (2, _) => {
            return fail_restore(
                data_dir,
                &pending,
                stamp,
                "恢复标记缺少暂存副本".into(),
            )
            .map(Some)
        }
        _ => None,
    };

    if staged_source.is_none() {
        match backup::validate(&backups, &pending.backup_file) {
            Ok(validation) if validation.valid => {}
            Ok(validation) => {
                return fail_restore(
                    data_dir,
                    &pending,
                    stamp,
                    format!("备份未通过校验：{}", validation.issues.join("；")),
                )
                .map(Some)
            }
            Err(error) => {
                return fail_restore(
                    data_dir,
                    &pending,
                    stamp,
                    format!("无法读取备份：{error:#}"),
                )
                .map(Some)
            }
        }
    }
    let source = staged_source.unwrap_or_else(|| backups.join(&pending.backup_file));

    let archive_set = restore_dir(data_dir)
        .join("archive")
        .join(stamp.to_string());
    std::fs::create_dir_all(&archive_set)?;
    let moved = match move_aside(data_dir, &archive_set) {
        Ok(moved) => moved,
        Err(error) => {
            return fail_restore(data_dir, &pending, stamp, format!("{error:#}")).map(Some)
        }
    };

    let temporary_name = format!("restore-{stamp}.sqlite");
    let temporary = data_dir.join(&temporary_name);
    let install = (|| -> Result<()> {
        std::fs::copy(&source, &temporary)
            .with_context(|| format!("cannot copy backup {}", source.display()))?;
        let validation = backup::validate(data_dir, &temporary_name)?;
        if !validation.valid {
            bail!("恢复副本未通过校验：{}", validation.issues.join("；"));
        }
        std::fs::rename(&temporary, data_dir.join(DATABASE_FILE))
            .context("cannot install restored database")?;
        Ok(())
    })();

    if let Err(error) = install {
        let _ = std::fs::remove_file(&temporary);
        match rollback(&moved) {
            Ok(()) => {
                return fail_restore(
                    data_dir,
                    &pending,
                    stamp,
                    format!("恢复失败，已保留原数据库：{error:#}"),
                )
                .map(Some)
            }
            Err(rollback_error) => {
                remove_staged(data_dir, &pending);
                return Err(anyhow::anyhow!(
                    "恢复失败且无法还原原数据库：{error:#}；{rollback_error:#}"
                ));
            }
        }
    }

    // The decrypted copy has served its purpose; the encrypted backup remains
    // available in the backup list.
    remove_staged(data_dir, &pending);

    let result = RestoreResult {
        ok: true,
        message: format!("已恢复备份 {}", pending.backup_file),
        at: now_stamp(),
        backup_file: Some(pending.backup_file),
        safety_file: Some(pending.safety_file),
    };
    write_result(data_dir, &result)?;
    isolate_marker(data_dir, "applied", stamp)?;
    prune_archive(&restore_dir(data_dir).join("archive"));
    Ok(Some(result))
}

pub fn status(data_dir: &Path) -> Result<RestoreStatus> {
    let pending = std::fs::read(marker_path(data_dir))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<PendingRestore>(&bytes).ok());
    let last_result = std::fs::read(last_result_path(data_dir))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<RestoreResult>(&bytes).ok());
    let mut failed = Vec::new();
    if let Ok(entries) = std::fs::read_dir(restore_dir(data_dir)) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if entry
                .file_type()
                .map(|kind| kind.is_file())
                .unwrap_or(false)
                && name.starts_with("failed-")
                && name.ends_with(".json")
            {
                failed.push(name);
            }
        }
    }
    failed.sort();
    failed.reverse();
    Ok(RestoreStatus {
        pending,
        last_result,
        failed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store;

    fn temp_dir(label: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "wheel-restore-{label}-{}-{}",
            std::process::id(),
            OffsetDateTime::now_utc().unix_timestamp_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    fn buy(id: &str) -> wheel_core::Event {
        wheel_core::Event::buy_shares(
            "main",
            id,
            1,
            store::parse_date("2026-01-02").unwrap(),
            "AAPL",
            100,
            150.0,
            0.0,
        )
    }

    #[test]
    fn stage_is_non_destructive_and_rejects_a_second_request() {
        let directory = temp_dir("stage");
        let db_path = directory.join(DATABASE_FILE);
        let conn = store::open(&db_path).unwrap();
        store::insert_event(&conn, &buy("keep")).unwrap();
        let backups = directory.join(backup::BACKUP_DIR);
        let snapshot = backup::create(&conn, &backups, "wheel-", 10).unwrap();
        let file_name = snapshot
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let original = std::fs::read(&db_path).unwrap();
        let pending = stage_with_password(&conn, &directory, &file_name, 11, None).unwrap();
        assert_eq!(pending.backup_file, file_name);
        assert!(is_pending(&directory).unwrap());
        assert_eq!(std::fs::read(&db_path).unwrap(), original);
        assert_eq!(store::count_events(&conn, "main").unwrap(), 1);
        assert!(stage_with_password(&conn, &directory, &file_name, 12, None).is_err());
        assert!(is_pending(&directory).unwrap());
        let safety = backups.join(&pending.safety_file);
        assert!(safety.is_file());
        assert_eq!(
            backup::validate(&backups, &pending.safety_file)
                .unwrap()
                .events,
            1
        );
        drop(conn);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn apply_replaces_database_and_archives_wal_companions() {
        let directory = temp_dir("apply");
        let db_path = directory.join(DATABASE_FILE);
        let conn = store::open(&db_path).unwrap();
        store::insert_event(&conn, &buy("restored-event")).unwrap();
        let backups = directory.join(backup::BACKUP_DIR);
        let snapshot = backup::create(&conn, &backups, "wheel-", 20).unwrap();
        let file_name = snapshot
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        store::delete_event(&conn, "restored-event").unwrap();
        let mut live_only = buy("live-only");
        live_only.seq = 2;
        store::insert_event(&conn, &live_only).unwrap();
        stage_with_password(&conn, &directory, &file_name, 21, None).unwrap();
        drop(conn);
        std::fs::write(directory.join("wheel.db-wal"), b"wal").unwrap();
        std::fs::write(directory.join("wheel.db-shm"), b"shm").unwrap();

        assert!(apply_pending(&directory, 22).unwrap().unwrap().ok);
        assert!(!is_pending(&directory).unwrap());
        assert!(!directory.join("wheel.db-wal").exists());
        let restored = store::open(&db_path).unwrap();
        let events = store::list_events(&restored, "main").unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, "restored-event");
        let archive = restore_dir(&directory).join("archive").join("22");
        assert!(archive.join("wheel.db-wal").is_file());
        assert!(archive.join("wheel.db-shm").is_file());
        assert_eq!(std::fs::read(archive.join("wheel.db-wal")).unwrap(), b"wal");
        let status = status(&directory).unwrap();
        assert!(status.pending.is_none());
        assert!(status.last_result.unwrap().ok);
        drop(restored);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn corrupt_snapshot_keeps_live_database_and_quarantines_marker() {
        let directory = temp_dir("corrupt");
        let db_path = directory.join(DATABASE_FILE);
        let conn = store::open(&db_path).unwrap();
        store::insert_event(&conn, &buy("live")).unwrap();
        let backups = directory.join(backup::BACKUP_DIR);
        let snapshot = backup::create(&conn, &backups, "wheel-", 30).unwrap();
        let file_name = snapshot
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        stage_with_password(&conn, &directory, &file_name, 31, None).unwrap();
        drop(conn);
        std::fs::write(&snapshot, b"corrupted after staging").unwrap();
        let before = std::fs::read(&db_path).unwrap();

        let result = apply_pending(&directory, 32).unwrap().unwrap();
        assert!(!result.ok);
        assert_eq!(std::fs::read(&db_path).unwrap(), before);
        assert!(!is_pending(&directory).unwrap());
        let status = status(&directory).unwrap();
        assert_eq!(status.failed.len(), 1);
        assert!(!status.last_result.unwrap().ok);
        let conn = store::open(&db_path).unwrap();
        assert_eq!(store::count_events(&conn, "main").unwrap(), 1);
        drop(conn);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn encrypted_restore_stages_a_decrypted_copy_and_removes_it_after_apply() {
        let directory = temp_dir("encrypted");
        let db_path = directory.join(DATABASE_FILE);
        let conn = store::open(&db_path).unwrap();
        store::insert_event(&conn, &buy("restored")).unwrap();
        let backups = directory.join(backup::BACKUP_DIR);
        let snapshot =
            backup::create_encrypted(&conn, &backups, "wheel-", 50, "correct horse").unwrap();
        let file_name = snapshot
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        store::delete_event(&conn, "restored").unwrap();

        assert!(stage_with_password(
            &conn,
            &directory,
            &file_name,
            51,
            Some("wrong password")
        )
        .is_err());
        assert!(stage_with_password(&conn, &directory, &file_name, 52, None).is_err());
        assert!(!is_pending(&directory).unwrap());

        let pending =
            stage_with_password(&conn, &directory, &file_name, 53, Some("correct horse")).unwrap();
        assert_eq!(pending.version, 2);
        let staged_name = pending.staged_file.clone().unwrap();
        let staged_path = restore_dir(&directory).join(&staged_name);
        assert!(staged_path.is_file());
        assert!(backup::validate(&restore_dir(&directory), &staged_name)
            .unwrap()
            .valid);
        assert_eq!(store::count_events(&conn, "main").unwrap(), 0);
        drop(conn);

        let result = apply_pending(&directory, 54).unwrap().unwrap();
        assert!(result.ok);
        assert!(!staged_path.exists());
        let restored = store::open(&db_path).unwrap();
        assert_eq!(store::count_events(&restored, "main").unwrap(), 1);
        drop(restored);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn missing_staged_copy_keeps_the_live_database() {
        let directory = temp_dir("staged-missing");
        let db_path = directory.join(DATABASE_FILE);
        let conn = store::open(&db_path).unwrap();
        store::insert_event(&conn, &buy("keep")).unwrap();
        let backups = directory.join(backup::BACKUP_DIR);
        let snapshot =
            backup::create_encrypted(&conn, &backups, "wheel-", 60, "correct horse").unwrap();
        let file_name = snapshot
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let pending =
            stage_with_password(&conn, &directory, &file_name, 61, Some("correct horse")).unwrap();
        drop(conn);
        let staged_path = restore_dir(&directory).join(pending.staged_file.unwrap());
        std::fs::remove_file(&staged_path).unwrap();
        let before = std::fs::read(&db_path).unwrap();

        let result = apply_pending(&directory, 62).unwrap().unwrap();
        assert!(!result.ok);
        assert_eq!(std::fs::read(&db_path).unwrap(), before);
        assert!(!is_pending(&directory).unwrap());
        let conn = store::open(&db_path).unwrap();
        assert_eq!(store::count_events(&conn, "main").unwrap(), 1);
        drop(conn);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn apply_without_marker_is_idempotent() {
        let directory = temp_dir("none");
        assert!(apply_pending(&directory, 40).unwrap().is_none());
        assert!(!is_pending(&directory).unwrap());
        assert_eq!(
            status(&directory).unwrap(),
            RestoreStatus {
                pending: None,
                last_result: None,
                failed: Vec::new(),
            }
        );
        std::fs::remove_dir_all(directory).unwrap();
    }
}
