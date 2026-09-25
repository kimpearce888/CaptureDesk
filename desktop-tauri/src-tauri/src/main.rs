//! CaptureDesk Desktop — Tauri entry point.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    capturedesk_lib::run();
}
