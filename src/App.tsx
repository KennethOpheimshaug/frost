import { useCallback, useEffect, useRef, useState } from "react";
import { open, ask } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, basename } from "./lib/api";
import { applyTheme, importThemeFile } from "./lib/highlighting";
import { themeToCssVars } from "./lib/uiColors";
import { getSettingsPath, loadSettings, updateSetting, type Settings } from "./lib/settings";
import { dirtyPaths, isDirty, onDirtyChange, reloadFromDisk, saveModel } from "./lib/models";
import { commandForKey, keyString, registerCommands, runCommand } from "./lib/commands";
import { languageForPath, languageName } from "./lib/languages";
import { useStore, activeFile } from "./store";
import { Explorer } from "./components/Explorer";
import { SearchView } from "./components/SearchView";
import { EditorGroup, activeEditor, closeTabSafely } from "./components/EditorGroup";
import { BottomPanel } from "./components/BottomPanel";
import { SolutionView } from "./components/SolutionView";
import { ContextMenu, type MenuItem } from "./components/ContextMenu";
import { allProblems, useProblems } from "./lib/problems";
import { buildTarget, loadSolution, setStartup, useSolution } from "./dotnet/solution";
import { cancelBuild, runBuild, useBuild } from "./dotnet/build";
import { runProject, stopRun, useRun } from "./dotnet/run";
import { DebugToolbar, DebugView } from "./components/DebugView";
import { Overlays } from "./components/Overlays";
import { loadBreakpoints, toggleBreakpoint } from "./dap/breakpoints";
import {
  continueRun, installDebugger, isDebugging, pause, restartDebugging, startDebugging, stepInto, stepOut, stepOver, stopDebugging, useDebug,
} from "./dap/session";
import { notifyFileChanges, notifySaved, startCsharp, stopCsharp, useCsharp } from "./lsp/roslyn";
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

  // .NET: read the solution and start the C# language server for the open folder.
  const csharpOn = s.settings["dotnet.languageServer.enabled"];
  const csharpCmd = s.settings["dotnet.languageServer.command"];
  useEffect(() => {
    loadSolution(s.root);
    loadBreakpoints(s.root);
    if (!s.root || !csharpOn) {
      stopCsharp();
      return;
    }
    startCsharp(s.root, {
      command: csharpCmd,
      solution: useSolution.getState().solution,
      onRestoreNeeded: (projects) => {
        if (!useBuild.getState().running) runBuild("restore", projects[0] ?? buildTarget() ?? s.root!);
      },
    });
  }, [s.root, csharpOn, csharpCmd]);

  // Reload open files changed on disk (git checkout, other editors, Claude Code...).
  useEffect(() => {
    const un = api.onFsChange((c) => {
      reloadFromDisk(c.paths);
      const changed = c.paths.filter((p) => !c.created.includes(p) && !c.removed.includes(p));
      notifyFileChanges(c.created, changed, c.removed);
    });
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
        notifySaved(path);
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
    const buildAll = (kind: "build" | "rebuild" | "clean" | "restore") => {
      const target = buildTarget();
      if (!target) return st().toast("Open a folder with a .NET solution or project first.", "error");
      return runBuild(kind, target);
    };
    const runStartup = async () => {
      const startup = useSolution.getState().startup;
      if (!startup) return runProject("run");
      if (useRun.getState().project) stopRun();
      if (!st().settings["dotnet.buildBeforeRun"]) return runProject("run", startup);
      await Promise.all(dirtyPaths().map(saveModel));
      if (await runBuild("build", startup)) runProject("run", startup, { noBuild: true });
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
          if (st().panelOpen && st().panelTab === "terminal") {
            st().togglePanel(false);
            activeEditor()?.focus();
          } else st().showPanel("terminal");
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
      { id: "palette.symbols", label: "Go to Symbol in Workspace…", keybinding: "Ctrl+T", run: () => st().openPalette("symbols") },
      { id: "build.build", label: "Build: Build Solution", keybinding: "Ctrl+Shift+B", run: () => buildAll("build") },
      { id: "build.rebuild", label: "Build: Rebuild Solution", run: () => buildAll("rebuild") },
      { id: "build.clean", label: "Build: Clean Solution", run: () => buildAll("clean") },
      { id: "build.restore", label: "Build: Restore NuGet Packages", run: () => buildAll("restore") },
      { id: "build.cancel", label: "Build: Cancel Build", keybinding: "Ctrl+Pause", run: () => cancelBuild() },
      { id: "run.run", label: "Run: Run Startup Project", keybinding: "Ctrl+F5", keys: ["Shift+F10"], run: () => runStartup() },
      { id: "run.watch", label: "Run: Run with Hot Reload (dotnet watch)", keybinding: "Ctrl+Alt+F5", run: () => runProject("watch") },
      { id: "run.stop", label: "Run: Stop", keybinding: "Shift+F5", keys: ["Ctrl+F2"], run: () => (isDebugging() ? stopDebugging() : stopRun()) },
      {
        id: "debug.start",
        label: "Debug: Start Debugging / Continue",
        keybinding: "F5",
        keys: ["Shift+F9"],
        run: () => {
          const status = useDebug.getState().status;
          if (status === "stopped") continueRun();
          else if (status === "inactive") startDebugging();
        },
      },
      { id: "debug.restart", label: "Debug: Restart", keybinding: "Ctrl+Shift+F5", run: () => restartDebugging() },
      { id: "debug.pause", label: "Debug: Pause", keybinding: "F6", run: () => pause() },
      { id: "debug.stepOver", label: "Debug: Step Over", keybinding: "F10", keys: ["F8"], run: () => stepOver() },
      { id: "debug.stepInto", label: "Debug: Step Into", keybinding: "F11", keys: ["F7"], run: () => stepInto() },
      { id: "debug.stepOut", label: "Debug: Step Out", keybinding: "Shift+F11", keys: ["Shift+F8"], run: () => stepOut() },
      {
        id: "debug.toggleBreakpoint",
        label: "Debug: Toggle Breakpoint",
        keybinding: "F9",
        keys: ["Ctrl+F8"],
        run: () => {
          const ed = activeEditor();
          const model = ed?.getModel();
          const pos = ed?.getPosition();
          if (model && pos) toggleBreakpoint(model.uri.fsPath, pos.lineNumber);
        },
      },
      { id: "debug.attach", label: "Debug: Attach to Process…", keybinding: "Ctrl+Alt+P", run: () => st().openPalette("processes") },
      { id: "debug.install", label: "Debug: Download netcoredbg (debugger)", run: () => installDebugger() },
      { id: "view.debug", label: "View: Show Run and Debug", keybinding: "Ctrl+Shift+D", run: () => useStore.setState({ sidebar: "debug" }) },
      { id: "view.debugConsole", label: "View: Show Debug Console", keybinding: "Ctrl+Shift+Y", run: () => st().showPanel("debug") },
      { id: "run.selectStartup", label: "Run: Select Startup Project…", run: () => st().openPalette("projects") },
      { id: "view.solution", label: "View: Show Solution", keybinding: "Ctrl+Alt+L", run: () => useStore.setState({ sidebar: "solution" }) },
      { id: "view.problems", label: "View: Show Problems", keybinding: "Ctrl+Shift+M", run: () => st().showPanel("problems") },
      { id: "view.output", label: "View: Show Output", keybinding: "Ctrl+Shift+U", run: () => st().showPanel("output") },
      {
        id: "csharp.restart",
        label: "C#: Restart Language Server",
        run: () => {
          const root = st().root;
          if (root) startCsharp(root, { command: st().settings["dotnet.languageServer.command"], solution: useSolution.getState().solution });
        },
      },
      { id: "dev.reload", label: "Developer: Reload Window", run: () => location.reload() },
      { id: "dev.devtools", label: "Developer: Toggle Developer Tools (F12 in dev builds)", run: () => st().toast("Right-click → Inspect, or press F12, in a dev build (npm run tauri dev).") },
    ]);

    const onKey = (e: KeyboardEvent) => {
      const key = e.key === "F1" ? "Ctrl+Shift+P" : keyString(e);
      if (!key) return;
      // Block WebView shortcuts that don't make sense in an IDE.
      if (["Ctrl+R", "Ctrl+Shift+R", "Ctrl+J"].includes(key) && !commandForKey(key)) {
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
              {s.sidebar === "explorer" ? <Explorer onOpenFolder={() => openFolder()} /> : s.sidebar === "solution" ? <SolutionView /> : s.sidebar === "debug" ? <DebugView /> : <SearchView />}
            </aside>
            <div className="sash vertical" onPointerDown={drag("sidebar")} />
          </>
        )}
        <div className="center">
          <div className="editor-area">
            <DebugToolbar />
            {s.groups.map((g, i) => (
              <EditorGroup key={g.id} group={g} index={i} focused={i === s.activeGroup} />
            ))}
          </div>
          <div className="sash horizontal" style={{ display: s.panelOpen ? "block" : "none" }} onPointerDown={drag("panel")} />
          <div className="panel-container" style={{ height: layout.panel, display: s.panelOpen ? "flex" : "none" }}>
            <BottomPanel />
          </div>
        </div>
      </div>
      <StatusBar file={current} />
      {s.palette && <Palette />}
      <Overlays />
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
        <RunControls />
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
  const item = (view: "explorer" | "solution" | "search" | "debug", icon: string, title: string) => (
    <button className={`activity-item ${sidebar === view ? "active" : ""}`} title={title} onClick={() => useStore.getState().toggleSidebar(view)}>
      <span className={`codicon ${icon}`} />
    </button>
  );
  return (
    <nav className="activitybar">
      {item("explorer", "codicon-files", "Explorer (Ctrl+Shift+E)")}
      {item("solution", "codicon-symbol-namespace", "Solution (Ctrl+Alt+L)")}
      {item("search", "codicon-search", "Search (Ctrl+Shift+F)")}
      {item("debug", "codicon-debug-alt", "Run and Debug (Ctrl+Shift+D)")}
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
        <ProblemCounts />
        <BuildStatus />
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
        <CsharpStatus />
        <span className="status-item clickable" onClick={() => useStore.getState().openPalette("themes")}>
          <span className="codicon codicon-symbol-color" /> {theme?.label}
        </span>
      </div>
    </footer>
  );
}

