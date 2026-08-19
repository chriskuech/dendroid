//! Provisions a portable [Bun](https://bun.sh) runtime so the "Claude Code"
//! and "Ollama" agent chat presets (`ux/settings/agentProviders.ts`) work
//! with nothing pre-installed — see `acp.rs`'s `acp_start`, which resolves
//! the `"bunx"` sentinel `command` those presets use through [`ensure_bun`]
//! before spawning anything.
//!
//! Bun ships as a single self-contained executable per platform (no
//! separate Node.js/npm install, no dynamic linking against a system JS
//! runtime), and its `bun x -y <package>` behaves like `npx -y <package>`:
//! it fetches an npm package on first use and caches it, no prior `npm
//! install` step needed. That's the whole trick — download that one
//! binary once, then let *it* handle fetching the actual ACP adapter
//! package the same way `npx` would have, so dendroid never has to
//! reimplement npm's dependency resolution itself.
//!
//! The binary is cached under the app's data dir
//! (`{app_data_dir}/agent-runtime/bun{,.exe}`) and reused indefinitely
//! once present — this never checks for a newer Bun release on its own.
//! That's a deliberate trade-off: revisit only if a specific Bun version
//! bug actually blocks an agent preset, not preemptively.
//!
//! Known gap: Linux builds always fetch the glibc build (`bun-linux-*`),
//! which won't run on a musl-based distro (e.g. Alpine) — there's no musl
//! variant selection here. Not a concern for how dendroid is actually
//! distributed (glibc-based bundles), but worth knowing if that changes.

use std::io::Cursor;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::state::AppDocState;

const BUN_RELEASE_BASE: &str = "https://github.com/oven-sh/bun/releases/latest/download";

/// Ensures a cached, executable Bun binary exists for this platform and
/// returns its path — downloading and unpacking Oven's official release
/// zip the first time this is called, reusing the cached copy on every
/// call after that. Concurrent callers (e.g. two chat threads both
/// connecting for the first time) are serialized on `state.bun_setup` so
/// only one download/extract happens; everyone else just waits for it and
/// then finds the cache already populated.
pub async fn ensure_bun(app: &AppHandle, state: &AppDocState) -> Result<PathBuf, String> {
    let target = bun_cache_path(app)?;
    if tokio::fs::try_exists(&target).await.unwrap_or(false) {
        return Ok(target);
    }

    let _guard = state.bun_setup.lock().await;
    // Re-check now that we hold the lock: whoever held it before us may
    // have already finished the download while we were waiting for it.
    if tokio::fs::try_exists(&target).await.unwrap_or(false) {
        return Ok(target);
    }

    download_and_extract(&target).await?;
    Ok(target)
}

fn bun_cache_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(base.join("agent-runtime").join(bun_exe_name()))
}

fn bun_exe_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "bun.exe"
    } else {
        "bun"
    }
}

/// Oven's own naming convention for Bun's release assets (see
/// `oven-sh/bun`'s `install.sh`/`install.ps1`) — also the top-level folder
/// name inside each release zip, which [`extract_executable`] relies on.
/// Split out from [`bun_asset_name`] so the platform-matching logic itself
/// is unit-testable without needing to fake `std::env::consts`.
fn bun_asset_name_for(os: &str, arch: &str) -> Result<&'static str, String> {
    match (os, arch) {
        ("linux", "x86_64") => Ok("bun-linux-x64"),
        ("linux", "aarch64") => Ok("bun-linux-aarch64"),
        ("macos", "x86_64") => Ok("bun-darwin-x64"),
        ("macos", "aarch64") => Ok("bun-darwin-aarch64"),
        ("windows", "x86_64") => Ok("bun-windows-x64"),
        (os, arch) => Err(format!(
            "agent chat needs a Node.js- or Bun-compatible runtime, and dendroid doesn't have a prebuilt one for {os}/{arch} — install Node.js or Bun yourself, then use the \"Custom\" agent preset to point at it"
        )),
    }
}

fn bun_asset_name() -> Result<&'static str, String> {
    bun_asset_name_for(std::env::consts::OS, std::env::consts::ARCH)
}

async fn download_and_extract(target: &Path) -> Result<(), String> {
    let asset = bun_asset_name()?;
    let url = format!("{BUN_RELEASE_BASE}/{asset}.zip");

    let response = reqwest::get(&url).await.map_err(|e| format!("couldn't download the agent runtime ({url}): {e}"))?;
    let response = response.error_for_status().map_err(|e| format!("couldn't download the agent runtime ({url}): {e}"))?;
    let bytes = response.bytes().await.map_err(|e| format!("couldn't download the agent runtime ({url}): {e}"))?;

    let dir = target.parent().ok_or_else(|| "invalid agent runtime cache path".to_string())?;
    tokio::fs::create_dir_all(dir).await.map_err(|e| e.to_string())?;

    // Zip extraction is synchronous, in-memory `std::io` — runs on a
    // blocking thread so it doesn't stall the async runtime the way doing
    // it inline here would.
    let entry_path = format!("{asset}/{}", bun_exe_name());
    let target_owned = target.to_path_buf();
    tokio::task::spawn_blocking(move || extract_executable(&bytes, &entry_path, &target_owned))
        .await
        .map_err(|e| format!("agent runtime extraction task panicked: {e}"))??;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(target, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Pulls `entry_path` (e.g. `bun-linux-x64/bun`) out of `zip_bytes` and
/// writes it to `target`, via a same-directory temp file renamed into
/// place so nothing ever observes a partially-written binary at `target`.
fn extract_executable(zip_bytes: &[u8], entry_path: &str, target: &Path) -> Result<(), String> {
    let mut archive =
        zip::ZipArchive::new(Cursor::new(zip_bytes)).map_err(|e| format!("couldn't read the downloaded agent runtime archive: {e}"))?;
    let mut entry = archive.by_name(entry_path).map_err(|e| format!("downloaded agent runtime archive is missing {entry_path}: {e}"))?;

    let tmp_path = target.with_extension("tmp");
    let mut out = std::fs::File::create(&tmp_path).map_err(|e| e.to_string())?;
    std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
    drop(out);
    std::fs::rename(&tmp_path, target).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_every_officially_supported_platform_to_its_bun_asset() {
        assert_eq!(bun_asset_name_for("linux", "x86_64"), Ok("bun-linux-x64"));
        assert_eq!(bun_asset_name_for("linux", "aarch64"), Ok("bun-linux-aarch64"));
        assert_eq!(bun_asset_name_for("macos", "x86_64"), Ok("bun-darwin-x64"));
        assert_eq!(bun_asset_name_for("macos", "aarch64"), Ok("bun-darwin-aarch64"));
        assert_eq!(bun_asset_name_for("windows", "x86_64"), Ok("bun-windows-x64"));
    }

    #[test]
    fn reports_unsupported_platforms_with_a_clear_message_instead_of_panicking() {
        assert!(bun_asset_name_for("windows", "aarch64").is_err());
        assert!(bun_asset_name_for("freebsd", "x86_64").is_err());
    }
}
