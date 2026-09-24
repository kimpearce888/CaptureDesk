//! CaptureDesk windows: floating toolbar, region picker, camera bubble and
//! the CaptureDesk Editor. The dashboard is the static main window from
//! `tauri.conf.json`.

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, LogicalPosition, Manager, WebviewUrl, WebviewWindowBuilder};

/// Post-startup window state.
pub fn prepare(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // The toolbar only exists while a session is live.
    if let Some(w) = app.get_webview_window("toolbar") {
        let _ = w.hide();
    }
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

/// Show (or create) the region picker overlay covering the primary monitor.
pub fn begin_region(app: &AppHandle) -> Value {
    match app.get_webview_window("region") {
        Some(w) => {
            let _ = w.show();
            let _ = w.set_focus();
        }
        None => {
            let builder = WebviewWindowBuilder::new(
                app,
                "region",
                WebviewUrl::App("region/index.html".into()),
            )
            .title("CaptureDesk Region")
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .focused(true);
            let builder = if let Ok(Some(m)) = app.primary_monitor() {
                builder
                    .position(m.position().x as f64, m.position().y as f64)
                    .inner_size(m.size().width as f64, m.size().height as f64)
            } else {
                builder.inner_size(1280.0, 800.0)
            };
            if let Err(e) = builder.build() {
                return json!({ "ok": false, "error": e.to_string() });
            }
        }
    }
    json!({ "ok": true })
}

pub fn end_region(app: &AppHandle) {
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
