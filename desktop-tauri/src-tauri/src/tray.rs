//! CaptureDesk tray icon and menu.

use serde_json::json;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter};

pub fn create(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItem::with_id(app, "show", "CaptureDesk Desktop", true, None::<&str>)?;
    let start = MenuItem::with_id(app, "start", "Start Recording", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Stop Recording", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let library = MenuItem::with_id(app, "library", "CaptureDesk Recordings", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "CaptureDesk Settings", true, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit CaptureDesk", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &sep1, &start, &stop, &sep2, &library, &settings, &quit])?;

    TrayIconBuilder::with_id("capturedesk-tray")
        .tooltip("CaptureDesk")
        .icon(
            app.default_window_icon()
                .ok_or("CaptureDesk icon unavailable")?
                .clone(),
        )
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => crate::windows::focus_main(app),
            "start" => {
                let _ = crate::commands::rec_start_inner(app, json!({ "mode": "screen", "options": {} }));
            }
            "stop" => {
                let _ = crate::commands::rec_stop_inner(app);
            }
            "library" => {
                let dir = crate::settings::recordings_dir(app);
                let _ = crate::commands::shell_open_path_inner(app, dir.to_string_lossy().to_string());
            }
            "settings" => {
                crate::windows::focus_main(app);
                let _ = app.emit_to("main", "settings-changed", json!({ "settings": crate::settings::load(app) }));
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}
