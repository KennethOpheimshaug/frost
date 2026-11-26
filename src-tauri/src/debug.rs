//! Support for debugging: finding/installing netcoredbg, asking MSBuild for the program
//! to launch, and listing processes for "Attach to Process".

use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager};

use crate::proc::which;

fn exe_name() -> &'static str {
    if cfg!(windows) { "netcoredbg.exe" } else { "netcoredbg" }
}

fn install_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("debuggers"))
}

/// Path of netcoredbg: the configured command, PATH, or the copy Frost installed.
#[tauri::command]
pub fn find_debugger(app: AppHandle, command: Option<String>) -> Option<String> {
    if let Some(p) = which(command.as_deref().unwrap_or("netcoredbg")) {
        return Some(p.to_string_lossy().into_owned());
    }
    let local = install_dir(&app).ok()?.join("netcoredbg").join(exe_name());
    local.is_file().then(|| local.to_string_lossy().into_owned())
}

/// Downloads the latest netcoredbg release from GitHub into the app's config folder.
#[tauri::command]
pub async fn install_netcoredbg(app: AppHandle) -> Result<String, String> {
    let dir = install_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let asset = if cfg!(windows) {
            "netcoredbg-win64.zip"
        } else if cfg!(target_os = "macos") {
            "netcoredbg-osx-amd64.tar.gz"
        } else if cfg!(target_arch = "aarch64") {
            "netcoredbg-linux-arm64.tar.gz"
        } else {
            "netcoredbg-linux-amd64.tar.gz"
        };
        let release: serde_json::Value = ureq::get("https://api.github.com/repos/Samsung/netcoredbg/releases/latest")
            .set("User-Agent", "Frost-IDE")
            .call()
            .map_err(|e| format!("Couldn't reach GitHub: {e}"))?
            .into_string()
            .map_err(|e| e.to_string())
            .and_then(|t| serde_json::from_str(&t).map_err(|e| e.to_string()))?;
        let url = release["assets"]
            .as_array()
            .and_then(|a| a.iter().find(|x| x["name"] == asset))
            .and_then(|x| x["browser_download_url"].as_str())
            .ok_or_else(|| format!("No {asset} in the latest netcoredbg release"))?
            .to_string();
        let mut bytes = Vec::new();
        ureq::get(&url)
            .set("User-Agent", "Frost-IDE")
            .call()
            .map_err(|e| format!("Download failed: {e}"))?
            .into_reader()
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_dir_all(dir.join("netcoredbg"));
        if asset.ends_with(".zip") {
            zip::ZipArchive::new(std::io::Cursor::new(bytes))
                .and_then(|mut z| z.extract(&dir))
                .map_err(|e| e.to_string())?;
        } else {
            tar::Archive::new(flate2::read::GzDecoder::new(std::io::Cursor::new(bytes)))
                .unpack(&dir)
                .map_err(|e| e.to_string())?;
        }
        let exe = dir.join("netcoredbg").join(exe_name());
        if !exe.is_file() {
            return Err("Downloaded netcoredbg, but couldn't find the program in it".into());
        }
        Ok(exe.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct Captured {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

/// Runs a short command and returns its output (used for `dotnet msbuild -getProperty:...`).
#[tauri::command]
pub async fn run_capture(command_name: String, args: Vec<String>, cwd: Option<String>) -> Result<Captured, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let exe = which(&command_name).ok_or_else(|| format!("'{command_name}' was not found on PATH"))?;
        let mut c = Command::new(exe);
        c.args(&args)
            .env("DOTNET_CLI_UI_LANGUAGE", "en")
            .env("DOTNET_NOLOGO", "1")
            // git: fail instead of waiting for a password prompt nobody can see.
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C");
        if let Some(d) = cwd.as_deref().filter(|d| Path::new(d).is_dir()) {
            c.current_dir(d);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x0800_0000);
        }
        let out = c.output().map_err(|e| e.to_string())?;
        Ok(Captured {
            code: out.status.code(),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct ProcessInfo {
    pid: u32,
    name: String,
    command: String,
}

/// Running processes, .NET-looking ones first, for "Attach to Process".
#[tauri::command]
pub async fn list_processes() -> Vec<ProcessInfo> {
    tauri::async_runtime::spawn_blocking(|| {
        let Ok(mut sys) = sysinfo::System::new() else { return vec![] };
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        let mut list: Vec<ProcessInfo> = sys
            .processes()
            .values()
            .map(|p| ProcessInfo {
                pid: p.pid().as_u32(),
                name: p.name().to_string_lossy().into_owned(),
                command: p.cmd().iter().map(|s| s.to_string_lossy()).collect::<Vec<_>>().join(" "),
            })
            .collect();
        let dotnetish = |p: &ProcessInfo| p.name.to_lowercase().contains("dotnet") || p.command.to_lowercase().contains(".dll");
        list.sort_by(|a, b| dotnetish(b).cmp(&dotnetish(a)).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        list
    })
    .await
    .unwrap_or_default()
}
