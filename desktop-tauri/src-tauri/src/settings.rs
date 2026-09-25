//! CaptureDesk settings — a single JSON file under the app data directory.
//! Keys match the v1 renderer contract exactly.

use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

pub fn defaults() -> Value {
    json!({
        "mic": true,
        "systemAudio": true,
        "cameraBubble": false,
        "cursorHighlight": true,
        "clickHighlight": true,
        "fps": 30,
        "quality": "source",
        "countdown": 0,
        "highlight": { "color": "#5EEAD4", "size": 26 },
        "minimizeToTray": true,
        "hotkeysEnabled": true,
        "recordingsDir": ""
    })
}

fn settings_file(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .map(|d| d.join("capturedesk-settings.json"))
        .unwrap_or_else(|_| PathBuf::from("capturedesk-settings.json"))
}

/// Load settings, merged over the defaults. Unknown stored keys survive.
pub fn load(app: &AppHandle) -> Value {
    let mut merged = defaults();
    if let Ok(txt) = std::fs::read_to_string(settings_file(app)) {
        if let Ok(stored) = serde_json::from_str::<Value>(&txt) {
            if let (Some(a), Some(b)) = (merged.as_object_mut(), stored.as_object()) {
                for (k, v) in b {
                    a.insert(k.clone(), v.clone());
                }
            }
        }
    }
    merged
}

pub fn flag(app: &AppHandle, key: &str, default: bool) -> bool {
    load(app)
        .get(key)
        .and_then(Value::as_bool)
        .unwrap_or(default)
}

/// Merge a patch, persist it and broadcast `settings-changed`.
pub fn save(app: &AppHandle, patch: Value) -> Value {
    let mut merged = load(app);
    if let (Some(a), Some(b)) = (merged.as_object_mut(), patch.as_object()) {
        for (k, v) in b {
            a.insert(k.clone(), v.clone());
        }
    }
    if let Some(dir) = settings_file(app).parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(txt) = serde_json::to_string_pretty(&merged) {
        let _ = std::fs::write(settings_file(app), txt);
    }
    let _ = app.emit("settings-changed", json!({ "settings": merged.clone() }));
    merged
}

/// Effective recordings directory (created on demand).
pub fn recordings_dir(app: &AppHandle) -> PathBuf {
    let configured = load(app)
        .get("recordingsDir")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let dir = if configured.is_empty() {
        app.path()
            .video_dir()
            .map(|v| v.join("CaptureDesk"))
            .unwrap_or_else(|_| PathBuf::from("CaptureDesk"))
    } else {
        PathBuf::from(configured)
    };
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Scratch space for exports and engine hand-off files.
pub fn tmp_dir(app: &AppHandle) -> PathBuf {
    let d = app
        .path()
        .app_data_dir()
        .map(|d| d.join("tmp"))
        .unwrap_or_else(|_| std::env::temp_dir().join("CaptureDesk"));
    let _ = std::fs::create_dir_all(&d);
    d
}
