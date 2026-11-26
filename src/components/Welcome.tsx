// Start window shown when Frost launches, inspired by Rider's welcome screen and
// Visual Studio's start window: recent projects on the left, ways to get started on the right.
import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, basename, dirname, join } from "../lib/api";
import { recentList, removeRecent, timeAgo, togglePinned, type RecentEntry } from "../lib/recent";
import { fuzzyFilter } from "../lib/fuzzy";
import { showMenu } from "../lib/overlay";
import { useStore } from "../store";
import logo from "../assets/logo.svg";

interface Props {
  onOpen: (folder: string, solution?: string) => void;
  /** Set when a folder is open behind the welcome screen. */
  onClose?: () => void;
}

type Pane = "start" | "new" | "clone";

export function Welcome({ onOpen, onClose }: Props) {
  const [recent, setRecent] = useState<RecentEntry[]>(recentList);
  const [query, setQuery] = useState("");
  const [pane, setPane] = useState<Pane>("start");
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [sdk, setSdk] = useState<string | null>(null);
  const theme = useStore((s) => s.theme);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
    api.dotnetInfo().then((i) => setSdk(i.sdk));
    // Grey out folders that no longer exist.
    Promise.all(recentList().map((r) => api.listDir(r.path).then(() => null, () => r.path))).then((gone) =>
      setMissing(new Set(gone.filter(Boolean) as string[])),
    );
  }, []);

  const shown = useMemo(
    () => (query ? fuzzyFilter(recent, query, (r) => `${basename(r.path)} ${r.path}`, 50).map((x) => x.item) : recent),
    [recent, query],
  );
  const refresh = () => setRecent(recentList());

  const openFolder = async () => {
    const folder = (await open({ directory: true, title: "Open Folder" })) as string | null;
    if (folder) onOpen(folder);
  };
  const openSolution = async () => {
    const file = (await open({
      title: "Open Solution or Project",
      filters: [{ name: "Solution or project", extensions: ["sln", "slnx", "csproj", "fsproj", "vbproj"] }],
    })) as string | null;
    if (file) onOpen(dirname(file), file);
  };

  return (
    <div className="welcome" data-theme={theme?.type}>
      <aside className="welcome-side">
        <div className="welcome-brand">
          <img className="welcome-logo" src={logo} alt="" />
          <div>
            <div className="welcome-title">Frost</div>
            <div className="welcome-version">Version 0.3 · {sdk ? `.NET SDK ${sdk}` : "checking .NET SDK…"}</div>
          </div>
        </div>
        <nav className="welcome-nav">
          <button className={pane === "start" ? "active" : ""} onClick={() => setPane("start")}>
            <span className="codicon codicon-folder-library" /> Projects
          </button>
          <button className={pane === "new" ? "active" : ""} onClick={() => setPane("new")}>
            <span className="codicon codicon-new-folder" /> New Project
          </button>
          <button className={pane === "clone" ? "active" : ""} onClick={() => setPane("clone")}>
            <span className="codicon codicon-repo-clone" /> Clone Repository
          </button>
        </nav>
        <div className="welcome-side-bottom">
          {onClose && (
            <button onClick={onClose}>
              <span className="codicon codicon-arrow-left" /> Back to {basename(useStore.getState().root ?? "")}
            </button>
          )}
          <button onClick={() => useStore.getState().openPalette("themes")}>
            <span className="codicon codicon-symbol-color" /> Color Theme
          </button>
          <button onClick={() => useStore.getState().openPalette("commands")}>
            <span className="codicon codicon-settings-gear" /> All Commands
          </button>
        </div>
      </aside>

      <main className="welcome-main">
        {pane === "start" && (
          <>
            <div className="welcome-toolbar">
              <div className="welcome-search">
                <span className="codicon codicon-search" />
                <input
                  ref={searchRef}
                  placeholder="Search projects"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && shown[0]) onOpen(shown[0].path, shown[0].solution);
                  }}
                />
              </div>
              <button className="primary-button" onClick={openFolder}>
                Open Folder
              </button>
              <button className="secondary-button" onClick={openSolution}>
                Open Solution…
              </button>
            </div>

            <div className="welcome-columns">
              <section className="welcome-recent">
                <h2>Recent projects</h2>
                {shown.length === 0 && (
                  <div className="welcome-empty">
                    {query ? "No matching projects." : "Projects you open will show up here. Open a folder or a solution to get started."}
                  </div>
                )}
                {shown.map((r) => {
                  const gone = missing.has(r.path);
                  return (
                    <div
                      key={r.path}
                      className={`recent-item ${gone ? "gone" : ""}`}
                      onClick={() => !gone && onOpen(r.path, r.solution)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        showMenu(e.clientX, e.clientY, [
                          { label: "Open", action: () => onOpen(r.path, r.solution), disabled: gone },
                          { label: r.pinned ? "Unpin" : "Pin to Top", action: () => (togglePinned(r.path), refresh()) },
                          { label: "Copy Path", action: () => navigator.clipboard.writeText(r.path) },
                          { separator: true },
                          { label: "Remove from List", action: () => (removeRecent(r.path), refresh()) },
                        ]);
                      }}
                      title={r.path}
                    >
                      <span className="recent-badge" style={{ background: badgeColor(r.path) }}>
                        {basename(r.path).slice(0, 2).toUpperCase()}
                      </span>
                      <div className="recent-text">
                        <div className="recent-name">
                          {basename(r.path)}
                          {r.solution && <span className="recent-sln">{basename(r.solution)}</span>}
                          {r.pinned && <span className="codicon codicon-pinned" />}
                        </div>
                        <div className="recent-path">{gone ? "Folder not found" : r.path}</div>
                      </div>
                      <span className="recent-time">{timeAgo(r.openedAt)}</span>
                      <button
                        className="icon-button recent-remove"
                        title="Remove from list"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeRecent(r.path);
                          refresh();
                        }}
                      >
                        <span className="codicon codicon-close" />
                      </button>
                    </div>
                  );
                })}
              </section>

              <section className="welcome-start">
                <h2>Get started</h2>
                <StartCard icon="codicon-folder-opened" title="Open a local folder" text="Navigate and edit code in any folder" onClick={openFolder} />
                <StartCard icon="codicon-library" title="Open a solution or project" text=".sln, .slnx or .csproj" onClick={openSolution} />
                <StartCard icon="codicon-repo-clone" title="Clone a repository" text="Get code from GitHub, Azure DevOps or any Git URL" onClick={() => setPane("clone")} />
                <StartCard icon="codicon-new-file" title="Create a new project" text="Console app, Web API, Blazor, class library, tests…" onClick={() => setPane("new")} />
                <div className="welcome-tips">
                  <h3>Shortcuts</h3>
                  <div><kbd>Ctrl+Shift+P</kbd> All commands</div>
                  <div><kbd>Ctrl+P</kbd> Go to file</div>
                  <div><kbd>Ctrl+F5</kbd> Run · <kbd>F5</kbd> Debug</div>
                  <div><kbd>Ctrl+Shift+G</kbd> Source control</div>
                </div>
              </section>
            </div>
          </>
        )}
        {pane === "new" && <NewProject onCreated={(dir, sln) => onOpen(dir, sln)} onCancel={() => setPane("start")} />}
        {pane === "clone" && <CloneRepo onCloned={(dir) => onOpen(dir)} onCancel={() => setPane("start")} />}
      </main>
    </div>
  );
}

