//! CaptureDesk recordings library: scan, canonical file naming, rename,
//! delete and unique export paths.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Emitter};

/// Canonical recording file name: CaptureDesk_YYYY-MM-DD_HH-mm-ss.webm
pub fn recording_name(ext: &str) -> String {
    let now = chrono::Local::now();
    format!(
        "CaptureDesk_{}.{}",
        now.format("%Y-%m-%d_%H-%M-%S"),
        ext.trim_start_matches('.')
    )
}

/// Scan a recordings directory, newest first. Mirrors the v1 entry shape:
/// {file, name, size, mtime}.
pub fn list(dir: &Path) -> Vec<Value> {
    let mut items = vec![];
    if let Ok(rd) = std::fs::read_dir(dir) {
        for ent in rd.flatten() {
            let name = ent.file_name().to_string_lossy().to_string();
            let lower = name.to_lowercase();
            if !(lower.ends_with(".webm") || lower.ends_with(".mp4") || lower.ends_with(".gif")) {
                continue;
            }
            if let Ok(md) = ent.metadata() {
                if !md.is_file() {
                    continue;
                }
                let mtime = md
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                items.push(json!({
                    "file": ent.path().to_string_lossy(),
                    "name": name,
                    "size": md.len(),
                    "mtime": mtime,
                }));
            }
        }
    }
    items.sort_by(|a, b| {
        b["mtime"]
            .as_u64()
            .unwrap_or(0)
            .cmp(&a["mtime"].as_u64().unwrap_or(0))
    });
    items
}

/// True when `file` resolves inside `dir` (path-traversal guard).
pub fn is_inside(dir: &Path, file: &Path) -> bool {
    let Ok(dir_c) = dir.canonicalize() else {
        return false;
    };
    let Ok(file_c) = file.canonicalize() else {
        return false;
    };
    file_c.starts_with(dir_c)
}

/// First free path for `base.ext`, `base-1.ext`, …
pub fn unique_path(dir: &Path, base: &str, ext: &str) -> PathBuf {
    let ext = ext.trim_start_matches('.');
    let mut candidate = dir.join(format!("{base}.{ext}"));
    let mut n = 1;
    while candidate.exists() {
        candidate = dir.join(format!("{base}-{n}.{ext}"));
        n += 1;
    }
    candidate
}

/// Sanitize a user-supplied display name into a safe file stem.
pub fn safe_stem(name: &str) -> String {
    name.chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                ' '
            } else {
                c
            }
        })
        .collect::<String>()
        .trim()
        .to_string()
}

/// Broadcast a library change.
pub fn notify_changed(app: &AppHandle) {
    let _ = app.emit("library-changed", json!({ "at": crate::state::now_ms() }));
}
