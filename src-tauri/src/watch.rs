//! Watches the open folder and tells the frontend which directories changed.

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct WatchState(Mutex<Option<RecommendedWatcher>>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FsChange {
    /// Directories whose contents changed (parents of the changed paths).
    dirs: Vec<String>,
    /// The changed paths themselves (used to reload open files).
    paths: Vec<String>,
    created: Vec<String>,
    removed: Vec<String>,
}

const IGNORED: [&str; 6] = [".git", "node_modules", "bin", "obj", "target", ".vs"];

fn ignored(p: &Path) -> bool {
    p.components()
        .any(|c| IGNORED.contains(&c.as_os_str().to_string_lossy().as_ref()))
}

/// Starts watching `path` recursively, replacing any previous watch.
/// Events are batched for 100 ms so a `git checkout` doesn't flood the UI.
#[tauri::command]
pub fn watch_folder(app: AppHandle, state: State<WatchState>, path: String) -> Result<(), String> {
    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(tx).map_err(|e| e.to_string())?;
    watcher
        .watch(Path::new(&path), RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut paths = HashSet::new();
            let mut created = HashSet::new();
            let mut removed = HashSet::new();
            let mut collect = |res: notify::Result<notify::Event>| {
                if let Ok(ev) = res {
                    for p in ev.paths {
                        if ignored(&p) {
                            continue;
                        }
                        match ev.kind {
                            notify::EventKind::Create(_) => {
                                removed.remove(&p);
                                created.insert(p.clone());
                            }
                            notify::EventKind::Remove(_) => {
                                created.remove(&p);
                                removed.insert(p.clone());
                            }
                            _ => {}
                        }
                        paths.insert(p);
                    }
                }
            };
            collect(first);
            while let Ok(more) = rx.recv_timeout(Duration::from_millis(100)) {
                collect(more);
            }
            if paths.is_empty() {
                continue;
            }
            let dirs: HashSet<String> = paths
                .iter()
                .filter_map(|p| p.parent().map(|d| d.to_string_lossy().into_owned()))
                .collect();
            let change = FsChange {
                dirs: dirs.into_iter().collect(),
                paths: paths.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
                created: created.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
                removed: removed.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
            };
            if app.emit("fs-change", change).is_err() {
                break;
            }
        }
    });

    // Dropping the old watcher closes its channel, which ends its thread.
    *state.0.lock() = Some(watcher);
    Ok(())
}
