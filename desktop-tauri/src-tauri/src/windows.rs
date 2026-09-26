//! CaptureDesk windows: floating toolbar, region picker, camera bubble and
//! the CaptureDesk Editor. The dashboard is the static main window from
//! `tauri.conf.json`.

use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{
    AppHandle, Emitter, LogicalPosition, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};

/// Post-startup window state.
pub fn prepare(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // The floating toolbar exists from startup (hidden); it is shown only
    // while a session is live. A toolbar failure must not block startup —
    // set_toolbar_visible retries the creation lazily.
    let _ = ensure_toolbar(app);
    if let Some(w) = app.get_webview_window("toolbar") {
        let _ = w.hide();
    }
    Ok(())
}

/// Create the floating toolbar window once (hidden by default).
pub fn ensure_toolbar(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window("toolbar").is_some() {
        return Ok(());
    }
    let w = WebviewWindowBuilder::new(
        app,
        "toolbar",
        WebviewUrl::App("toolbar/index.html".into()),
    )
    .title("CaptureDesk Toolbar")
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .focused(false)
    .visible(false)
    .inner_size(420.0, 64.0)
    .build()
    .map_err(|e| e.to_string())?;
    let _ = w.hide();
    Ok(())
}

pub fn focus_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Show/hide the floating toolbar, centered near the top of the screen.
pub fn set_toolbar_visible(app: &AppHandle, visible: bool) -> Result<(), String> {
    let _ = ensure_toolbar(app);
    let w = app
        .get_webview_window("toolbar")
        .ok_or_else(|| "toolbar window missing".to_string())?;
    if visible {
        if let Ok(Some(m)) = w.primary_monitor() {
            let scale = m.scale_factor();
            let width = m.size().width as f64 / scale;
            let toolbar_w = 420.0_f64;
            let _ = w.set_position(LogicalPosition::new(
                (width - toolbar_w).max(0.0) / 2.0,
                18.0,
            ));
        }
        let _ = w.show();
        let _ = w.set_always_on_top(true);
    } else {
        let _ = w.hide();
    }
    Ok(())
}

/// Show the region picker overlay covering the primary monitor.
///
/// The picker shows a FROZEN SCREENSHOT of the desktop (captured by the
/// engine before any overlay exists) instead of relying on webview window
/// transparency — some GPU/WebView2 combinations composite transparent
/// windows as an opaque white fullscreen pane that blocks the whole desktop
/// (the v2.0.0 trap). If the screenshot fails the window still opens in the
/// legacy dim mode, and the fail-safes below guarantee an escape:
///   * global Esc hotkey (works even when the page never booted),
///   * Alt+F4 / window close → cancel,
///   * losing focus (user Alt-Tabbed away) → cancel after a grace period,
///   * page-side 90 s and native 180 s auto-cancel timers.
pub fn begin_region(app: &AppHandle) -> Value {
    let my_epoch = {
        let st = app.state::<crate::state::AppState>();
        let epoch = st.region_epoch.fetch_add(1, Ordering::SeqCst) + 1;
        // Clear any stale picker state from a previous session.
        *st.region_active.lock().unwrap() = false;
        *st.pending_region.lock().unwrap() = None;
        epoch
    };
    unregister_region_esc(app);
    if let Some(w) = app.get_webview_window("region") {
        // Destroy (not hide): the page bakes the previous screenshot into
        // its URL, so reuse would show an outdated desktop. destroy() skips
        // CloseRequested, so no cancel event leaks to the dashboard.
        let _ = w.destroy();
    }

    // Freeze the desktop BEFORE the overlay exists.
    let shot_path = crate::settings::tmp_dir(app).join("region-shot.png");
    let mut shot_param = String::new();
    match crate::engine::request(
        app,
        "grab-screen",
        json!({ "sourceId": "screen:0", "out": shot_path.to_string_lossy() }),
        15_000,
    ) {
        Ok(v) if v.get("ok").and_then(Value::as_bool).unwrap_or(false) => {
            shot_param = shot_path.to_string_lossy().to_string();
        }
        Ok(v) => {
            eprintln!(
                "[CaptureDesk] region shot unavailable: {}",
                v.get("error").and_then(Value::as_str).unwrap_or("unknown")
            );
        }
        Err(e) => eprintln!("[CaptureDesk] region shot unavailable: {e}"),
    }

    // The picker reads the monitor's PHYSICAL origin and the scale factor
    // from the URL so it can report a crop rect in physical pixels —
    // exactly what the engine's frames use. Builder position/inner_size are
    // LOGICAL pixels, so physical metrics are divided by the scale factor.
    let mon = app.primary_monitor().ok().flatten();
    let mut url = match &mon {
        Some(m) => format!(
            "region/index.html?displayId=0&displayX={}&displayY={}&scale={}",
            m.position().x,
            m.position().y,
            m.scale_factor()
        ),
        None => "region/index.html?displayId=0&displayX=0&displayY=0&scale=1".to_string(),
    };
    if !shot_param.is_empty() {
        let encoded = percent_encoding::utf8_percent_encode(
            &shot_param,
            percent_encoding::NON_ALPHANUMERIC,
        );
        url.push_str("&shot=");
        url.push_str(&encoded);
    }

    let mut builder = WebviewWindowBuilder::new(app, "region", WebviewUrl::App(url.into()))
        .title("CaptureDesk Region")
        .decorations(false)
        .transparent(true) // legacy dim fallback only; shot mode paints opaque
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(true)
        // Created hidden: the page reveals it once the screenshot decoded,
        // so a white pre-paint flash never appears. A native fallback shows
        // the window 900 ms later in case the page JS is broken.
        .visible(false);
    builder = match &mon {
        Some(m) => {
            let scale = m.scale_factor();
            builder
                .position(
                    m.position().x as f64 / scale,
                    m.position().y as f64 / scale,
                )
                .inner_size(
                    m.size().width as f64 / scale,
                    m.size().height as f64 / scale,
                )
        }
        None => builder.inner_size(1280.0, 800.0),
    };
    if let Err(e) = builder.build() {
        return json!({ "ok": false, "error": e.to_string() });
    }
    {
        let st = app.state::<crate::state::AppState>();
        *st.region_active.lock().unwrap() = true;
        *st.region_shown_at.lock().unwrap() = Some(std::time::Instant::now());
    }
    register_region_esc(app);

    // Fail-safe 1: show fallback — if the page never reveals itself (broken
    // JS / IPC), show the window natively so the user sees SOMETHING.
    {
        let app2 = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(900));
            if let Some(w) = app2.get_webview_window("region") {
                if !w.is_visible().unwrap_or(true) {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        });
    }
    // Fail-safe 2: the picker can never outlive 180 s — auto-cancel.
    {
        let app2 = app.clone();
        std::thread::spawn(move || {
            for _ in 0..36 {
                std::thread::sleep(Duration::from_secs(5));
                let alive = {
                    let st = app2.state::<crate::state::AppState>();
                    st.region_epoch.load(Ordering::SeqCst) == my_epoch
                };
                if !alive {
                    return; // a newer picker session owns the window now
                }
            }
            cancel_region(&app2);
        });
    }
    json!({ "ok": true, "shot": !shot_param.is_empty() })
}

