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

export interface FsChange {
  dirs: string[];
  paths: string[];
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
