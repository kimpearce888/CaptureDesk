//! CaptureDesk IPC command surface — a 1:1 port of the v1 Electron IPC
//! contract (see desktop/src/preload/index.js on the main branch), backed
//! by the native engine, the settings store and the recordings library.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

/// Grant a directory to the runtime asset-protocol scope so the editor can
/// stream recordings from custom recordings folders (`convertFileSrc`).
/// Applied once per directory change.
pub fn ensure_asset_scope(app: &AppHandle, dir: &std::path::Path) {
    {
        let mut applied = app
            .state::<crate::state::AppState>()
            .asset_scope_dir
            .lock()
            .unwrap();
        if applied.as_deref() == Some(dir) {
            return;
        }
        *applied = Some(dir.to_path_buf());
    }
    // `asset_protocol_scope` is available because Cargo.toml enables the
    // tauri "protocol-asset" feature. Granting is idempotent per directory.
    app.asset_protocol_scope()
        .allow_directory(dir, true)
        .ok();
}

// ---- app -------------------------------------------------------------------

#[tauri::command]
pub fn app_get_version() -> Value {
    json!({ "version": env!("CARGO_PKG_VERSION") })
}

#[tauri::command]
pub fn app_quit(app: AppHandle) {
    app.exit(0);
}

// ---- session state ---------------------------------------------------------

#[tauri::command]
pub fn state_get(app: AppHandle) -> Value {
    let st = app.state::<crate::state::AppState>();
    json!({ "state": st.snapshot() })
}

// ---- sources & recording ---------------------------------------------------

#[tauri::command]
pub fn sources_list(app: AppHandle, kinds: Value) -> Value {
    crate::engine::request(&app, "list-sources", kinds, 20_000)
        .unwrap_or_else(|e| json!({ "sources": [], "error": e }))
}

#[tauri::command]
pub fn rec_start(app: AppHandle, req: Value) -> Value {
    rec_start_inner(&app, req)
}

