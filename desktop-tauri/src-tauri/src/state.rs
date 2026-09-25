//! CaptureDesk session state, shared snapshots and the `capturedesk://`
//! protocol registration.

use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

/// Live recording session snapshot. Field names mirror the v1 renderer
/// contract exactly (`rec-state` payloads, `getState().state`).
#[derive(Clone, Debug)]
pub struct Session {
    pub state: String, // idle | countdown | recording | paused | stopping | error
    pub elapsed_ms: u64,
    pub remaining_ms: Option<u64>,
    pub note: Option<String>,
    pub error: Option<String>,
    pub last_file: Option<String>,
    pub camera_bubble: bool,
    pub mode: Option<String>,
    /// Kept for v1 wire-contract parity; consumed by future source pickers.
    #[allow(dead_code)]
    pub source_id: Option<String>,
}

impl Default for Session {
    fn default() -> Self {
        Self {
            state: "idle".into(),
            elapsed_ms: 0,
            remaining_ms: None,
            note: None,
            error: None,
            last_file: None,
            camera_bubble: false,
            mode: None,
            source_id: None,
        }
    }
}

pub struct AppState {
    pub session: Mutex<Session>,
    /// Last drag-selected region: {displayId, rect:{x,y,width,height}}.
    pub pending_region: Mutex<Option<Value>>,
    /// File queued for the CaptureDesk Editor while its window is still
    /// loading (closes the editor:load race on first open / deep links).
    pub pending_editor_file: Mutex<Option<String>>,
    /// Recordings dir already granted to the runtime asset-protocol scope.
    pub asset_scope_dir: Mutex<Option<PathBuf>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            session: Mutex::new(Session::default()),
            pending_region: Mutex::new(None),
            pending_editor_file: Mutex::new(None),
            asset_scope_dir: Mutex::new(None),
        }
    }

    pub fn snapshot(&self) -> Value {
        let s = self.session.lock().unwrap();
        json!({
            "state": s.state,
            "elapsedMs": s.elapsed_ms,
            "remainingMs": s.remaining_ms,
            "note": s.note,
            "error": s.error,
            "lastFile": s.last_file,
            "cameraBubble": s.camera_bubble,
        })
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Merge an engine `state` event into the session and notify the UI.
pub fn apply_engine_state(app: &AppHandle, v: &Value) {
    let st = app.state::<AppState>();
    {
        let mut s = st.session.lock().unwrap();
        if let Some(x) = v.get("state").and_then(Value::as_str) {
            s.state = x.to_string();
        }
        if let Some(x) = v.get("elapsedMs").and_then(Value::as_u64) {
            s.elapsed_ms = x;
        }
        s.remaining_ms = v.get("remainingMs").and_then(Value::as_u64);
        s.note = v
            .get("note")
            .and_then(Value::as_str)
            .map(|x| x.to_string());
        s.error = v
            .get("error")
            .and_then(Value::as_str)
            .map(|x| x.to_string());
        if let Some(x) = v.get("mode").and_then(Value::as_str) {
            s.mode = Some(x.to_string());
        }
    }
    let snap = st.snapshot();
    let _ = app.emit("rec-state", snap.clone());
    // The floating toolbar follows the session lifecycle.
    let visible = matches!(
        snap["state"].as_str(),
        Some("countdown") | Some("recording") | Some("paused") | Some("stopping")
    );
    let _ = crate::windows::set_toolbar_visible(app, visible);
}

/// Engine reported a finished, saved recording.
pub fn session_done(app: &AppHandle, file: &str) {
    let st = app.state::<AppState>();
    {
        let mut s = st.session.lock().unwrap();
        s.state = "idle".into();
        s.elapsed_ms = 0;
        s.remaining_ms = None;
        s.last_file = Some(file.to_string());
        s.error = None;
    }
    let snap = st.snapshot();
    let _ = app.emit("rec-state", snap);
    let _ = crate::windows::set_toolbar_visible(app, false);
    let _ = app.emit("library-changed", json!({ "at": now_ms() }));
}

/// Extract a file argument from a `capturedesk://editor?file=...` deep link
/// found in the process argv.
pub fn deep_link_file(argv: &[String]) -> Option<String> {
    for a in argv {
        let Some(rest) = a.strip_prefix("capturedesk://") else {
            continue;
        };
        let lower = rest.to_lowercase();
        if let Some(pos) = lower.find("file=") {
            let raw = &rest[pos + 5..];
            let end = raw.find('&').unwrap_or(raw.len());
            let dec = percent_encoding::percent_decode_str(&raw[..end])
                .decode_utf8()
                .ok()?;
            return Some(dec.to_string());
        }
    }
    None
}

/// Register the `capturedesk://` URL scheme per-user so the browser
/// extension and shortcuts can launch CaptureDesk Desktop.
pub fn register_protocol(_app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let exe = std::env::current_exe()?.to_string_lossy().replace('/', "\\");
        let run = |sub: &str, value: &str| {
            let _ = Command::new("reg")
                .args(["add", sub, "/ve", "/d", value, "/f"])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
        };
        run("HKCU\\Software\\Classes\\capturedesk", "URL:CaptureDesk");
        let _ = Command::new("reg")
            .args([
                "add",
                "HKCU\\Software\\Classes\\capturedesk",
                "/v",
                "URL Protocol",
                "/ve",
                "/d",
                "",
                "/f",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        run(
            "HKCU\\Software\\Classes\\capturedesk\\shell\\open\\command",
            &format!("\"{exe}\" \"%1\""),
        );
    }
    Ok(())
}
