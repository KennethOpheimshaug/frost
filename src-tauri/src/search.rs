//! Quick-open file listing and text search. Both respect .gitignore.

use ignore::WalkBuilder;
use regex::RegexBuilder;
use serde::Serialize;
use std::io::{BufRead, BufReader};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    pub line: usize,
    pub column: usize,
    pub length: usize,
    pub text: String,
}

fn walker(root: &str) -> WalkBuilder {
    let mut b = WalkBuilder::new(root);
    b.hidden(false)
        .git_ignore(true)
        .git_global(true)
        .filter_entry(|e| {
            let n = e.file_name().to_string_lossy();
            !matches!(n.as_ref(), ".git" | "node_modules" | "bin" | "obj" | ".vs" | "target")
        });
    b
}

/// All files under `root` (up to `limit`), for the Ctrl+P fuzzy finder.
#[tauri::command]
pub async fn list_files(root: String, limit: Option<usize>) -> Result<Vec<String>, String> {
    let limit = limit.unwrap_or(50_000);
    tauri::async_runtime::spawn_blocking(move || {
        walker(&root)
            .build()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
            .take(limit)
            .map(|e| e.path().to_string_lossy().into_owned())
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Searches file contents line by line. Plain text unless `is_regex` is set.
#[tauri::command]
pub async fn search_text(
    root: String,
    query: String,
    is_regex: bool,
    case_sensitive: bool,
    max_results: Option<usize>,
) -> Result<Vec<SearchMatch>, String> {
    if query.is_empty() {
        return Ok(vec![]);
    }
    let pattern = if is_regex { query } else { regex::escape(&query) };
    let re = RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|e| e.to_string())?;
    let max = max_results.unwrap_or(2_000);

    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        for entry in walker(&root).build().filter_map(|e| e.ok()) {
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            let Ok(file) = std::fs::File::open(entry.path()) else { continue };
            let reader = BufReader::new(file);
            for (i, line) in reader.split(b'\n').enumerate() {
                let Ok(bytes) = line else { break };
                if bytes.contains(&0) {
                    break; // binary file
                }
                let text = String::from_utf8_lossy(&bytes);
                if let Some(m) = re.find(&text) {
                    let col = text[..m.start()].chars().count();
                    out.push(SearchMatch {
                        path: entry.path().to_string_lossy().into_owned(),
                        line: i + 1,
                        column: col + 1,
                        length: m.as_str().chars().count(),
                        text: text.trim_end().chars().take(300).collect(),
                    });
                    if out.len() >= max {
                        return out;
                    }
                }
            }
        }
        out
    })
    .await
    .map_err(|e| e.to_string())
}
