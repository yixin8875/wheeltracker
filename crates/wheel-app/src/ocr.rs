//! Screenshot OCR using the OCR engine built into Windows.
//!
//! The engine is exposed through WinRT (`Windows.Media.Ocr`). Calling WinRT
//! directly from Rust would require the `windows` crate and a large amount of
//! unsafe glue, so this module runs a tiny embedded PowerShell 5.1 script
//! instead. The script is written to a private temporary directory together
//! with the image, prints one recognised line per line to a UTF-8 file, and
//! the directory is always removed afterwards.
//!
//! The recognised text is intentionally returned unchanged: OCR output is
//! lossy, and the import wizard lets the user correct it before parsing.

use std::time::{Duration, Instant};

use base64::Engine as _;

/// Maximum decoded image size.
pub const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
/// Base64 grows by ~4/3; refuse obviously oversized payloads before decoding.
const MAX_ENCODED_CHARS: usize = 15 * 1024 * 1024;
/// OCR should finish well within this; a stuck engine is killed.
const TIMEOUT: Duration = Duration::from_secs(45);

const SCRIPT: &str = r#"param(
    [Parameter(Mandatory=$true)][string]$ImagePath,
    [Parameter(Mandatory=$true)][string]$OutPath
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}
$storageFile = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
$fileAccess = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType=WindowsRuntime]
$randomAccessStream = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
$bitmapDecoder = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$softwareBitmap = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$ocrEngine = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType=WindowsRuntime]
$ocrResult = [Windows.Media.Ocr.OcrResult, Windows.Media.Ocr, ContentType=WindowsRuntime]
$languageType = [Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime]
$file = Await ($storageFile::GetFileFromPathAsync($ImagePath)) ($storageFile)
$stream = Await ($file.OpenAsync($fileAccess::Read)) ($randomAccessStream)
$decoder = Await ($bitmapDecoder::CreateAsync($stream)) ($bitmapDecoder)
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ($softwareBitmap)
$engine = $ocrEngine::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) {
    $language = $languageType::new("en-US")
    $engine = $ocrEngine::TryCreateFromLanguage($language)
}
if ($null -eq $engine) { throw 'NO_OCR_ENGINE' }
$result = Await ($engine.RecognizeAsync($bitmap)) ($ocrResult)
$text = ($result.Lines | ForEach-Object { $_.Text }) -join "`n"
[System.IO.File]::WriteAllText($OutPath, $text, [System.Text.UTF8Encoding]::new($false))
"#;

/// Map an accepted image MIME type to a file extension for the OCR engine.
pub fn extension_for_mime(mime: &str) -> Option<&'static str> {
    match mime.trim().to_ascii_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/bmp" | "image/x-ms-bmp" => Some("bmp"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        "image/tiff" | "image/tif" => Some("tiff"),
        _ => None,
    }
}

fn is_allowed_extension(extension: &str) -> bool {
    matches!(
        extension,
        "png" | "jpg" | "jpeg" | "bmp" | "webp" | "gif" | "tif" | "tiff"
    )
}

/// Decode a base64 image (a `data:` prefix is tolerated).
pub fn decode_image(data: &str) -> Result<Vec<u8>, String> {
    let payload = data
        .split_once("base64,")
        .map(|(_, rest)| rest)
        .unwrap_or(data);
    let cleaned: String = payload.chars().filter(|ch| !ch.is_whitespace()).collect();
    if cleaned.is_empty() {
        return Err("图片数据为空".to_string());
    }
    if cleaned.len() > MAX_ENCODED_CHARS {
        return Err(format!(
            "图片超过 {} MB 上限",
            MAX_IMAGE_BYTES / 1024 / 1024
        ));
    }
    let aligned = format!("{}{}", cleaned, "=".repeat((4 - cleaned.len() % 4) % 4));
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(aligned.as_bytes())
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(cleaned.as_bytes()))
        .map_err(|_| "图片不是有效的 base64 数据".to_string())?;
    if bytes.is_empty() {
        return Err("图片数据为空".to_string());
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "图片超过 {} MB 上限",
            MAX_IMAGE_BYTES / 1024 / 1024
        ));
    }
    Ok(bytes)
}

/// Run Windows OCR over the image bytes. Returns one recognised line per line.
pub fn recognize(image: &[u8], extension: &str) -> Result<String, String> {
    if image.is_empty() {
        return Err("图片数据为空".to_string());
    }
    if image.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "图片超过 {} MB 上限",
            MAX_IMAGE_BYTES / 1024 / 1024
        ));
    }
    if !is_allowed_extension(extension) {
        return Err("不支持的图片格式".to_string());
    }

    #[cfg(not(windows))]
    {
        let _ = extension;
        Err("截图 OCR 仅支持 Windows".to_string())
    }

    #[cfg(windows)]
    {
        recognize_windows(image, extension)
    }
}