/// Register the bare Esc global hotkey while the picker is up. The page
/// handles Esc itself when healthy; this catches the case where the webview
/// never booted — the exact failure that used to lock the whole PC.
fn register_region_esc(app: &AppHandle) {
    let gs = app.global_shortcut();
    let esc = Shortcut::new(None, Code::Escape);
    let _ = gs.unregister(esc);
    let _ = gs.on_shortcut(esc, |app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            cancel_region(app);
        }
    });
}

fn unregister_region_esc(app: &AppHandle) {
    let _ = app
        .global_shortcut()
        .unregister(Shortcut::new(None, Code::Escape));
}

/// Cancel the picker (Esc hotkey, blur, close, timeout): drop any pending
/// rect, tear down the hotkey, hide the window and tell the dashboard.
/// Idempotent — only the first call while active emits the canceled event.
pub fn cancel_region(app: &AppHandle) {
    let was_active = {
        let st = app.state::<crate::state::AppState>();
        let mut active = st.region_active.lock().unwrap();
        let was = *active;
        *active = false;
        *st.pending_region.lock().unwrap() = None;
        was
    };
    unregister_region_esc(app);
    if let Some(w) = app.get_webview_window("region") {
        let _ = w.hide();
    }
    if was_active {
        let _ = app.emit("region-selected", json!({ "displayId": 0, "canceled": true }));
    }
}

/// Picker window lost focus (user Alt-Tabbed / clicked another app through
/// a notification): give it a short grace period, then cancel so the
/// overlay can never sit on top of the desktop while the user works.
pub fn on_region_blur(app: &AppHandle) {
    let grace_ok = {
        let st = app.state::<crate::state::AppState>();
        match *st.region_shown_at.lock().unwrap() {
            Some(t) if t.elapsed() < Duration::from_millis(1500) => false,
            _ => true,
        }
    };
    if grace_ok {
        cancel_region(app);
    }
}

pub fn end_region(app: &AppHandle) {
    {
        let st = app.state::<crate::state::AppState>();
        *st.region_active.lock().unwrap() = false;
    }
    unregister_region_esc(app);
    if let Some(w) = app.get_webview_window("region") {
        let _ = w.hide();
    }
}

/// Toggle the camera bubble. The bubble shows a live camera preview; the
/// same camera is composited into the recording by the engine.
pub fn toggle_cambubble(app: &AppHandle) -> Value {
    let st = app.state::<crate::state::AppState>();
    let visible = {
        let mut s = st.session.lock().unwrap();
        s.camera_bubble = !s.camera_bubble;
        s.camera_bubble
    };
    if visible {
        match app.get_webview_window("cambubble") {
            Some(w) => {
                let _ = w.show();
            }
            None => {
                let _ = WebviewWindowBuilder::new(
                    app,
                    "cambubble",
                    WebviewUrl::App("cambubble/index.html".into()),
                )
                .title("CaptureDesk Camera")
                .inner_size(280.0, 210.0)
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .skip_taskbar(true)
                .resizable(false)
                .build();
            }
        }
    } else if let Some(w) = app.get_webview_window("cambubble") {
        let _ = w.hide();
    }
    let payload = json!({ "visible": visible });
    let _ = app.emit_to("toolbar", "cambubble-visible", payload.clone());
    let _ = app.emit_to("main", "cambubble-visible", payload);
    json!({ "visible": visible })
}
