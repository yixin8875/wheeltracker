//! Password encryption for portable backups.
//!
//! Layout (little-endian):
//!
//! ```text
//! "WHEELBK1" (8) | iterations (u32) | salt (16) | nonce (12) | ciphertext | tag (16)
//! ```
//!
//! The key is PBKDF2-HMAC-SHA256 over the password and salt; the payload is
//! AES-256-GCM with the 40-byte header authenticated as additional data, so a
//! modified iteration count or salt fails before any plaintext is trusted.

use anyhow::{bail, Context, Result};
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use ring::pbkdf2;
use ring::rand::{SecureRandom, SystemRandom};

pub const MAGIC: &[u8; 8] = b"WHEELBK1";
pub const DEFAULT_ITERATIONS: u32 = 200_000;
pub const MIN_PASSWORD_CHARS: usize = 8;
pub const MAX_PASSWORD_CHARS: usize = 128;

const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
const HEADER_LEN: usize = MAGIC.len() + 4 + SALT_LEN + NONCE_LEN;
const MAX_ITERATIONS: u32 = 5_000_000;

pub fn validate_password(password: &str) -> Result<()> {
    let count = password.chars().count();
    if count < MIN_PASSWORD_CHARS {
        bail!("密码至少需要 {MIN_PASSWORD_CHARS} 个字符");
    }
    if count > MAX_PASSWORD_CHARS {
        bail!("密码不能超过 {MAX_PASSWORD_CHARS} 个字符");
    }
    if password.trim().is_empty() {
        bail!("密码不能只包含空白字符");
    }
    Ok(())
}

fn derive_key(password: &str, salt: &[u8], iterations: u32) -> Result<[u8; 32]> {
    let iterations = std::num::NonZeroU32::new(iterations)
        .filter(|value| value.get() <= MAX_ITERATIONS)
        .context("加密迭代次数无效")?;
    let mut key = [0u8; 32];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        iterations,
        salt,
        password.as_bytes(),
        &mut key,
    );
    Ok(key)
}

pub fn encrypt(plaintext: &[u8], password: &str) -> Result<Vec<u8>> {
    validate_password(password)?;
    let random = SystemRandom::new();
    let mut salt = [0u8; SALT_LEN];
    random
        .fill(&mut salt)
        .map_err(|_| anyhow::anyhow!("无法生成随机盐"))?;
    let mut nonce = [0u8; NONCE_LEN];
    random
        .fill(&mut nonce)
        .map_err(|_| anyhow::anyhow!("无法生成随机 nonce"))?;
    encrypt_with(plaintext, password, DEFAULT_ITERATIONS, &salt, &nonce)
}

pub fn encrypt_with(
    plaintext: &[u8],
    password: &str,
    iterations: u32,
    salt: &[u8; SALT_LEN],
    nonce: &[u8; NONCE_LEN],
) -> Result<Vec<u8>> {
    validate_password(password)?;
    let mut header = Vec::with_capacity(HEADER_LEN);
    header.extend_from_slice(MAGIC);
    header.extend_from_slice(&iterations.to_le_bytes());
    header.extend_from_slice(salt);
    header.extend_from_slice(nonce);

    let key = derive_key(password, salt, iterations)?;
    let key = LessSafeKey::new(
        UnboundKey::new(&AES_256_GCM, &key).map_err(|_| anyhow::anyhow!("无法初始化加密密钥"))?,
    );
    let mut payload = plaintext.to_vec();
    key.seal_in_place_append_tag(
        Nonce::assume_unique_for_key(*nonce),
        Aad::from(header.as_slice()),
        &mut payload,
    )
    .map_err(|_| anyhow::anyhow!("加密备份失败"))?;

    header.extend_from_slice(&payload);
    Ok(header)
}

pub fn decrypt(blob: &[u8], password: &str) -> Result<Vec<u8>> {
    if blob.len() < HEADER_LEN + TAG_LEN {
        bail!("加密备份文件已截断");
    }
    if !blob.starts_with(MAGIC) {
        bail!("不是 Wheel 加密备份文件");
    }
    let iterations = u32::from_le_bytes(
        blob[8..12]
            .try_into()
            .map_err(|_| anyhow::anyhow!("加密备份头无效"))?,
    );
    let salt: [u8; SALT_LEN] = blob[12..28]
        .try_into()
        .map_err(|_| anyhow::anyhow!("加密备份头无效"))?;
    let nonce: [u8; NONCE_LEN] = blob[28..HEADER_LEN]
        .try_into()
        .map_err(|_| anyhow::anyhow!("加密备份头无效"))?;
    if iterations == 0 || iterations > MAX_ITERATIONS {
        bail!("加密备份的迭代次数无效");
    }

    let key = derive_key(password, &salt, iterations)?;
    let key = LessSafeKey::new(
        UnboundKey::new(&AES_256_GCM, &key).map_err(|_| anyhow::anyhow!("无法初始化加密密钥"))?,
    );
    let mut payload = blob[HEADER_LEN..].to_vec();
    let plaintext = key
        .open_in_place(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(&blob[..HEADER_LEN]),
            &mut payload,
        )
        .map_err(|_| anyhow::anyhow!("密码错误或备份文件已损坏"))?;
    Ok(plaintext.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encrypted(plain: &[u8]) -> Vec<u8> {
        encrypt_with(plain, "correct horse", 1_000, &[7u8; SALT_LEN], &[9u8; NONCE_LEN]).unwrap()
    }

    #[test]
    fn round_trip_preserves_bytes_with_the_default_iteration_count() {
        let plain = b"SQLite format 3\0 wheel ledger";
        let blob = encrypt(plain, "密码密码密码密码").unwrap();
        assert!(blob.starts_with(MAGIC));
        assert_eq!(decrypt(&blob, "密码密码密码密码").unwrap(), plain);
    }

    #[test]
    fn wrong_password_and_tampering_are_rejected() {
        let blob = encrypted(b"payload");
        assert!(decrypt(&blob, "wrong password").is_err());

        let mut bad_magic = blob.clone();
        bad_magic[0] ^= 0xff;
        assert!(decrypt(&bad_magic, "correct horse").is_err());

        let mut bad_salt = blob.clone();
        bad_salt[12] ^= 0x01;
        assert!(decrypt(&bad_salt, "correct horse").is_err());

        let mut bad_ciphertext = blob.clone();
        let last = bad_ciphertext.len() - 1;
        bad_ciphertext[last] ^= 0x01;
        assert!(decrypt(&bad_ciphertext, "correct horse").is_err());

        assert!(decrypt(&blob[..HEADER_LEN + TAG_LEN - 1], "correct horse").is_err());
    }

    #[test]
    fn rejects_invalid_iterations_and_short_input() {
        let mut blob = encrypted(b"payload");
        blob[8..12].copy_from_slice(&0u32.to_le_bytes());
        assert!(decrypt(&blob, "correct horse").is_err());

        blob[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(decrypt(&blob, "correct horse").is_err());

        assert!(decrypt(b"WHEELBK1", "correct horse").is_err());
    }

    #[test]
    fn password_policy_requires_eight_to_128_characters() {
        assert!(validate_password("1234567").is_err());
        assert!(validate_password("12345678").is_ok());
        assert!(validate_password(&"a".repeat(MAX_PASSWORD_CHARS + 1)).is_err());
        assert!(validate_password("        ").is_err());
        assert!(encrypt(b"x", "short").is_err());
    }
}
