// User settings, stored as settings.json (JSON with comments) in the app config folder.
// Keys follow VS Code's names so people can paste their existing settings.
import { api, join } from "./api";

export interface TokenColorRule {
  scope?: string | string[];
  name?: string;
  settings: { foreground?: string; background?: string; fontStyle?: string };
}

export interface Settings {
  "workbench.colorTheme": string;
  "workbench.colorCustomizations": Record<string, unknown>;
  "editor.tokenColorCustomizations": { textMateRules?: TokenColorRule[] } & Record<string, unknown>;
  "workbench.density": "compact" | "comfortable";
  /** What Frost shows when it starts: the welcome screen, or the last opened folder. */
  "workbench.startupEditor": "welcome" | "lastFolder";
  "editor.fontSize": number;
  "editor.fontFamily": string;
  "editor.fontLigatures": boolean;
  "editor.tabSize": number;
  "editor.insertSpaces": boolean;
  "editor.wordWrap": "off" | "on";
  "editor.minimap.enabled": boolean;
  "editor.lineNumbers": "on" | "off" | "relative";
  "files.autoSave": "off" | "afterDelay" | "onFocusChange";
  "files.autoSaveDelay": number;
  "terminal.integrated.fontSize": number;
  "terminal.integrated.fontFamily": string;
  "terminal.integrated.shell": string | null;
  /** Command or full path of the Roslyn language server. */
  "dotnet.languageServer.command": string;
  /** Turn C# language features off (e.g. on very large solutions). */
  "dotnet.languageServer.enabled": boolean;
  /** Build before Run (dotnet run builds anyway; this shows errors in Problems first). */
  "dotnet.buildBeforeRun": boolean;
  /** Full path of netcoredbg, if it isn't on PATH (Frost can also download it). */
  "dotnet.debugger.path": string | null;
}

export const defaultSettings: Settings = {
  "workbench.colorTheme": "Dark Plus",
  "workbench.colorCustomizations": {},
  "editor.tokenColorCustomizations": {},
  "workbench.density": "compact",
  "workbench.startupEditor": "welcome",
  "editor.fontSize": 14,
  "editor.fontFamily": "'Cascadia Code', 'JetBrains Mono', Consolas, 'Courier New', monospace",
  "editor.fontLigatures": true,
  "editor.tabSize": 4,
  "editor.insertSpaces": true,
  "editor.wordWrap": "off",
  "editor.minimap.enabled": true,
  "editor.lineNumbers": "on",
  "files.autoSave": "off",
  "files.autoSaveDelay": 1000,
  "terminal.integrated.fontSize": 13,
  "terminal.integrated.fontFamily": "'Cascadia Mono', Consolas, monospace",
  "terminal.integrated.shell": null,
  "dotnet.languageServer.command": "roslyn-language-server",
  "dotnet.languageServer.enabled": true,
  "dotnet.buildBeforeRun": true,
  "dotnet.debugger.path": null,
};

const template = (s: Settings) => `// Frost settings. Keys use VS Code's names.
// Save this file (Ctrl+S) to apply changes.
//
// Theme colors can be overridden like in VS Code, for example:
//   "workbench.colorCustomizations": { "sideBar.background": "#1b1d23" },
//   "editor.tokenColorCustomizations": {
//     "textMateRules": [{ "scope": "comment", "settings": { "foreground": "#6a9955", "fontStyle": "italic" } }]
//   }
${JSON.stringify(s, null, 2)}
`;

/** Parses JSON with // and /* *\/ comments and trailing commas. */
export function parseJsonc<T = unknown>(text: string): T {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1")) as T;
}

let settingsPath = "";

export async function getSettingsPath(): Promise<string> {
  if (!settingsPath) settingsPath = join(await api.configDir(), "settings.json");
  return settingsPath;
}

/** Loads settings.json, creating it with defaults on first run. */
export async function loadSettings(): Promise<Settings> {
  const path = await getSettingsPath();
  try {
    const user = parseJsonc<Partial<Settings>>(await api.readFile(path));
    return { ...defaultSettings, ...user };
  } catch {
    // Missing file: write defaults. Broken file: keep it and use defaults.
    try {
      await api.readFile(path);
    } catch {
      await api.writeFile(path, template(defaultSettings));
    }
    return { ...defaultSettings };
  }
}

/** Sets one key in settings.json. Comments in the file are not preserved. */
export async function updateSetting<K extends keyof Settings>(
  current: Settings,
  key: K,
  value: Settings[K],
): Promise<Settings> {
  const path = await getSettingsPath();
  let user: Record<string, unknown> = {};
  try {
    user = parseJsonc(await api.readFile(path));
  } catch {
    /* start fresh */
  }
  user[key] = value;
  await api.writeFile(path, template(user as unknown as Settings));
  return { ...current, [key]: value };
}
