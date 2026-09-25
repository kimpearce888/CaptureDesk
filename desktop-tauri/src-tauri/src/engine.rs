//! CaptureDesk native engine sidecar.
//!
//! The engine is a C++ executable bundled under `resources/engine/`. It
//! speaks newline-delimited JSON on stdio:
//!
//! ```text
//! shell → engine : {"id":1,"cmd":"start","params":{...}}
//! engine → shell : {"id":1,"ok":true,"result":{...}}       (response)
//! engine → shell : {"ev":"state","state":"recording",...}   (async event)
//! ```
//!
//! Media bytes never cross this channel — the engine writes recordings and
//! exports to disk directly and reports progress via events.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

pub struct EngineHandle {
    stdin: Mutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<u64, Sender<Value>>>,
    next_id: AtomicU64,
}

impl EngineHandle {
    pub fn new() -> Self {
        Self {
            stdin: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        }
    }
}

fn engine_path(app: &AppHandle) -> Result<PathBuf, String> {
    let res = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource dir: {e}"))?;
    let name = if cfg!(windows) {
        "capturedesk-engine.exe"
    } else {
        "capturedesk-engine"
    };
    Ok(res.join("engine").join(name))
}

/// Spawn the engine sidecar and start the reader thread.
pub fn spawn(app: &AppHandle) -> Result<(), String> {
    let exe = engine_path(app)?;
    if !exe.exists() {
        eprintln!(
            "[CaptureDesk] engine sidecar missing at {} — capture and export commands will fail",
            exe.display()
        );
        return Ok(());
    }
    let mut cmd = Command::new(&exe);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| format!("engine spawn: {e}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "engine stdout unavailable".to_string())?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "engine stdin unavailable".to_string())?;
    {
        let st = app.state::<EngineHandle>();
        *st.stdin.lock().unwrap() = Some(stdin);
    }
    let h = app.clone();
    std::thread::spawn(move || reader_loop(stdout, h));
    Ok(())
}

fn reader_loop(stdout: ChildStdout, app: AppHandle) {
    let reader = BufReader::new(stdout);
    for line in reader.lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if v.get("ev").is_some() {
            // Exports resolve their pending request via an id-tagged
            // done/error event; untagged events are broadcast to the UI.
            let via_event = match v.get("id").and_then(Value::as_u64) {
                Some(id) => {
                    let st = app.state::<EngineHandle>();
                    let resolved = st
                        .pending
                        .lock()
                        .unwrap()
                        .remove(&id)
                        .map(|tx| tx.send(v.clone()))
                        .is_some();
                    resolved
                }
                None => false,
            };
            if !via_event {
                handle_event(&app, v);
            }
        } else if let Some(id) = v.get("id").and_then(Value::as_u64) {
            let st = app.state::<EngineHandle>();
            let tx = st.pending.lock().unwrap().remove(&id);
            if let Some(tx) = tx {
                let _ = tx.send(v);
            }
        }
    }
    eprintln!("[CaptureDesk] engine exited");
    let _ = app.emit(
        "rec-state",
        json!({ "state": "idle", "note": "CaptureDesk engine stopped" }),
    );
}

fn handle_event(app: &AppHandle, v: Value) {
    match v.get("ev").and_then(Value::as_str).unwrap_or("") {
        "state" => crate::state::apply_engine_state(app, &v),
        "done" => {
            if let Some(file) = v.get("file").and_then(Value::as_str) {
                crate::state::session_done(app, file);
            }
        }
        "progress" => {
            let _ = app.emit(
                "export-progress",
                json!({
                    "ratio": v.get("ratio").cloned().unwrap_or(json!(0)),
                    "message": v.get("message").cloned().unwrap_or(json!("Working…")),
                }),
            );
        }
        "error" => crate::state::apply_engine_state(
            app,
            &json!({
                "state": "error",
                "error": v.get("message").cloned().unwrap_or(json!("Engine error")),
            }),
        ),
        "log" => eprintln!(
            "[engine] {}",
            v.get("line").and_then(Value::as_str).unwrap_or("")
        ),
        _ => {}
    }
}

/// Send a command and await its response.
pub fn request(app: &AppHandle, cmd: &str, params: Value, timeout_ms: u64) -> Result<Value, String> {
    let st = app.state::<EngineHandle>();
    let id = st.next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx): (Sender<Value>, Receiver<Value>) = channel();
    st.pending.lock().unwrap().insert(id, tx);
    let write = {
        let mut guard = st.stdin.lock().unwrap();
        match guard.as_mut() {
            Some(stdin) => {
                let line = json!({ "id": id, "cmd": cmd, "params": params });
                writeln!(stdin, "{line}")
                    .and_then(|_| stdin.flush())
                    .map_err(|e| format!("engine write: {e}"))
            }
            None => Err("CaptureDesk engine is not running".to_string()),
        }
    };
    if let Err(e) = write {
        // Don't leak the pending slot when the request never reached the engine.
        st.pending.lock().unwrap().remove(&id);
        return Err(e);
    }
    match rx.recv_timeout(Duration::from_millis(timeout_ms)) {
        Ok(v) => Ok(v),
        Err(_) => {
            st.pending.lock().unwrap().remove(&id);
            Err("CaptureDesk engine timed out".into())
        }
    }
}
