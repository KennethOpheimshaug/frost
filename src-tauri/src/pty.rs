//! Real terminals (ConPTY on Windows) for the built-in terminal panel.

use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use tauri::{AppHandle, Emitter, State};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyState(Mutex<HashMap<String, Session>>);

fn default_shell() -> String {
    if cfg!(windows) {
        // Prefer PowerShell 7 if installed, else Windows PowerShell.
        if which("pwsh.exe") { "pwsh.exe".into() } else { "powershell.exe".into() }
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
    }
}

fn which(exe: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|p| p.join(exe).is_file()))
        .unwrap_or(false)
}

/// Starts a shell (or `command` if given) in `cwd`. Output arrives as `pty-data` events,
/// exit as `pty-exit`. `env` lets callers pass variables (used later for Claude Code).
#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<PtyState>,
    id: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    command: Option<String>,
    args: Option<Vec<String>>,
    env: Option<HashMap<String, String>>,
) -> Result<(), String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(command.unwrap_or_else(default_shell));
    for a in args.unwrap_or_default() {
        cmd.arg(a);
    }
    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    for (k, v) in env.unwrap_or_default() {
        cmd.env(k, v);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let evt_id = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    // Only send complete UTF-8; keep a split multi-byte char for the next read.
                    let valid = match std::str::from_utf8(&pending) {
                        Ok(_) => pending.len(),
                        Err(e) if e.error_len().is_none() => e.valid_up_to(),
                        Err(_) => pending.len(),
                    };
                    let chunk: Vec<u8> = pending.drain(..valid).collect();
                    let text = String::from_utf8_lossy(&chunk).into_owned();
                    let _ = app.emit("pty-data", (evt_id.clone(), text));
                }
            }
        }
        let _ = app.emit("pty-exit", evt_id);
    });

    state.0.lock().insert(id, Session { master: pair.master, writer, child });
    Ok(())
}

#[tauri::command]
pub fn pty_write(state: State<PtyState>, id: String, data: String) -> Result<(), String> {
    let mut map = state.0.lock();
    let s = map.get_mut(&id).ok_or("No such terminal")?;
    s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(state: State<PtyState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let map = state.0.lock();
    let s = map.get(&id).ok_or("No such terminal")?;
    s.master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(state: State<PtyState>, id: String) -> Result<(), String> {
    if let Some(mut s) = state.0.lock().remove(&id) {
        let _ = s.child.kill();
    }
    Ok(())
}
