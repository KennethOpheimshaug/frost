//! Child processes that aren't terminals: language servers (LSP framing over stdio)
//! and tools whose output we read line by line (`dotnet build`, ...).

use parking_lot::Mutex;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use tauri::{AppHandle, Emitter, State};

struct Proc {
    child: Child,
    stdin: Option<ChildStdin>,
}

#[derive(Default)]
pub struct ProcState(Mutex<HashMap<String, Proc>>);

/// Finds an executable on PATH, also looking in ~/.dotnet/tools (where `dotnet tool install -g`
/// puts tools, which apps started from the Start menu don't always have on PATH).
pub fn which(cmd: &str) -> Option<PathBuf> {
    let p = PathBuf::from(cmd);
    if p.is_absolute() {
        return p.is_file().then_some(p);
    }
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|v| std::env::split_paths(&v).collect())
        .unwrap_or_default();
    if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
        dirs.push(PathBuf::from(home).join(".dotnet").join("tools"));
    }
    let exts: Vec<String> = if cfg!(windows) {
        vec![".exe".into(), ".cmd".into(), ".bat".into(), String::new()]
    } else {
        vec![String::new()]
    };
    for d in dirs {
        for e in &exts {
            let f = d.join(format!("{cmd}{e}"));
            if f.is_file() {
                return Some(f);
            }
        }
    }
    None
}

fn command(cmd: &str, args: &[String], cwd: Option<&str>, env: &HashMap<String, String>) -> Result<Command, String> {
    let exe = which(cmd).ok_or_else(|| format!("'{cmd}' was not found on PATH"))?;
    let mut c = Command::new(exe);
    c.args(args);
    if let Some(d) = cwd {
        c.current_dir(d);
    }
    for (k, v) in env {
        c.env(k, v);
    }
    // English, no logo: keeps .NET tool output predictable so we can parse it.
    c.env("DOTNET_CLI_UI_LANGUAGE", "en");
    c.env("DOTNET_NOLOGO", "1");
    c.env("DOTNET_CLI_TELEMETRY_OPTOUT", "1");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    Ok(c)
}

fn forward_stderr(app: AppHandle, id: String, stderr: impl Read + Send + 'static) {
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = app.emit("proc-line", (&id, "stderr", line));
        }
    });
}

fn watch_exit(app: AppHandle, state_id: String) {
    std::thread::spawn(move || {
        use tauri::Manager;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(200));
            let state = app.state::<ProcState>();
            let mut map = state.0.lock();
            let Some(p) = map.get_mut(&state_id) else { return };
            if let Ok(Some(status)) = p.child.try_wait() {
                map.remove(&state_id);
                drop(map);
                let _ = app.emit("proc-exit", (&state_id, status.code()));
                return;
            }
        }
    });
}

/// Starts a language server. Each JSON-RPC message it sends arrives as an `lsp-message` event.
#[tauri::command]
pub fn lsp_start(
    app: AppHandle,
    state: State<ProcState>,
    id: String,
    command_name: String,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    let mut c = command(&command_name, &args, cwd.as_deref(), &HashMap::new())?;
    let exe = c.get_program().to_string_lossy().into_owned();
    let mut child = c
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't start {command_name}: {e}"))?;
    let stdout = child.stdout.take().unwrap();
    forward_stderr(app.clone(), id.clone(), child.stderr.take().unwrap());
    let stdin = child.stdin.take();

    let evt_app = app.clone();
    let evt_id = id.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            // Headers, then a blank line, then Content-Length bytes of JSON.
            let mut len: Option<usize> = None;
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => return,
                    Ok(_) => {}
                }
                let line = line.trim_end();
                if line.is_empty() {
                    break;
                }
                if let Some(v) = line.strip_prefix("Content-Length:") {
                    len = v.trim().parse().ok();
                }
            }
            let Some(len) = len else { continue };
            let mut body = vec![0u8; len];
            if reader.read_exact(&mut body).is_err() {
                return;
            }
            let _ = evt_app.emit("lsp-message", (&evt_id, String::from_utf8_lossy(&body)));
        }
    });

    state.0.lock().insert(id.clone(), Proc { child, stdin });
    watch_exit(app, id);
    Ok(exe)
}

#[tauri::command]
pub fn lsp_send(state: State<ProcState>, id: String, message: String) -> Result<(), String> {
    let mut map = state.0.lock();
    let p = map.get_mut(&id).ok_or("Language server is not running")?;
    let stdin = p.stdin.as_mut().ok_or("No stdin")?;
    write!(stdin, "Content-Length: {}\r\n\r\n{}", message.len(), message).map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())
}

/// Runs a tool and streams its output as `proc-line` events, then `proc-exit` with the exit code.
#[tauri::command]
pub fn proc_start(
    app: AppHandle,
    state: State<ProcState>,
    id: String,
    command_name: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
) -> Result<(), String> {
    let mut child = command(&command_name, &args, cwd.as_deref(), &env.unwrap_or_default())?
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't start {command_name}: {e}"))?;
    let stdout = child.stdout.take().unwrap();
    forward_stderr(app.clone(), id.clone(), child.stderr.take().unwrap());
    let evt_app = app.clone();
    let evt_id = id.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = evt_app.emit("proc-line", (&evt_id, "stdout", line));
        }
    });
    state.0.lock().insert(id.clone(), Proc { child, stdin: None });
    watch_exit(app, id);
    Ok(())
}

/// Stops a process and, on Windows, its child processes too (MSBuild starts worker nodes).
#[tauri::command]
pub fn proc_kill(state: State<ProcState>, id: String) -> Result<(), String> {
    let mut map = state.0.lock();
    if let Some(p) = map.get_mut(&id) {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let _ = Command::new("taskkill")
                .args(["/T", "/F", "/PID", &p.child.id().to_string()])
                .creation_flags(0x0800_0000)
                .status();
        }
        let _ = p.child.kill();
    }
    Ok(())
}
