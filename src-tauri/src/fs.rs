//! File system commands used by the explorer and the editor.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

fn to_string(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Lists one directory level: folders first, then files, both alphabetical (case-insensitive).
#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut entries: Vec<DirEntry> = fs::read_dir(&path)
        .map_err(err)?
        .filter_map(|e| e.ok())
        .map(|e| {
            let p = e.path();
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            DirEntry {
                name: e.file_name().to_string_lossy().into_owned(),
                path: to_string(&p),
                is_dir,
            }
        })
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(err)?;
    if bytes.iter().take(8000).any(|b| *b == 0) {
        return Err("Binary file, can't open it in the editor".into());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    fs::write(&path, contents).map_err(err)
}

#[tauri::command]
pub fn create_file(path: String) -> Result<(), String> {
    if Path::new(&path).exists() {
        return Err("A file or folder with that name already exists".into());
    }
    write_text_file(path, String::new())
}

#[tauri::command]
pub fn create_dir(path: String) -> Result<(), String> {
    if Path::new(&path).exists() {
        return Err("A file or folder with that name already exists".into());
    }
    fs::create_dir_all(&path).map_err(err)
}

/// Renames or moves a file or folder. Refuses to overwrite.
#[tauri::command]
pub fn rename_path(from: String, to: String) -> Result<(), String> {
    let to_path = PathBuf::from(&to);
    if to_path.exists() {
        return Err("A file or folder with that name already exists".into());
    }
    if Path::new(&to).starts_with(&from) {
        return Err("Can't move a folder into itself".into());
    }
    fs::rename(&from, &to_path).map_err(err)
}

#[tauri::command]
pub fn delete_path(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.is_dir() {
        fs::remove_dir_all(p).map_err(err)
    } else {
        fs::remove_file(p).map_err(err)
    }
}

/// Folder that holds settings.json and user themes. Created on first use.
#[tauri::command]
pub fn config_dir(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let dir = app.path().app_config_dir().map_err(err)?;
    fs::create_dir_all(dir.join("themes")).map_err(err)?;
    Ok(to_string(&dir))
}

/// A folder passed on the command line (`frost C:\code\MyApp`), if any.
#[tauri::command]
pub fn startup_folder() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|a| !a.starts_with('-') && Path::new(a).is_dir())
        .and_then(|a| fs::canonicalize(&a).ok())
        .map(|p| {
            let s = to_string(&p);
            // Strip Windows' \\?\ prefix from canonicalize.
            s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s)
        })
}
