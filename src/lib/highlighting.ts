// Monaco setup + VS Code themes and TextMate grammars (through Shiki).
import * as monaco from "./monaco-core";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import { createHighlighter, bundledThemesInfo, type Highlighter } from "shiki";
import { shikiToMonaco } from "@shikijs/monaco";
import { api, basename, join } from "./api";
import { parseJsonc, type Settings } from "./settings";

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

export { monaco };

export interface ThemeInfo {
  label: string;
  type: "dark" | "light";
  source: "builtin" | "user";
  /** Shiki id for built-in themes, file path for user themes. */
  ref: string;
}

export interface ActiveTheme {
  label: string;
  type: "dark" | "light";
  colors: Record<string, string>;
}

let highlighter: Highlighter | null = null;
const registeredLangs = new Set<string>();
let themeCounter = 0;
let currentMonacoTheme = "";

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighter) highlighter = await createHighlighter({ themes: [], langs: [] });
  return highlighter;
}

function syncMonaco(h: Highlighter) {
  for (const id of h.getLoadedLanguages()) {
    if (!registeredLangs.has(id)) {
      monaco.languages.register({ id });
      registeredLangs.add(id);
    }
  }
  shikiToMonaco(h, monaco as never);
  if (currentMonacoTheme) monaco.editor.setTheme(currentMonacoTheme);
}

/** Loads the TextMate grammar for `lang` the first time it's needed. */
export async function ensureLanguage(lang: string): Promise<void> {
  if (lang === "plaintext") return;
  const h = await getHighlighter();
  if (h.getLoadedLanguages().includes(lang)) return;
  try {
    await h.loadLanguage(lang as never);
    syncMonaco(h);
  } catch (e) {
    console.warn(`No grammar for ${lang}`, e);
  }
}

/** Built-in themes plus any VS Code theme JSON files in <config>/themes. */
export async function listThemes(): Promise<ThemeInfo[]> {
  const builtin: ThemeInfo[] = bundledThemesInfo.map((t) => ({
    label: t.displayName,
    type: t.type === "light" ? "light" : "dark",
    source: "builtin",
    ref: t.id,
  }));
  const user: ThemeInfo[] = [];
  try {
    const dir = join(await api.configDir(), "themes");
    for (const e of await api.listDir(dir)) {
      if (e.isDir || !e.name.toLowerCase().endsWith(".json")) continue;
      try {
        const json = parseJsonc<{ name?: string; type?: string }>(await api.readFile(e.path));
        user.push({
          label: json.name ?? basename(e.path).replace(/\.json$/i, ""),
          type: json.type === "light" ? "light" : "dark",
          source: "user",
          ref: e.path,
        });
      } catch {
        /* skip invalid theme files */
      }
    }
  } catch {
    /* no themes folder yet */
  }
  return [...user, ...builtin];
}

interface RawTheme {
  name?: string;
  type?: string;
  colors?: Record<string, string>;
  tokenColors?: unknown[];
  settings?: unknown[];
  semanticTokenColors?: Record<string, unknown>;
  include?: string;
}

async function loadRawTheme(info: ThemeInfo, h: Highlighter): Promise<RawTheme> {
  if (info.source === "builtin") {
    await h.loadTheme(info.ref as never);
    const t = h.getTheme(info.ref) as unknown as RawTheme;
    return { ...t, tokenColors: t.tokenColors ?? t.settings };
  }
  const raw = parseJsonc<RawTheme>(await api.readFile(info.ref));
  // VS Code themes may "include" a base theme file next to them.
  if (raw.include) {
    try {
      const base = parseJsonc<RawTheme>(
        await api.readFile(join(info.ref.replace(/[\\/][^\\/]*$/, ""), raw.include.replace(/^\.\//, ""))),
      );
      raw.colors = { ...base.colors, ...raw.colors };
      raw.tokenColors = [...(base.tokenColors ?? []), ...(raw.tokenColors ?? [])];
    } catch {
      /* ignore a missing base */
    }
  }
  return raw;
}

/**
 * Applies a theme to the editor and returns its colors for the rest of the UI.
 * `workbench.colorCustomizations` and `editor.tokenColorCustomizations` are layered on top,
 * including theme-scoped blocks like `"[Dark Plus]": { ... }`.
 */
export async function applyTheme(label: string, settings: Settings): Promise<ActiveTheme> {
  const h = await getHighlighter();
  const themes = await listThemes();
  const info = themes.find((t) => t.label === label) ?? themes.find((t) => t.ref === "dark-plus")!;
  const raw = await loadRawTheme(info, h);

  const cc = settings["workbench.colorCustomizations"] ?? {};
  const tc = settings["editor.tokenColorCustomizations"] ?? {};
  const scoped = (obj: Record<string, unknown>) => (obj[`[${info.label}]`] ?? {}) as Record<string, unknown>;
  const flat = (obj: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(obj).filter(([k, v]) => !k.startsWith("[") && typeof v === "string")) as Record<
      string,
      string
    >;

  const type: "dark" | "light" = raw.type === "light" ? "light" : info.type;
  const colors = { ...(raw.colors ?? {}), ...flat(cc), ...flat(scoped(cc)) };
  const rules = [
    ...((tc.textMateRules as unknown[]) ?? []),
    ...((scoped(tc as Record<string, unknown>).textMateRules as unknown[]) ?? []),
  ];

  const name = `active-theme-${++themeCounter}`;
  await h.loadTheme({
    ...raw,
    name,
    type,
    colors,
    tokenColors: [...(raw.tokenColors ?? []), ...rules],
  } as never);
  currentMonacoTheme = name;
  syncMonaco(h);
  monaco.editor.setTheme(name);
  return { label: info.label, type, colors };
}

/** Copies a VS Code theme JSON into <config>/themes and returns its label. */
export async function importThemeFile(path: string): Promise<string> {
  const text = await api.readFile(path);
  const json = parseJsonc<{ name?: string }>(text);
  const target = join(join(await api.configDir(), "themes"), basename(path));
  await api.writeFile(target, text);
  return json.name ?? basename(path).replace(/\.json$/i, "");
}
