//! .NET awareness: SDK detection and reading solutions/projects for the Solution view.
//! Files are read with simple patterns; a proper MSBuild-backed model comes with the build host.

use regex::Regex;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::LazyLock;

use crate::proc::which;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DotnetInfo {
    /// `dotnet --version`, or None when the SDK isn't installed.
    pub sdk: Option<String>,
    /// Path of the Roslyn language server, if found.
    pub roslyn: Option<String>,
}

#[tauri::command]
pub async fn dotnet_info(roslyn_command: Option<String>) -> DotnetInfo {
    tauri::async_runtime::spawn_blocking(move || {
        let sdk = which("dotnet").and_then(|exe| {
            let mut c = Command::new(exe);
            c.arg("--version");
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                c.creation_flags(0x0800_0000);
            }
            let out = c.output().ok()?;
            out.status
                .success()
                .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
        });
        let roslyn = which(roslyn_command.as_deref().unwrap_or("roslyn-language-server"))
            .map(|p| p.to_string_lossy().into_owned());
        DotnetInfo { sdk, roslyn }
    })
    .await
    .unwrap_or(DotnetInfo { sdk: None, roslyn: None })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub solutions: Vec<String>,
    pub projects: Vec<String>,
}

/// Finds .sln/.slnx files (up to 3 levels deep) and .csproj files (up to 6) under `root`.
#[tauri::command]
pub async fn find_dotnet_workspace(root: String) -> Workspace {
    tauri::async_runtime::spawn_blocking(move || {
        let mut solutions = vec![];
        let mut projects = vec![];
        let walker = ignore::WalkBuilder::new(&root)
            .max_depth(Some(6))
            .filter_entry(|e| {
                let n = e.file_name().to_string_lossy();
                !matches!(n.as_ref(), ".git" | "node_modules" | "bin" | "obj" | ".vs" | "target")
            })
            .build();
        for e in walker.filter_map(|e| e.ok()) {
            let p = e.path();
            let ext = p.extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
            if (ext == "sln" || ext == "slnx") && e.depth() <= 3 {
                solutions.push(p.to_string_lossy().into_owned());
            } else if ext == "csproj" || ext == "fsproj" || ext == "vbproj" {
                projects.push(p.to_string_lossy().into_owned());
            }
        }
        // Shallowest solution first: that's usually the main one.
        solutions.sort_by_key(|s| (s.matches(['/', '\\']).count(), s.to_lowercase()));
        projects.sort();
        Workspace { solutions, projects }
    })
    .await
    .unwrap_or(Workspace { solutions: vec![], projects: vec![] })
}

fn resolve(base: &Path, rel: &str) -> PathBuf {
    let rel = rel.replace('\\', std::path::MAIN_SEPARATOR_STR).replace('/', std::path::MAIN_SEPARATOR_STR);
    let joined = base.join(rel);
    std::fs::canonicalize(&joined)
        .map(|p| {
            let s = p.to_string_lossy().into_owned();
            PathBuf::from(s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s))
        })
        .unwrap_or(joined)
}

static SLN_PROJECT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"Project\("\{([^}]+)\}"\)\s*=\s*"([^"]+)",\s*"([^"]+)""#).unwrap());
static SLNX_PROJECT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"<Project\s+[^>]*Path="([^"]+)""#).unwrap());
const SOLUTION_FOLDER: &str = "2150E333-8FDC-42A3-9474-1A3956D46DE8";

/// Project file paths listed in a solution (solution folders left out).
#[tauri::command]
pub fn read_solution(path: String) -> Result<Vec<String>, String> {
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let base = Path::new(&path).parent().unwrap_or(Path::new("."));
    let rels: Vec<String> = if path.to_lowercase().ends_with(".slnx") {
        SLNX_PROJECT.captures_iter(&text).map(|c| c[1].to_string()).collect()
    } else {
        SLN_PROJECT
            .captures_iter(&text)
            .filter(|c| !c[1].eq_ignore_ascii_case(SOLUTION_FOLDER))
            .map(|c| c[3].to_string())
            .collect()
    };
    Ok(rels
        .iter()
        .filter(|r| r.ends_with("proj"))
        .map(|r| resolve(base, r).to_string_lossy().into_owned())
        .collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageRef {
    pub name: String,
    pub version: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub name: String,
    pub path: String,
    pub dir: String,
    pub sdk: Option<String>,
    pub output_type: Option<String>,
    pub target_frameworks: Vec<String>,
    pub packages: Vec<PackageRef>,
    pub project_refs: Vec<String>,
    pub is_test: bool,
    pub is_runnable: bool,
}

static SDK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"<Project\s+[^>]*Sdk="([^"]+)""#).unwrap());
static OUTPUT_TYPE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<OutputType>\s*([^<\s]+)\s*</OutputType>").unwrap());
static TFM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<TargetFrameworks?>\s*([^<]+?)\s*</TargetFrameworks?>").unwrap());
static PACKAGE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"<PackageReference\s+[^>]*Include="([^"]+)"(?:[^>]*Version="([^"]+)")?"#).unwrap()
});
static PROJECT_REF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"<ProjectReference\s+[^>]*Include="([^"]+)""#).unwrap());
static IS_TEST: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<IsTestProject>\s*true\s*</IsTestProject>").unwrap());

#[tauri::command]
pub fn read_project(path: String) -> Result<ProjectInfo, String> {
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let p = Path::new(&path);
    let dir = p.parent().unwrap_or(Path::new("."));
    let name = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let sdk = SDK.captures(&text).map(|c| c[1].to_string());
    let output_type = OUTPUT_TYPE.captures(&text).map(|c| c[1].to_string());
    let target_frameworks = TFM
        .captures(&text)
        .map(|c| c[1].split(';').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();
    let packages: Vec<PackageRef> = PACKAGE
        .captures_iter(&text)
        .map(|c| PackageRef { name: c[1].to_string(), version: c.get(2).map(|m| m.as_str().to_string()) })
        .collect();
    let project_refs = PROJECT_REF
        .captures_iter(&text)
        .map(|c| resolve(dir, &c[1]).to_string_lossy().into_owned())
        .collect();
    let is_test = IS_TEST.is_match(&text)
        || packages.iter().any(|p| p.name == "Microsoft.NET.Test.Sdk" || p.name.starts_with("xunit.v3") || p.name == "TUnit");
    let sdk_runs = sdk.as_deref().is_some_and(|s| s.contains(".Web") || s.contains(".Worker") || s.contains("Aspire") || s.contains("Blazor"));
    let ot = output_type.as_deref().unwrap_or("").to_lowercase();
    let is_runnable = !is_test && (ot == "exe" || ot == "winexe" || (sdk_runs && ot != "library"));
    Ok(ProjectInfo {
        name,
        path: path.clone(),
        dir: dir.to_string_lossy().into_owned(),
        sdk,
        output_type,
        target_frameworks,
        packages,
        project_refs,
        is_test,
        is_runnable,
    })
}
