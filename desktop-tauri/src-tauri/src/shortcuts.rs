//! CaptureDesk global shortcuts: Ctrl+Alt+R toggles recording,
//! Ctrl+Alt+P toggles pause/resume. Registering respects the
//! `hotkeysEnabled` setting.

use serde_json::json;
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

pub fn register(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    if !crate::settings::flag(app, "hotkeysEnabled", true) {
        return Ok(());
    }
    let gs = app.global_shortcut();
    gs.register("ctrl+alt+r")?;
    gs.register("ctrl+alt+p")?;
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
        st.session.lock().unwrap().state.clone()
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
        st.session.lock().unwrap().state.clone()
    };
    if cur == "paused" {
        let _ = crate::commands::rec_resume_inner(app);
    } else {
        let _ = crate::commands::rec_pause_inner(app);
    }
}
