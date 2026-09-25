//! CaptureDesk global shortcuts: Ctrl+Alt+R toggles recording,
//! Ctrl+Alt+P toggles pause/resume. Registering respects the
//! `hotkeysEnabled` setting.

use serde_json::json;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

pub fn register(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    apply_enabled(app, crate::settings::flag(app, "hotkeysEnabled", true))
}

/// (Un)register the global hotkeys according to the `hotkeysEnabled` setting.
/// Called at startup and whenever the setting flips at runtime.
pub fn apply_enabled(app: &AppHandle, enabled: bool) -> Result<(), Box<dyn std::error::Error>> {
    let gs = app.global_shortcut();
    if enabled {
        gs.register("ctrl+alt+r")?;
        gs.register("ctrl+alt+p")?;
    } else {
        gs.unregister("ctrl+alt+r").ok();
        gs.unregister("ctrl+alt+p").ok();
    }
    Ok(())
}

pub fn dispatch(app: &AppHandle, shortcut: &Shortcut) {
    let toggle = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyR);
    let pause = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyP);
    if *shortcut == toggle {
        toggle_recording(app);
    } else if *shortcut == pause {
        toggle_pause(app);
    }
}

pub fn toggle_recording(app: &AppHandle) {
    let cur = {
        let st = app.state::<crate::state::AppState>();
        let val = st.session.lock().unwrap().state.clone();
        val
    };
    if matches!(cur.as_str(), "idle" | "error" | "") {
        let _ = crate::commands::rec_start_inner(app, json!({ "mode": "screen", "options": {} }));
    } else {
        let _ = crate::commands::rec_stop_inner(app);
    }
}

pub fn toggle_pause(app: &AppHandle) {
    let cur = {
        let st = app.state::<crate::state::AppState>();
        let val = st.session.lock().unwrap().state.clone();
        val
    };
    if cur == "paused" {
        let _ = crate::commands::rec_resume_inner(app);
    } else {
        let _ = crate::commands::rec_pause_inner(app);
    }
}
