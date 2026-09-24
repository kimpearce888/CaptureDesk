//! Native application menu (macOS only; Windows/Linux use the tray).

use tauri::menu::{Menu, MenuItem, Submenu};
use tauri::{AppHandle, Manager};

pub fn install(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    if cfg!(target_os = "macos") {
        let about = MenuItem::with_id(app, "about", "About CaptureDesk", true, None::<&str>)?;
        let first = Submenu::with_items(app, "CaptureDesk", true, &[&about])?;
        let quit = MenuItem::with_id(app, "quit", "Quit CaptureDesk", true, None::<&str>)?;
        let second = Submenu::with_items(app, "File", true, &[&quit])?;
        let menu = Menu::with_items(app, &[&first, &second])?;
        app.set_menu(menu)?;
    }
    Ok(())
}
