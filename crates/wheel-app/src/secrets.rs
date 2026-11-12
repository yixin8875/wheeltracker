//! WebDAV password storage.
//!
//! Passwords never enter SQLite. On Windows they are written to the Windows
//! Credential Manager (`CRED_TYPE_GENERIC`); everywhere else, or when the
//! credential store is unavailable, they are kept in memory for this run only
//! and the UI explicitly reports that they will not survive a restart.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Keychain,
    Session,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Keychain => "keychain",
            Source::Session => "session",
        }
    }
}

/// Namespaced key as specified by the WebDAV design: one credential per
/// server URL and account.
pub fn target(url: &str, username: &str) -> String {
    format!("wheel-tracker/webdav/{}/{}", url.trim(), username.trim())
}

fn session() -> &'static Mutex<HashMap<String, String>> {
    static SESSION: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    SESSION.get_or_init(|| Mutex::new(HashMap::new()))
}

fn session_put(key: &str, password: &str) {
    session()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(key.to_string(), password.to_string());
}

fn session_get(key: &str) -> Option<String> {
    session()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(key)
        .cloned()
}

fn session_remove(key: &str) {
    session()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(key);
}

/// Store a password. Returns where it actually landed so the UI can be honest
/// about a session-only fallback.
pub fn store(target: &str, username: &str, password: &str) -> Source {
    #[cfg(windows)]
    {
        if platform::write(target, username, password).is_ok() {
            session_remove(target);
            return Source::Keychain;
        }
    }
    #[cfg(not(windows))]
    let _ = username;
    session_put(target, password);
    Source::Session
}

pub fn get(target: &str) -> Option<(String, Source)> {
    #[cfg(windows)]
    {
        // The key already contains the account name; the stored user name is
        // not needed by callers, only the secret.
        if let Some((_username, password)) = platform::read(target) {
            return Some((password, Source::Keychain));
        }
    }
    session_get(target).map(|password| (password, Source::Session))
}

pub fn delete(target: &str) {
    #[cfg(windows)]
    platform::delete(target);
    session_remove(target);
}

#[cfg(windows)]
mod platform {
    use std::ptr;

    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
        CRED_TYPE_GENERIC,
    };

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn read_wide(value: *const u16) -> String {
        if value.is_null() {
            return String::new();
        }
        let mut length = 0usize;
        // SAFETY: the pointer comes from a CREDENTIALW owned by CredReadW and
        // is NUL-terminated by the credential manager.
        unsafe {
            while *value.add(length) != 0 {
                length += 1;
            }
            String::from_utf16_lossy(std::slice::from_raw_parts(value, length))
        }
    }

    pub fn write(target: &str, username: &str, password: &str) -> Result<(), String> {
        let mut target_w = wide(target);
        let mut username_w = wide(username);
        let mut blob = password.as_bytes().to_vec();
        let credential = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: target_w.as_mut_ptr(),
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            UserName: username_w.as_mut_ptr(),
            ..Default::default()
        };
        // SAFETY: all pointers refer to live buffers for the duration of the call.
        let ok = unsafe { CredWriteW(&credential, 0) };
        if ok == 0 {
            // SAFETY: GetLastError is always safe to call.
            return Err(format!(
                "Windows 凭据管理器写入失败（错误码 {}）",
                unsafe { GetLastError() }
            ));
        }
        Ok(())
    }

    pub fn read(target: &str) -> Option<(String, String)> {
        let target_w = wide(target);
        let mut credential: *mut CREDENTIALW = ptr::null_mut();
        // SAFETY: the out pointer is valid and freed below with CredFree.
        let ok = unsafe { CredReadW(target_w.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) };
        if ok == 0 || credential.is_null() {
            return None;
        }
        // SAFETY: CredReadW returned a valid CREDENTIALW.
        let stored = unsafe { &*credential };
        if stored.CredentialBlobSize > 0 && stored.CredentialBlob.is_null() {
            // SAFETY: matching CredFree for the handle returned by CredReadW.
            unsafe { CredFree(credential as *const core::ffi::c_void) };
            return None;
        }
        let blob = unsafe {
            std::slice::from_raw_parts(stored.CredentialBlob, stored.CredentialBlobSize as usize)
        };
        let password = String::from_utf8_lossy(blob).into_owned();
        let username = read_wide(stored.UserName);
        // SAFETY: matching CredFree for the handle returned by CredReadW.
        unsafe { CredFree(credential as *const core::ffi::c_void) };
        Some((username, password))
    }

    pub fn delete(target: &str) {
        let target_w = wide(target);
        // SAFETY: NUL-terminated wide string; a missing entry is not an error.
        unsafe {
            CredDeleteW(target_w.as_ptr(), CRED_TYPE_GENERIC, 0);
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use time::OffsetDateTime;

    #[test]
    fn windows_credential_manager_round_trip() {
        let target = format!(
            "wheel-tracker/webdav/test-{}-{}",
            std::process::id(),
            OffsetDateTime::now_utc().unix_timestamp_nanos()
        );
        let source = store(&target, "tester", "secret-value");
        assert_eq!(source, Source::Keychain, "Credential Manager should be available");
        let (password, source) = get(&target).expect("stored credential");
        assert_eq!(password, "secret-value");
        assert_eq!(source, Source::Keychain);
        delete(&target);
        assert!(get(&target).is_none(), "credential must be removed");
    }
}