/// Start a recording. Used by the dashboard, tray and hotkeys.
pub fn rec_start_inner(app: &AppHandle, req: Value) -> Value {
    let settings = crate::settings::load(app);
    let options = req.get("options").cloned().unwrap_or(json!({}));
    let mut params = settings;
    if let (Some(a), Some(b)) = (params.as_object_mut(), options.as_object()) {
        for (k, v) in b {
            a.insert(k.clone(), v.clone());
        }
    }
    let mode = req
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("screen")
        .to_string();
    params["mode"] = json!(mode);
    if let Some(id) = req.get("sourceId") {
        params["sourceId"] = id.clone();
    }
    if mode == "region" {
        let st = app.state::<crate::state::AppState>();
        let rect = st.pending_region.lock().unwrap().clone();
        match rect {
            Some(r) => {
                params["rect"] = r;
            }
            None => {
                return json!({ "ok": false, "error": "Select a region first." });
            }
        }
    }
    ensure_asset_scope(app, &crate::settings::recordings_dir(app));
    let out = crate::settings::recordings_dir(app).join(crate::library::recording_name("webm"));
    params["out"] = json!(out.to_string_lossy());
    match crate::engine::request(app, "start", params, 30_000) {
        Ok(v) => {
            if v.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                json!({ "ok": true })
            } else {
                json!({
                    "ok": false,
                    "error": v.get("error").and_then(Value::as_str)
                        .unwrap_or("CaptureDesk could not start recording"),
                })
            }
        }
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

#[tauri::command]
pub fn rec_pause(app: AppHandle) -> Value {
    rec_pause_inner(&app)
}

pub fn rec_pause_inner(app: &AppHandle) -> Value {
    engine_ok(app, "pause", json!({}), 10_000)
}

#[tauri::command]
pub fn rec_resume(app: AppHandle) -> Value {
    rec_resume_inner(&app)
}

pub fn rec_resume_inner(app: &AppHandle) -> Value {
    engine_ok(app, "resume", json!({}), 10_000)
}

#[tauri::command]
pub fn rec_stop(app: AppHandle) -> Value {
    rec_stop_inner(&app)
}

pub fn rec_stop_inner(app: &AppHandle) -> Value {
    engine_ok(app, "stop", json!({}), 120_000)
}

#[tauri::command]
pub fn rec_cancel(app: AppHandle) -> Value {
    engine_ok(&app, "cancel", json!({}), 30_000)
}

/// Compatibility with the v1 recorder handshake. The v2 engine records
/// internally, so acknowledgements are always accepted.
#[tauri::command]
pub fn rec_ack(_app: AppHandle, _key: String, _value: Value) -> Value {
    json!({ "ok": true })
}

/// Compatibility with the v1 recorder window — the v2 engine persists the
/// file itself, so this is a no-op that reports the session's last file.
#[tauri::command]
pub fn rec_save(app: AppHandle, _payload: Value) -> Value {
    let st = app.state::<crate::state::AppState>();
    let last = st.session.lock().unwrap().last_file.clone();
    json!({ "ok": true, "file": last })
}

#[tauri::command]
pub fn rec_state_save(_app: AppHandle, _payload: Value) -> Value {
    json!({ "ok": true })
}

fn engine_ok(app: &AppHandle, cmd: &str, params: Value, timeout_ms: u64) -> Value {
    match crate::engine::request(app, cmd, params, timeout_ms) {
        Ok(v) => {
            if v.get("ok").and_then(Value::as_bool).unwrap_or(true) {
                json!({ "ok": true })
            } else {
                json!({
                    "ok": false,
                    "error": v.get("error").and_then(Value::as_str).unwrap_or("CaptureDesk engine error"),
                })
            }
        }
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

// ---- camera bubble & region ------------------------------------------------

#[tauri::command]
pub fn cambubble_toggle(app: AppHandle) -> Value {
    crate::windows::toggle_cambubble(&app)
}

#[tauri::command]
pub fn region_begin(app: AppHandle) -> Value {
    crate::windows::begin_region(&app)
}

#[tauri::command]
pub fn region_selected(app: AppHandle, payload: Value) -> Value {
    let st = app.state::<crate::state::AppState>();
    *st.pending_region.lock().unwrap() = Some(payload.clone());
    crate::windows::end_region(&app);
    let _ = app.emit("region-selected", payload);
    json!({ "ok": true })
}

// ---- settings --------------------------------------------------------------

#[tauri::command]
pub fn settings_get(app: AppHandle) -> Value {
    json!({ "settings": crate::settings::load(&app) })
}

#[tauri::command]
pub fn settings_set(app: AppHandle, patch: Value) -> Value {
    let before = crate::settings::flag(&app, "hotkeysEnabled", true);
    let merged = crate::settings::save(&app, patch);
    let after = crate::settings::flag(&app, "hotkeysEnabled", true);
    if before != after {
        // Apply the hotkey switch immediately instead of at next launch.
        crate::shortcuts::apply_enabled(&app, after);
    }
    json!({ "ok": true, "settings": merged })
}

// ---- library ---------------------------------------------------------------

#[tauri::command]
pub fn library_list(app: AppHandle) -> Value {
    let dir = crate::settings::recordings_dir(&app);
    json!({ "items": crate::library::list(&dir) })
}

#[tauri::command]
pub fn library_rename(app: AppHandle, file: String, new_name: String) -> Value {
    let dir = crate::settings::recordings_dir(&app);
    let src = PathBuf::from(&file);
    if !crate::library::is_inside(&dir, &src) {
        return json!({ "ok": false, "error": "Recording is outside the CaptureDesk library." });
    }
    let stem = crate::library::safe_stem(&new_name);
    if stem.is_empty() {
        return json!({ "ok": false, "error": "CaptureDesk needs a name for the recording." });
    }
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("webm")
        .to_string();
    let mut target = dir.join(format!("{stem}.{ext}"));
    let mut n = 1;
    while target.exists() && target != src {
        target = dir.join(format!("{stem}-{n}.{ext}"));
        n += 1;
    }
    match std::fs::rename(&src, &target) {
        Ok(_) => {
            crate::library::notify_changed(&app);
            json!({ "ok": true, "file": target.to_string_lossy() })
        }
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

#[tauri::command]
pub fn library_remove(app: AppHandle, file: String) -> Value {
    let dir = crate::settings::recordings_dir(&app);
    let p = PathBuf::from(&file);
    if !crate::library::is_inside(&dir, &p) {
        return json!({ "ok": false, "error": "Recording is outside the CaptureDesk library." });
    }
    match std::fs::remove_file(&p) {
        Ok(_) => {
            crate::library::notify_changed(&app);
            json!({ "ok": true })
        }
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

#[tauri::command]
pub fn library_reveal(app: AppHandle, file: String) -> Value {
    reveal_inner(&app, &file)
}

pub fn reveal_inner(_app: &AppHandle, file: &str) -> Value {
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("explorer").arg(format!("/select,{file}")).spawn();
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").args(["-R", file]).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = {
        let parent = std::path::Path::new(file)
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_default();
        std::process::Command::new("xdg-open").arg(parent).spawn()
    };
    match r {
        Ok(_) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

#[tauri::command]
pub fn library_dir(app: AppHandle) -> Value {
    let dir = crate::settings::recordings_dir(&app);
    json!({ "dir": dir.to_string_lossy() })
}

#[tauri::command]
pub async fn library_pick_dir(app: AppHandle) -> Value {
    use tauri_plugin_dialog::DialogExt;
    // The native folder dialog stays open for as long as the user likes:
    // run the wait off the IPC thread so other commands keep flowing.
    let result = tauri::async_runtime::spawn_blocking(move || {
        let (tx, rx) = std::sync::mpsc::channel::<Option<String>>();
        app.dialog()
            .file()
            .set_title("CaptureDesk Recordings")
            .pick_folder(move |p| {
                let s = p
                    .and_then(|f| f.into_path().ok())
                    .map(|pb| pb.to_string_lossy().to_string());
                let _ = tx.send(s);
            });
        match rx.recv_timeout(std::time::Duration::from_secs(600)) {
            Ok(Some(dir)) => json!({ "ok": true, "dir": dir }),
            _ => json!({ "ok": false }),
        }
    })
    .await;
    result.unwrap_or_else(|_| json!({ "ok": false }))
}

// ---- editor ----------------------------------------------------------------

#[tauri::command]
pub fn editor_open(app: AppHandle, file: Option<String>) -> Value {
    match open_editor_with_file(&app, file) {
        Ok(_) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

/// Create (or focus) the CaptureDesk Editor and load a recording into it.
pub fn open_editor_with_file(app: &AppHandle, file: Option<String>) -> Result<(), String> {
    let existing = app.get_webview_window("editor");
    // Make sure the recordings folder is streamable by the editor webview
    // (asset protocol) even before the first recording was started.
    ensure_asset_scope(app, &crate::settings::recordings_dir(app));
    if let Some(f) = &file {
        // Queue the file first: a freshly created editor window has not
        // registered its `editor:load` listener yet, so it pulls the queued
        // file via `editor_take_pending` once its JS boots.
        *app.state::<crate::state::AppState>()
            .pending_editor_file
            .lock()
            .unwrap() = Some(f.clone());
    }
    let w = match existing {
        Some(w) => w,
        None => tauri::WebviewWindowBuilder::new(
            app,
            "editor",
            tauri::WebviewUrl::App("editor/index.html".into()),
        )
        .title("CaptureDesk Editor")
        .inner_size(1180.0, 760.0)
        .min_inner_size(900.0, 600.0)
        .build()
        .map_err(|e| e.to_string())?,
    };
    let _ = w.show();
    let _ = w.set_focus();
    if let Some(f) = file {
        // Already-open window: the listener catches this directly.
        let _ = app.emit_to("editor", "editor:load", json!({ "file": f }));
    }
    Ok(())
}

/// Hand the queued editor file to a freshly booted editor window and clear
/// the slot (returns null when there is nothing queued).
#[tauri::command]
pub fn editor_take_pending(app: AppHandle) -> Value {
    let file = app
        .state::<crate::state::AppState>()
        .pending_editor_file
        .lock()
        .unwrap()
        .take();
    json!({ "file": file })
}

// ---- restricted filesystem -------------------------------------------------

#[tauri::command]
pub fn fs_app_path(app: AppHandle) -> Value {
    match app.path().app_data_dir() {
        Ok(p) => json!({ "path": p.to_string_lossy() }),
        Err(e) => json!({ "error": e.to_string() }),
    }
}

#[tauri::command]
pub fn fs_tmp_dir(app: AppHandle) -> Value {
    let d = crate::settings::tmp_dir(&app);
    json!({ "dir": d.to_string_lossy() })
}

#[tauri::command]
pub fn fs_recordings_dir(app: AppHandle) -> Value {
    let d = crate::settings::recordings_dir(&app);
    json!({ "dir": d.to_string_lossy() })
}

#[tauri::command]
pub fn fs_app_file_url(app: AppHandle, rel: String) -> Value {
    let base = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let p = base.join(&rel);
    if p.exists() {
        json!({ "path": p.to_string_lossy() })
    } else {
        json!({ "path": "" })
    }
}

#[tauri::command]
pub fn fs_read_recording(app: AppHandle, file: String) -> Value {
    let dir = crate::settings::recordings_dir(&app);
    let p = PathBuf::from(&file);
    if !crate::library::is_inside(&dir, &p) {
        return json!({ "ok": false, "error": "Recording is outside the CaptureDesk library." });
    }
    match std::fs::read(&p) {
        Ok(bytes) => json!({ "ok": true, "dataB64": B64.encode(bytes) }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

#[tauri::command]
pub fn fs_write_file(app: AppHandle, file: String, data_b64: String) -> Value {
    let allowed = {
        let p = PathBuf::from(&file);
        crate::library::is_inside(&crate::settings::recordings_dir(&app), &p)
            || p.starts_with(crate::settings::tmp_dir(&app))
    };
    if !allowed {
        return json!({ "ok": false, "error": "CaptureDesk only writes inside its library and temp folders." });
    }
    match B64.decode(data_b64.trim()) {
        Ok(bytes) => match std::fs::write(&file, bytes) {
            Ok(_) => json!({ "ok": true, "path": file }),
            Err(e) => json!({ "ok": false, "error": e.to_string() }),
        },
        Err(e) => json!({ "ok": false, "error": format!("bad payload: {e}") }),
    }
}

#[tauri::command]
pub fn fs_unique_path(app: AppHandle, base: String, ext: String) -> Value {
    let p = crate::library::unique_path(&crate::settings::recordings_dir(&app), &base, &ext);
    json!({ "ok": true, "path": p.to_string_lossy() })
}

// ---- shell -----------------------------------------------------------------

#[tauri::command]
pub fn shell_open_path(app: AppHandle, path: String) -> Value {
    shell_open_path_inner(&app, path)
}

pub fn shell_open_path_inner(_app: &AppHandle, path: String) -> Value {
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("explorer").arg(&path).spawn();
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(&path).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = std::process::Command::new("xdg-open").arg(&path).spawn();
    match r {
        Ok(_) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

// ---- native export (CaptureDesk Export) ------------------------------------

/// Hand an export spec to the engine: trim, optional annotation burn-in and
/// WebM / MP4 / GIF encoding, with progress events on `export-progress`.
/// The result resolves from the engine's id-tagged done/error event.
#[tauri::command]
pub fn transcode_file(app: AppHandle, spec: Value) -> Value {
    let mut s = spec;
    let base = s
        .get("base")
        .and_then(Value::as_str)
        .unwrap_or("CaptureDesk")
        .to_string();
    let format = s
        .get("format")
        .and_then(Value::as_str)
        .unwrap_or("webm")
        .to_string();
    let out = crate::library::unique_path(&crate::settings::recordings_dir(&app), &base, &format);
    s["out"] = json!(out.to_string_lossy());
    match crate::engine::request(&app, "transcode", s, 1_800_000) {
        Ok(v) => {
            if v.get("file").is_some() {
                json!({ "ok": true, "file": v["file"], "fallbackNote": null })
            } else if let Some(m) = v.get("message").and_then(Value::as_str) {
                json!({ "ok": false, "error": m })
            } else {
                v
            }
        }
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

/// Engine health/version probe (used by the editor's engine note + smoke).
#[tauri::command]
pub fn engine_version(app: AppHandle) -> Value {
    crate::engine::request(&app, "version", json!({}), 10_000)
        .unwrap_or_else(|e| json!({ "ok": false, "error": e }))
}

#[tauri::command]
pub fn transcode_cancel(app: AppHandle) -> Value {
    engine_ok(&app, "transcode-cancel", json!({}), 10_000)
}