function RunControls() {
  const { projects, startup } = useSolution();
  const running = useRun();
  const building = useBuild((b) => b.running);
  const debugStatus = useDebug((d) => d.status);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const runnable = projects.filter((p) => p.isRunnable);
  const current = projects.find((p) => p.path === startup);
  const run = () => runCommand("run.run");

  const openMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: r.left,
      y: r.bottom + 4,
      items: runnable.length
        ? [
            ...runnable.map((p) => ({ label: `${p.path === startup ? "✓ " : "   "}${p.name}`, action: () => setStartup(p.path) })),
            { separator: true as const },
            { label: "Run with Hot Reload (dotnet watch)", action: () => runProject("watch") },
            { label: "Build Solution", hint: "Ctrl+Shift+B", action: () => runCommand("build.build") },
          ]
        : [{ label: "No runnable projects (needs OutputType Exe or a Web SDK)", action: () => {}, disabled: true }],
    });
  };

  return (
    <>
      <button className="run-config" onClick={openMenu} title="Select startup project">
        <span className={`codicon ${current ? "codicon-rocket" : "codicon-symbol-event"}`} />
        <span>{current?.name ?? (projects.length ? "No runnable project" : "No project")}</span>
        <span className="codicon codicon-chevron-down" />
      </button>
      <button className="icon-button" title={building ? "Cancel Build (Ctrl+Pause)" : "Build Solution (Ctrl+Shift+B)"} disabled={!projects.length} onClick={() => runCommand(building ? "build.cancel" : "build.build")}>
        <span className={`codicon ${building ? "codicon-loading codicon-modifier-spin" : "codicon-tools"}`} />
      </button>
      {running.project ? (
        <button className="icon-button stop" title="Stop (Shift+F5)" onClick={() => stopRun()}>
          <span className="codicon codicon-debug-stop" />
        </button>
      ) : (
        <button className="icon-button run" title="Run (Ctrl+F5 / Shift+F10)" disabled={!current || !!building} onClick={run}>
          <span className="codicon codicon-play" />
        </button>
      )}
      <button className="icon-button debug" title="Debug (F5 / Shift+F9)" disabled={!current || !!building || debugStatus !== "inactive"} onClick={() => startDebugging()}>
        <span className="codicon codicon-debug-alt" />
      </button>
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </>
  );
}

