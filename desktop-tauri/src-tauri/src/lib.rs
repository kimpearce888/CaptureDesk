//! CaptureDesk Desktop — Tauri 2 application shell (v2 native stack).
//!
//! The shell owns windows, tray, global shortcuts, settings and the
//! recordings library. Real-time capture, compositing and encoding are
//! delegated to the CaptureDesk native engine (C++ sidecar under
//! `desktop-tauri/native`, shipped as a bundle resource).

mod commands;
mod engine;
mod library;
mod menu;
mod settings;
mod shortcuts;
mod state;
mod tray;
mod windows;

use tauri::{Emitter, Manager};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // A second launch (or a capturedesk:// deep link) focuses the
            // dashboard and honors an editor deep link when present.
            windows::focus_main(app);
            if let Some(file) = state::deep_link_file(&argv) {
                let _ = commands::open_editor_with_file(app, Some(file));
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        shortcuts::dispatch(app, shortcut);
                    }
                })
                .build(),
        )
        .manage(state::AppState::new())
        .manage(engine::EngineHandle::new())
        .invoke_handler(tauri::generate_handler![
            commands::app_get_version,
            commands::app_quit,
            commands::state_get,
            commands::sources_list,
            commands::rec_start,
            commands::rec_pause,
            commands::rec_resume,
            commands::rec_stop,
            commands::rec_cancel,
            commands::rec_ack,
            commands::rec_save,
            commands::rec_state_save,
            commands::cambubble_toggle,
            commands::region_begin,
            commands::region_selected,
            commands::settings_get,
            commands::settings_set,
            commands::library_list,
            commands::library_rename,
            commands::library_remove,
            commands::library_reveal,
            commands::library_dir,
            commands::library_pick_dir,
            commands::editor_open,
            commands::editor_take_pending,
            commands::fs_app_path,
            commands::fs_tmp_dir,
            commands::fs_recordings_dir,
            commands::fs_app_file_url,
            commands::fs_read_recording,
            commands::fs_write_file,
            commands::fs_unique_path,
            commands::shell_open_path,
            commands::transcode_file,
            commands::transcode_cancel,
            commands::engine_version,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            state::register_protocol(&handle)?;
            menu::install(&handle)?;
            // Engine unavailability (missing Media Foundation on N editions,
            // broken install, spawn failure) must not take the whole app
            // down — surface it as a persistent error state the UI shows.
            if let Err(e) = engine::spawn(&handle) {
                eprintln!("[CaptureDesk] engine unavailable: {e}");
                state::apply_engine_state(
                    &handle,
                    &serde_json::json!({
                        "state": "error",
                        "error": e,
                        "note": "engine-unavailable",
                    }),
                );
            }
            tray::create(&handle)?;
            shortcuts::register(&handle)?;
            windows::prepare(&handle)?;
            let _ = handle.emit_to("main", "capturedesk-ready", serde_json::json!({}));
            Ok(())
        })
        .on_window_event(|window, event| {
            let app = window.app_handle();
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if window.label() == "main" && settings::flag(app, "minimizeToTray", true) {
                        // Keep CaptureDesk alive in the tray.
                        api.prevent_close();
                        let _ = window.hide();
                    } else if window.label() == "region" {
                        // Alt+F4 (or a page window.close()) on the region
                        // picker always cancels it — never a dead trap.
                        windows::cancel_region(app);
                    }
                }
                tauri::WindowEvent::Focused(false) => {
                    if window.label() == "region" {
                        // The picker lost focus (Alt-Tab, toast, …): cancel
                        // after a short grace period so it can't hover on
                        // top of the desktop while the user works elsewhere.
                        windows::on_region_blur(app);
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("CaptureDesk failed to start");
}