#[cfg(windows)]
fn recognize_windows(image: &[u8], extension: &str) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::{SystemTime, UNIX_EPOCH};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let dir = std::env::temp_dir().join(format!("wheel-ocr-{}-{unique}", std::process::id()));

    let result = (|| -> Result<String, String> {
        std::fs::create_dir_all(&dir).map_err(|error| format!("无法创建 OCR 临时目录：{error}"))?;
        let image_path = dir.join(format!("image.{extension}"));
        let script_path = dir.join("ocr.ps1");
        let out_path = dir.join("out.txt");
        let err_path = dir.join("err.txt");
        std::fs::write(&image_path, image)
            .map_err(|error| format!("无法写入 OCR 临时图片：{error}"))?;
        std::fs::write(&script_path, SCRIPT)
            .map_err(|error| format!("无法写入 OCR 脚本：{error}"))?;

        let err_file = std::fs::File::create(&err_path)
            .map_err(|error| format!("无法创建 OCR 日志：{error}"))?;
        let mut child = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(&script_path)
            .arg("-ImagePath")
            .arg(&image_path)
            .arg("-OutPath")
            .arg(&out_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(err_file))
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|error| format!("无法启动 Windows OCR：{error}"))?;

        let deadline = Instant::now() + TIMEOUT;
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    if !status.success() {
                        return Err(ocr_error(&err_path));
                    }
                    break;
                }
                Ok(None) => {
                    if Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err("OCR 超时，请缩小截图范围后重试".to_string());
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(error) => {
                    let _ = child.kill();
                    return Err(format!("等待 OCR 失败：{error}"));
                }
            }
        }

        let text = std::fs::read_to_string(&out_path)
            .map_err(|error| format!("无法读取 OCR 结果：{error}"))?;
        let text = text.trim_start_matches('\u{feff}').trim().to_string();
        if text.is_empty() {
            return Err("OCR 未识别到文字，请换一张更清晰的截图".to_string());
        }
        Ok(text)
    })();

    let _ = std::fs::remove_dir_all(&dir);
    result
}

#[cfg(windows)]
fn ocr_error(err_path: &std::path::Path) -> String {
    let details = std::fs::read_to_string(err_path).unwrap_or_default();
    if details.contains("NO_OCR_ENGINE") {
        return "系统未安装可用的 OCR 语言包。请在 Windows 设置 → 时间和语言 → 语言中安装英语或中文语言包。"
            .to_string();
    }
    let details = details.trim();
    if details.is_empty() {
        "Windows OCR 执行失败，未返回原因".to_string()
    } else {
        let excerpt: String = details.chars().take(300).collect();
        format!("Windows OCR 执行失败：{excerpt}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_common_image_types() {
        assert_eq!(extension_for_mime("image/png"), Some("png"));
        assert_eq!(extension_for_mime(" IMAGE/JPEG "), Some("jpg"));
        assert_eq!(extension_for_mime("image/x-ms-bmp"), Some("bmp"));
        assert_eq!(extension_for_mime("image/svg+xml"), None);
        assert_eq!(extension_for_mime("application/pdf"), None);
    }

    #[test]
    fn decodes_plain_and_data_uri_base64() {
        let encoded = base64::engine::general_purpose::STANDARD.encode(b"png-bytes");
        assert_eq!(decode_image(&encoded).expect("plain"), b"png-bytes");
        let data_uri = format!("data:image/png;base64,{encoded}");
        assert_eq!(decode_image(&data_uri).expect("data uri"), b"png-bytes");
    }

    #[test]
    fn rejects_empty_and_invalid_payloads() {
        assert!(decode_image("").is_err());
        assert!(decode_image("not base64 !!").is_err());
        assert!(recognize(&[], "png").is_err());
        assert!(recognize(b"x", "../png").is_err());
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires WHEEL_OCR_TEST_IMAGE pointing to a real screenshot"]
    fn windows_ocr_reads_a_real_image_when_configured() {
        let path = std::env::var("WHEEL_OCR_TEST_IMAGE")
            .expect("set WHEEL_OCR_TEST_IMAGE to a PNG/JPEG screenshot");
        let bytes = std::fs::read(&path).expect("read screenshot");
        let text = recognize(&bytes, "png").expect("OCR");
        assert!(!text.trim().is_empty());
        println!("{text}");
    }
}