function ProblemCounts() {
  useProblems((p) => p.byFile);
  const all = allProblems();
  const errors = all.filter((p) => p.severity === "error").length;
  const warnings = all.filter((p) => p.severity === "warning").length;
  return (
    <span className="status-item clickable" title="Problems (Ctrl+Shift+M)" onClick={() => useStore.getState().showPanel("problems")}>
      <span className="codicon codicon-error" /> {errors} <span className="codicon codicon-warning" /> {warnings}
    </span>
  );
}

function BuildStatus() {
  const b = useBuild();
  if (b.running)
    return (
      <span className="status-item clickable" onClick={() => useStore.getState().showPanel("output")}>
        <span className="codicon codicon-loading codicon-modifier-spin" /> {b.running === "restore" ? "Restoring…" : "Building…"}
      </span>
    );
  if (!b.result) return null;
  return (
    <span className="status-item clickable" onClick={() => useStore.getState().showPanel("output")} title="Show build output">
      <span className={`codicon ${b.result === "succeeded" ? "codicon-check" : b.result === "cancelled" ? "codicon-circle-slash" : "codicon-error"}`} />
      Build {b.result} ({b.seconds}s)
    </span>
  );
}

function CsharpStatus() {
  const { status, detail, sdk } = useCsharp();
  if (status === "off") return null;
  const icon =
    status === "ready" ? "codicon-check" : status === "missing" || status === "error" ? "codicon-warning" : "codicon-loading codicon-modifier-spin";
  return (
    <span
      className="status-item clickable"
      title={`${detail}${sdk ? `\n.NET SDK ${sdk}` : ""}`}
      onClick={() => {
        if (status === "missing") useStore.getState().toast(detail, "error");
        else useStore.getState().showPanel("output");
      }}
    >
      <span className={`codicon ${icon}`} /> C#{status === "loading" || status === "starting" ? ": loading" : status === "missing" ? ": not installed" : status === "error" ? ": stopped" : ""}
    </span>
  );
}