function StartCard({ icon, title, text, onClick }: { icon: string; title: string; text: string; onClick: () => void }) {
  return (
    <button className="start-card" onClick={onClick}>
      <span className={`codicon ${icon}`} />
      <span>
        <span className="start-card-title">{title}</span>
        <span className="start-card-text">{text}</span>
      </span>
    </button>
  );
}

const palette = ["#6c5ce7", "#0984e3", "#00a085", "#e17055", "#d63031", "#e84393", "#2d98da", "#8854d0", "#20bf6b", "#fa8231"];
function badgeColor(path: string) {
  let h = 0;
  for (const c of basename(path)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

// ---------- New project ----------

const templates = [
  { id: "console", name: "Console App", icon: "codicon-terminal", text: "A command-line application" },
  { id: "webapi", name: "ASP.NET Core Web API", icon: "codicon-globe", text: "REST API with controllers or minimal APIs" },
  { id: "web", name: "ASP.NET Core Empty", icon: "codicon-globe", text: "An empty web app" },
  { id: "mvc", name: "ASP.NET Core MVC", icon: "codicon-browser", text: "Web app with views and controllers" },
  { id: "blazor", name: "Blazor Web App", icon: "codicon-browser", text: "Interactive web UI with C#" },
  { id: "worker", name: "Worker Service", icon: "codicon-gear", text: "Long-running background service" },
  { id: "classlib", name: "Class Library", icon: "codicon-package", text: "A reusable library (.dll)" },
  { id: "xunit", name: "xUnit Test Project", icon: "codicon-beaker", text: "Unit tests with xUnit" },
  { id: "nunit", name: "NUnit Test Project", icon: "codicon-beaker", text: "Unit tests with NUnit" },
  { id: "wpf", name: "WPF Application", icon: "codicon-window", text: "Windows desktop app (Windows only)" },
  { id: "winforms", name: "Windows Forms App", icon: "codicon-window", text: "Windows desktop app (Windows only)" },
];

function NewProject({ onCreated, onCancel }: { onCreated: (dir: string, solution?: string) => void; onCancel: () => void }) {
  const [template, setTemplate] = useState("console");
  const [name, setName] = useState("MyApp");
  const [location, setLocation] = useState(localStorage.getItem("frost.newProjectLocation") ?? "");
  const [withSolution, setWithSolution] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = /^[A-Za-z_][\w.]*$/.test(name) && !!location;

  const create = async () => {
    setBusy(true);
    setError(null);
    localStorage.setItem("frost.newProjectLocation", location);
    const dir = join(location, name);
    const run = async (args: string[], cwd: string) => {
      const r = await api.runCapture("dotnet", args, cwd);
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").slice(-4).join("\n"));
    };
    try {
      if (withSolution) {
        // MyApp/MyApp.slnx + MyApp/MyApp/MyApp.csproj, like Visual Studio and Rider.
        const projectDir = join(dir, name);
        await run(["new", template, "-n", name, "-o", projectDir], location);
        await run(["new", "sln", "-n", name, "-o", dir], location);
        const r = await api.listDir(dir);
        const sln = r.find((e) => /\.slnx?$/i.test(e.name))?.path;
        if (sln) await run(["sln", sln, "add", join(projectDir, `${name}.csproj`)], dir);
        onCreated(dir, sln);
      } else {
        await run(["new", template, "-n", name, "-o", dir], location);
        onCreated(dir);
      }
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
      setBusy(false);
    }
  };

  return (
    <div className="welcome-form">
      <h2>Create a new project</h2>
      <div className="template-grid">
        {templates.map((t) => (
          <button key={t.id} className={`template ${template === t.id ? "selected" : ""}`} onClick={() => setTemplate(t.id)}>
            <span className={`codicon ${t.icon}`} />
            <span>
              <span className="start-card-title">{t.name}</span>
              <span className="start-card-text">{t.text}</span>
            </span>
          </button>
        ))}
      </div>
      <label className="form-row">
        <span>Project name</span>
        <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
      </label>
      <label className="form-row">
        <span>Location</span>
        <div className="form-inline">
          <input className="text-input" value={location} placeholder="Choose a parent folder" onChange={(e) => setLocation(e.target.value)} spellCheck={false} />
          <button
            className="secondary-button"
            onClick={async () => {
              const d = (await open({ directory: true, title: "Project location" })) as string | null;
              if (d) setLocation(d);
            }}
          >
            Browse…
          </button>
        </div>
      </label>
      <label className="form-check">
        <input type="checkbox" checked={withSolution} onChange={(e) => setWithSolution(e.target.checked)} />
        Create a solution and put the project in its own folder
      </label>
      {location && valid && <div className="muted form-preview">Will create {join(location, name)}</div>}
      {error && <pre className="form-error">{error}</pre>}
      <div className="form-buttons">
        <button className="secondary-button" onClick={onCancel} disabled={busy}>
          Back
        </button>
        <button className="primary-button" onClick={create} disabled={!valid || busy}>
          {busy ? "Creating…" : "Create"}
        </button>
      </div>
    </div>
  );
}

// ---------- Clone ----------

function CloneRepo({ onCloned, onCancel }: { onCloned: (dir: string) => void; onCancel: () => void }) {
  const [url, setUrl] = useState("");
  const [location, setLocation] = useState(localStorage.getItem("frost.cloneLocation") ?? localStorage.getItem("frost.newProjectLocation") ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const repoName = url.trim().replace(/\/+$/, "").split(/[/:]/).pop()?.replace(/\.git$/, "") ?? "";
  const valid = !!url.trim() && !!location && !!repoName;

  const clone = async () => {
    setBusy(true);
    setError(null);
    localStorage.setItem("frost.cloneLocation", location);
    const dir = join(location, repoName);
    const r = await api.runCapture("git", ["clone", url.trim(), dir], location);
    if (r.code !== 0) {
      setError((r.stderr || r.stdout).trim() || "git clone failed");
      setBusy(false);
      return;
    }
    onCloned(dir);
  };

  return (
    <div className="welcome-form">
      <h2>Clone a repository</h2>
      <label className="form-row">
        <span>Repository URL</span>
        <input className="text-input" value={url} placeholder="https://github.com/user/repo.git" onChange={(e) => setUrl(e.target.value)} spellCheck={false} autoFocus />
      </label>
      <label className="form-row">
        <span>Location</span>
        <div className="form-inline">
          <input className="text-input" value={location} placeholder="Choose a parent folder" onChange={(e) => setLocation(e.target.value)} spellCheck={false} />
          <button
            className="secondary-button"
            onClick={async () => {
              const d = (await open({ directory: true, title: "Clone into" })) as string | null;
              if (d) setLocation(d);
            }}
          >
            Browse…
          </button>
        </div>
      </label>
      {valid && <div className="muted form-preview">Will clone into {join(location, repoName)}</div>}
      <div className="muted form-preview">Private repositories use your Git credentials (Git Credential Manager on Windows).</div>
      {error && <pre className="form-error">{error}</pre>}
      <div className="form-buttons">
        <button className="secondary-button" onClick={onCancel} disabled={busy}>
          Back
        </button>
        <button className="primary-button" onClick={clone} disabled={!valid || busy}>
          {busy ? "Cloning…" : "Clone"}
        </button>
      </div>
    </div>
  );
}
