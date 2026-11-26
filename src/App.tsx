import { useCallback, useEffect, useRef, useState } from "react";
import { open, ask } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, basename } from "./lib/api";
import { applyTheme, importThemeFile } from "./lib/highlighting";
import { themeToCssVars } from "./lib/uiColors";
import { getSettingsPath, loadSettings, updateSetting, type Settings } from "./lib/settings";
import { dirtyPaths, isDirty, onDirtyChange, reloadFromDisk, saveModel } from "./lib/models";
import { commandForKey, keyString, registerCommands } from "./lib/commands";
import { languageForPath, languageName } from "./lib/languages";
import { useStore, activeFile } from "./store";
import { Explorer } from "./components/Explorer";
import { SearchView } from "./components/SearchView";
import { EditorGroup, activeEditor, closeTabSafely } from "./components/EditorGroup";
import { TerminalPanel } from "./components/TerminalPanel";
import { Palette } from "./components/Palette";
import "./App.css";

const LAST_FOLDER = "ide.lastFolder";
const layoutKey = "ide.layout";

export default function App() {
  const s = useStore();
  const [layout, setLayout] = useState(() => {
    try {
      return { sidebar: 260, panel: 260, ...JSON.parse(localStorage.getItem(layoutKey) ?? "{}") };
    } catch {
      return { sidebar: 260, panel: 260 };
    }
  });
  const ready = useRef(false);

  // --- folder ---

  const openFolder = useCallback(async (path?: string) => {
    const folder = path ?? ((await open({ directory: true, title: "Open Folder" })) as string | null);
    if (!folder) return;
    if (dirtyPaths().length && !(await ask("You have unsaved changes. Open another folder anyway?", { kind: "warning" }))) return;
    useStore.getState().setRoot(folder);
    localStorage.setItem(LAST_FOLDER, folder);
    api.watchFolder(folder).catch((e) => useStore.getState().toast(`Can't watch folder: ${e}`, "error"));
    getCurrentWindow().setTitle(`${basename(folder)} — Frost`);
  }, []);

  // --- startup: settings, theme, last folder ---

  useEffect(() => {
    if (ready.current) return;
    ready.current = true;
    (async () => {
      const settings = await loadSettings();
      useStore.getState().setSettings(settings);
      const last = (await api.startupFolder()) ?? localStorage.getItem(LAST_FOLDER);
      if (last) {
        try {
          await api.listDir(last);
          openFolder(last);
        } catch {
          localStorage.removeItem(LAST_FOLDER);
        }
      }
    })();
  }, [openFolder]);

  // Re-apply the theme whenever theme-related settings change.
  const themeKey = JSON.stringify([
    s.settings["workbench.colorTheme"],
    s.settings["workbench.colorCustomizations"],
    s.settings["editor.tokenColorCustomizations"],
  ]);
  useEffect(() => {
    applyTheme(s.settings["workbench.colorTheme"], s.settings)
      .then((t) => useStore.getState().setTheme(t))
      .catch((e) => useStore.getState().toast(`Theme error: ${e}`, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeKey]);

  useEffect(() => {
    if (!s.theme) return;
    const root = document.documentElement;
    for (const [k, v] of Object.entries(themeToCssVars(s.theme))) root.style.setProperty(k, v);
    root.dataset.themeType = s.theme.type;
  }, [s.theme]);

  useEffect(() => {
    document.documentElement.dataset.density = s.settings["workbench.density"];
  }, [s.settings]);

  useEffect(() => localStorage.setItem(layoutKey, JSON.stringify(layout)), [layout]);

  // Reload open files changed on disk (git checkout, other editors, Claude Code...).
  useEffect(() => {
    const un = api.onFsChange((c) => reloadFromDisk(c.paths));
    return () => void un.then((f) => f());
  }, []);

  // Auto save.
  useEffect(() => {
    const mode = s.settings["files.autoSave"];
    if (mode === "afterDelay") {
      let t: ReturnType<typeof setTimeout>;
      const off = onDirtyChange(() => {
        clearTimeout(t);
        t = setTimeout(() => dirtyPaths().forEach(saveModel), s.settings["files.autoSaveDelay"]);
      });
      return () => {
        off();
        clearTimeout(t);
      };
    }
    if (mode === "onFocusChange") {
      const onBlur = () => dirtyPaths().forEach(saveModel);
      window.addEventListener("blur", onBlur);
      return () => window.removeEventListener("blur", onBlur);
    }
  }, [s.settings]);

  // Ask before closing the window with unsaved changes.
  useEffect(() => {
    const un = getCurrentWindow().onCloseRequested(async () => {
      const dirty = dirtyPaths();
      if (!dirty.length) return;
      const save = await ask(`Save changes to ${dirty.length} file(s) before closing?`, {
        title: "Unsaved changes",
        kind: "warning",
        okLabel: "Save All",
        cancelLabel: "Don't Save",
      });
      if (save) await Promise.all(dirty.map(saveModel));
    });
    return () => void un.then((f) => f());
  }, []);

  // --- commands and keybindings ---

  useEffect(() => {
    const st = useStore.getState;
    const save = async (path: string | null) => {
      if (!path) return;
      try {
        await saveModel(path);
        if (path === (await getSettingsPath())) {
          st().setSettings(await loadSettings());
          st().toast("Settings applied");
        }
      } catch (e) {
        st().toast(`Couldn't save ${basename(path)}: ${e}`, "error");
      }
    };
    const setSetting = async (key: keyof Settings, value: unknown) => {
      st().setSettings(await updateSetting(st().settings, key, value as never));
    };
    const cycleTab = (dir: 1 | -1) => {
      const { groups, activeGroup } = st();
      const g = groups[activeGroup];
      if (!g.active || g.tabs.length < 2) return;
      const i = g.tabs.indexOf(g.active);
      st().setActiveTab(activeGroup, g.tabs[(i + dir + g.tabs.length) % g.tabs.length]);
    };

    registerCommands([
      { id: "palette.commands", label: "Show All Commands", keybinding: "Ctrl+Shift+P", run: () => st().openPalette("commands") },
      { id: "palette.files", label: "Go to File…", keybinding: "Ctrl+P", run: () => st().openPalette("files") },
      { id: "palette.line", label: "Go to Line…", keybinding: "Ctrl+G", run: () => st().openPalette("line") },
      { id: "file.openFolder", label: "File: Open Folder…", keybinding: "Ctrl+O", run: () => openFolder() },
      {
        id: "file.closeFolder",
        label: "File: Close Folder",
        run: () => {
          localStorage.removeItem(LAST_FOLDER);
          st().setRoot(null);
          getCurrentWindow().setTitle("Frost");
        },
      },
      { id: "file.save", label: "File: Save", keybinding: "Ctrl+S", run: () => save(activeFile()) },
      { id: "file.saveAll", label: "File: Save All", keybinding: "Ctrl+Alt+S", run: () => dirtyPaths().forEach(save) },
      {
        id: "editor.close",
        label: "View: Close Editor",
        keybinding: "Ctrl+W",
        run: () => {
          const { groups, activeGroup } = st();
          const path = groups[activeGroup]?.active;
          if (path) closeTabSafely(activeGroup, path);
        },
      },
      { id: "editor.next", label: "View: Open Next Editor", keybinding: "Ctrl+PageDown", run: () => cycleTab(1) },
      { id: "editor.prev", label: "View: Open Previous Editor", keybinding: "Ctrl+PageUp", run: () => cycleTab(-1) },
      { id: "editor.nextTab", label: "View: Next Editor (Ctrl+Tab)", keybinding: "Ctrl+Tab", run: () => cycleTab(1) },
      { id: "editor.split", label: "View: Split Editor Right", keybinding: "Ctrl+\\", run: () => st().splitRight() },
      {
        id: "editor.focusNextGroup",
        label: "View: Focus Next Editor Group",
        keybinding: "Ctrl+Alt+ArrowRight",
        run: () => {
          const { groups, activeGroup } = st();
          st().focusGroup((activeGroup + 1) % groups.length);
          requestAnimationFrame(() => activeEditor()?.focus());
        },
      },
      { id: "view.sidebar", label: "View: Toggle Primary Side Bar", keybinding: "Ctrl+B", run: () => st().toggleSidebar() },
      { id: "view.explorer", label: "View: Show Explorer", keybinding: "Ctrl+Shift+E", run: () => useStore.setState({ sidebar: "explorer" }) },
      {
        id: "view.search",
        label: "Search: Find in Files",
        keybinding: "Ctrl+Shift+F",
        run: () => {
          useStore.setState({ sidebar: "search" });
          requestAnimationFrame(() => window.dispatchEvent(new Event("ide:focus-search")));
        },
      },
      {
        id: "terminal.toggle",
        label: "View: Toggle Terminal",
        keybinding: "Ctrl+`",
        run: () => {
          const open = !st().panelOpen;
          st().togglePanel(open);
          if (!open) activeEditor()?.focus();
        },
      },
      { id: "terminal.new", label: "Terminal: Create New Terminal", keybinding: "Ctrl+Shift+`", run: () => window.dispatchEvent(new CustomEvent("ide:new-terminal", { detail: {} })) },
      { id: "theme.select", label: "Preferences: Color Theme", keybinding: "Ctrl+Shift+T", run: () => st().openPalette("themes") },
      {
        id: "theme.import",
        label: "Preferences: Import VS Code Color Theme (JSON)…",
        run: async () => {
          const file = (await open({ title: "Import VS Code theme", filters: [{ name: "VS Code theme", extensions: ["json"] }] })) as string | null;
          if (!file) return;
          try {
            const label = await importThemeFile(file);
            st().setSettings(await updateSetting(st().settings, "workbench.colorTheme", label));
            st().toast(`Imported and applied "${label}"`);
          } catch (e) {
            st().toast(`Couldn't import theme: ${e}`, "error");
          }
        },
      },
      { id: "settings.open", label: "Preferences: Open Settings (JSON)", keybinding: "Ctrl+,", run: async () => st().openFile(await getSettingsPath()) },
      {
        id: "settings.themesFolder",
        label: "Preferences: Show Themes Folder Path",
        run: async () => st().toast(`Put VS Code theme .json files in: ${await api.configDir()}${navigator.userAgent.includes("Windows") ? "\\" : "/"}themes`),
      },
      { id: "editor.fontBigger", label: "View: Increase Editor Font Size", keybinding: "Ctrl+=", run: () => setSetting("editor.fontSize", (st().settings["editor.fontSize"] + 1)) },
      { id: "editor.fontSmaller", label: "View: Decrease Editor Font Size", keybinding: "Ctrl+-", run: () => setSetting("editor.fontSize", Math.max(8, st().settings["editor.fontSize"] - 1)) },
      { id: "editor.wordWrap", label: "View: Toggle Word Wrap", keybinding: "Alt+Z", run: () => setSetting("editor.wordWrap", (st().settings["editor.wordWrap"] === "on" ? "off" : "on")) },
      { id: "editor.minimap", label: "View: Toggle Minimap", run: () => setSetting("editor.minimap.enabled", !st().settings["editor.minimap.enabled"]) },
      {
        id: "view.density",
        label: "View: Toggle Compact / Comfortable Layout",
        run: () => setSetting("workbench.density", (st().settings["workbench.density"] === "compact" ? "comfortable" : "compact") as never),
      },
      { id: "dev.reload", label: "Developer: Reload Window", run: () => location.reload() },
      { id: "dev.devtools", label: "Developer: Toggle Developer Tools (F12 in dev builds)", run: () => st().toast("Right-click → Inspect, or press F12, in a dev build (npm run tauri dev).") },
    ]);

    const onKey = (e: KeyboardEvent) => {
      const key = e.key === "F1" ? "Ctrl+Shift+P" : keyString(e);
      if (!key) return;
      // Block WebView shortcuts that don't make sense in an IDE.
      if (["F5", "Ctrl+R", "Ctrl+Shift+R", "Ctrl+J"].includes(key)) {
        e.preventDefault();
        return;
      }
      const cmd = commandForKey(key);
      if (!cmd) return;
      e.preventDefault();
      e.stopPropagation();
      cmd.run();
    };
    window.addEventListener("keydown", onKey, true);
    if (!import.meta.env.DEV) {
      const noMenu = (e: MouseEvent) => e.preventDefault();
      document.addEventListener("contextmenu", noMenu);
    }
    return () => window.removeEventListener("keydown", onKey, true);
  }, [openFolder]);

  // --- resizable sidebar and panel ---

  const drag = (kind: "sidebar" | "panel") => (e: React.PointerEvent) => {
    e.preventDefault();
    const start = kind === "sidebar" ? e.clientX : e.clientY;
    const initial = layout[kind];
    const move = (ev: PointerEvent) => {
      const delta = kind === "sidebar" ? ev.clientX - start : start - ev.clientY;
      const max = kind === "sidebar" ? window.innerWidth * 0.6 : window.innerHeight * 0.75;
      setLayout((l: typeof layout) => ({ ...l, [kind]: Math.max(160, Math.min(max, initial + delta)) }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing", kind === "sidebar" ? "col" : "row");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const current = activeFile();

  return (
    <div className="workbench">
      <TitleBar onOpenFolder={() => openFolder()} />
      <div className="main">
        <ActivityBar />
        {s.sidebar && (
          <>
            <aside className="sidebar" style={{ width: layout.sidebar }}>
              {s.sidebar === "explorer" ? <Explorer onOpenFolder={() => openFolder()} /> : <SearchView />}
            </aside>
            <div className="sash vertical" onPointerDown={drag("sidebar")} />
          </>
        )}
        <div className="center">
          <div className="editor-area">
            {s.groups.map((g, i) => (
              <EditorGroup key={g.id} group={g} index={i} focused={i === s.activeGroup} />
            ))}
          </div>
          <div className="sash horizontal" style={{ display: s.panelOpen ? "block" : "none" }} onPointerDown={drag("panel")} />
          <div className="panel-container" style={{ height: layout.panel, display: s.panelOpen ? "flex" : "none" }}>
            <TerminalPanel />
          </div>
        </div>
      </div>
      <StatusBar file={current} />
      {s.palette && <Palette />}
      <div className="toasts">
        {s.toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} onClick={() => s.dismissToast(t.id)}>
            <span className={`codicon ${t.kind === "error" ? "codicon-error" : "codicon-info"}`} />
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TitleBar({ onOpenFolder }: { onOpenFolder: () => void }) {
  const root = useStore((s) => s.root);
  const panelOpen = useStore((s) => s.panelOpen);
  const sidebar = useStore((s) => s.sidebar);
  return (
    <div className="titlebar">
      <div className="titlebar-left">
        <button className="project-button" onClick={onOpenFolder} title="Open Folder (Ctrl+O)">
          <span className="project-badge">{root ? basename(root).slice(0, 2).toUpperCase() : "—"}</span>
          <span>{root ? basename(root) : "Open Folder…"}</span>
          <span className="codicon codicon-chevron-down" />
        </button>
      </div>
      <button className="command-center" onClick={() => useStore.getState().openPalette("files")}>
        <span className="codicon codicon-search" />
        <span>{root ? `Search ${basename(root)}` : "Search"}</span>
        <kbd>Ctrl+P</kbd>
      </button>
      <div className="titlebar-right">
        <div className="run-config" title="Run configurations arrive in phase 2">
          <span className="codicon codicon-symbol-event" />
          <span>Current File</span>
          <span className="codicon codicon-chevron-down" />
        </div>
        <button className="icon-button run" disabled title="Run (phase 2)">
          <span className="codicon codicon-play" />
        </button>
        <button className="icon-button debug" disabled title="Debug (phase 2)">
          <span className="codicon codicon-debug-alt" />
        </button>
        <span className="titlebar-sep" />
        <button className="icon-button" disabled title="Claude Code (phase 3)">
          <span className="codicon codicon-sparkle" />
        </button>
        <button className={`icon-button ${sidebar ? "on" : ""}`} title="Toggle Side Bar (Ctrl+B)" onClick={() => useStore.getState().toggleSidebar()}>
          <span className="codicon codicon-layout-sidebar-left" />
        </button>
        <button className={`icon-button ${panelOpen ? "on" : ""}`} title="Toggle Terminal (Ctrl+`)" onClick={() => useStore.getState().togglePanel()}>
          <span className="codicon codicon-layout-panel" />
        </button>
        <button className="icon-button" title="Command Palette (Ctrl+Shift+P)" onClick={() => useStore.getState().openPalette("commands")}>
          <span className="codicon codicon-settings-gear" />
        </button>
      </div>
    </div>
  );
}

function ActivityBar() {
  const sidebar = useStore((s) => s.sidebar);
  const panelOpen = useStore((s) => s.panelOpen);
  const item = (view: "explorer" | "search", icon: string, title: string) => (
    <button className={`activity-item ${sidebar === view ? "active" : ""}`} title={title} onClick={() => useStore.getState().toggleSidebar(view)}>
      <span className={`codicon ${icon}`} />
    </button>
  );
  return (
    <nav className="activitybar">
      {item("explorer", "codicon-files", "Explorer (Ctrl+Shift+E)")}
      {item("search", "codicon-search", "Search (Ctrl+Shift+F)")}
      <button className={`activity-item ${panelOpen ? "active-soft" : ""}`} title="Terminal (Ctrl+`)" onClick={() => useStore.getState().togglePanel()}>
        <span className="codicon codicon-terminal" />
      </button>
      <div className="activity-spacer" />
      <button className="activity-item" title="Color Theme" onClick={() => useStore.getState().openPalette("themes")}>
        <span className="codicon codicon-symbol-color" />
      </button>
      <button className="activity-item" title="Settings (Ctrl+,)" onClick={async () => useStore.getState().openFile(await getSettingsPath())}>
        <span className="codicon codicon-settings-gear" />
      </button>
    </nav>
  );
}

function StatusBar({ file }: { file: string | null }) {
  const root = useStore((s) => s.root);
  const cursor = useStore((s) => s.cursor);
  const theme = useStore((s) => s.theme);
  const settings = useStore((s) => s.settings);
  useStore((s) => s.groups); // re-render on tab changes
  const model = activeEditor()?.getModel();
  const eol = model?.getEOL() === "\r\n" ? "CRLF" : "LF";
  return (
    <footer className={`statusbar ${root ? "" : "no-folder"}`}>
      <div className="status-left">
        <span className="status-item">
          <span className="codicon codicon-remote" /> {root ? basename(root) : "No folder"}
        </span>
        {file && isDirty(file) && <span className="status-item">● Unsaved</span>}
      </div>
      <div className="status-right">
        {file && cursor && (
          <span className="status-item clickable" onClick={() => useStore.getState().openPalette("line")}>
            Ln {cursor.line}, Col {cursor.column}
          </span>
        )}
        {file && <span className="status-item">Spaces: {settings["editor.tabSize"]}</span>}
        {file && <span className="status-item">UTF-8</span>}
        {file && model && <span className="status-item">{eol}</span>}
        {file && <span className="status-item">{languageName(languageForPath(file))}</span>}
        <span className="status-item clickable" onClick={() => useStore.getState().openPalette("themes")}>
          <span className="codicon codicon-symbol-color" /> {theme?.label}
        </span>
      </div>
    </footer>
  );
}
