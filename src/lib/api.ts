// Typed wrappers around the Rust commands in src-tauri/src.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  length: number;
  text: string;
}

export interface DotnetInfo {
  sdk: string | null;
  roslyn: string | null;
}

export interface ProjectInfo {
  name: string;
  path: string;
  dir: string;
  sdk: string | null;
  outputType: string | null;
  targetFrameworks: string[];
  packages: { name: string; version: string | null }[];
  projectRefs: string[];
  isTest: boolean;
  isRunnable: boolean;
}

export interface FsChange {
  dirs: string[];
  paths: string[];
  created: string[];
  removed: string[];
}

export const api = {
  listDir: (path: string) => invoke<DirEntry[]>("list_dir", { path }),
  readFile: (path: string) => invoke<string>("read_text_file", { path }),
  writeFile: (path: string, contents: string) => invoke<void>("write_text_file", { path, contents }),
  createFile: (path: string) => invoke<void>("create_file", { path }),
  createDir: (path: string) => invoke<void>("create_dir", { path }),
  rename: (from: string, to: string) => invoke<void>("rename_path", { from, to }),
  remove: (path: string) => invoke<void>("delete_path", { path }),
  configDir: () => invoke<string>("config_dir"),
  startupFolder: () => invoke<string | null>("startup_folder"),
  watchFolder: (path: string) => invoke<void>("watch_folder", { path }),
  listFiles: (root: string, limit?: number) => invoke<string[]>("list_files", { root, limit }),
  searchText: (root: string, query: string, isRegex: boolean, caseSensitive: boolean) =>
    invoke<SearchMatch[]>("search_text", { root, query, isRegex, caseSensitive, maxResults: 2000 }),
  ptySpawn: (opts: {
    id: string;
    cwd?: string;
    cols: number;
    rows: number;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
  }) => invoke<void>("pty_spawn", opts),
  ptyWrite: (id: string, data: string) => invoke<void>("pty_write", { id, data }),
  ptyResize: (id: string, cols: number, rows: number) => invoke<void>("pty_resize", { id, cols, rows }),
  ptyKill: (id: string) => invoke<void>("pty_kill", { id }),
  dotnetInfo: (roslynCommand?: string) => invoke<DotnetInfo>("dotnet_info", { roslynCommand }),
  findDotnetWorkspace: (root: string) =>
    invoke<{ solutions: string[]; projects: string[] }>("find_dotnet_workspace", { root }),
  readSolution: (path: string) => invoke<string[]>("read_solution", { path }),
  readProject: (path: string) => invoke<ProjectInfo>("read_project", { path }),
  lspStart: (id: string, commandName: string, args: string[], cwd?: string) =>
    invoke<string>("lsp_start", { id, commandName, args, cwd }),
  lspSend: (id: string, message: string) => invoke<void>("lsp_send", { id, message }),
  procStart: (id: string, commandName: string, args: string[], cwd?: string, env?: Record<string, string>) =>
    invoke<void>("proc_start", { id, commandName, args, cwd, env }),
  procKill: (id: string) => invoke<void>("proc_kill", { id }),
  onLspMessage: (cb: (id: string, json: string) => void): Promise<UnlistenFn> =>
    listen<[string, string]>("lsp-message", (e) => cb(e.payload[0], e.payload[1])),
  onProcLine: (cb: (id: string, stream: "stdout" | "stderr", line: string) => void): Promise<UnlistenFn> =>
    listen<[string, "stdout" | "stderr", string]>("proc-line", (e) => cb(...e.payload)),
  onProcExit: (cb: (id: string, code: number | null) => void): Promise<UnlistenFn> =>
    listen<[string, number | null]>("proc-exit", (e) => cb(e.payload[0], e.payload[1])),
  onFsChange: (cb: (c: FsChange) => void): Promise<UnlistenFn> =>
    listen<FsChange>("fs-change", (e) => cb(e.payload)),
  onPtyData: (cb: (id: string, data: string) => void): Promise<UnlistenFn> =>
    listen<[string, string]>("pty-data", (e) => cb(e.payload[0], e.payload[1])),
  onPtyExit: (cb: (id: string) => void): Promise<UnlistenFn> =>
    listen<string>("pty-exit", (e) => cb(e.payload)),
};

// --- path helpers (work with both \ and /) ---

export const sep = (p: string) => (p.includes("\\") ? "\\" : "/");
export const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
export const dirname = (p: string) => {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : p;
};
export const join = (dir: string, name: string) =>
  dir.endsWith("/") || dir.endsWith("\\") ? dir + name : dir + sep(dir) + name;
export const relative = (root: string, p: string) =>
  p.startsWith(root) ? p.slice(root.length).replace(/^[\\/]/, "") : p;
export const samePath = (a: string, b: string) =>
  a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
