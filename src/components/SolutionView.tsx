import { useCallback, useEffect, useState } from "react";
import { api, basename, samePath, type DirEntry, type ProjectInfo } from "../lib/api";
import { fileIcon } from "../lib/icons";
import { useStore } from "../store";
import { chooseSolution, loadSolution, setStartup, useSolution } from "../dotnet/solution";
import { runBuild, useBuild } from "../dotnet/build";
import { runProject } from "../dotnet/run";
import { ContextMenu, type MenuItem } from "./ContextMenu";

const HIDDEN = new Set(["bin", "obj", ".vs", ".idea", "node_modules"]);

export function SolutionView() {
  const root = useStore((s) => s.root);
  const { solution, solutions, projects, startup, loading } = useSolution();
  const building = useBuild((s) => s.running);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["@solution"]));
  const [children, setChildren] = useState<Record<string, DirEntry[]>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  const load = useCallback(async (dir: string) => {
    try {
      const list = (await api.listDir(dir)).filter((e) => !HIDDEN.has(e.name) && !/\.(csproj|fsproj|vbproj)$/i.test(e.name));
      setChildren((c) => ({ ...c, [dir]: list }));
    } catch {
      /* folder gone */
    }
  }, []);

  // Keep listed folders fresh.
  useEffect(() => {
    const un = api.onFsChange((c) => {
      for (const d of c.dirs) if (Object.keys(children).some((k) => samePath(k, d))) load(d);
      if (c.paths.some((p) => /\.(csproj|sln|slnx|props)$/i.test(p))) loadSolution(useStore.getState().root);
    });
    return () => void un.then((f) => f());
  }, [children, load]);

  const toggle = (key: string, dir?: string) =>
    setExpanded((e) => {
      const n = new Set(e);
      if (n.has(key)) n.delete(key);
      else {
        n.add(key);
        if (dir && !children[dir]) load(dir);
      }
      return n;
    });

  if (!root) return <Empty text="Open a folder with a .NET solution or project." />;
  if (loading && !projects.length) return <Empty text="Loading solution…" />;
  if (!projects.length) return <Empty text="No .NET projects found in this folder. Open a folder that contains a .sln, .slnx or .csproj." />;

  const projectMenu = (e: React.MouseEvent, p: ProjectInfo) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "Build", action: () => runBuild("build", p.path), disabled: !!building },
        { label: "Rebuild", action: () => runBuild("rebuild", p.path), disabled: !!building },
        { label: "Clean", action: () => runBuild("clean", p.path), disabled: !!building },
        { separator: true },
        { label: "Run", action: () => runProject("run", p.path), disabled: !p.isRunnable },
        { label: "Run with Hot Reload (dotnet watch)", action: () => runProject("watch", p.path), disabled: !p.isRunnable },
        { label: "Set as Startup Project", action: () => setStartup(p.path), disabled: !p.isRunnable },
        { separator: true },
        { label: "Edit Project File", action: () => useStore.getState().openFile(p.path) },
        { label: "Open in Terminal", action: () => window.dispatchEvent(new CustomEvent("ide:new-terminal", { detail: { cwd: p.dir } })) },
        { label: "Copy Path", action: () => navigator.clipboard.writeText(p.path) },
      ],
    });
  };

  const solutionName = solution ? basename(solution) : basename(root);

  return (
    <div className="sidebar-view">
      <div className="sidebar-title">
        <span>Solution</span>
      </div>
      {solutions.length > 1 && (
        <div className="solution-picker">
          <select className="text-input" value={solution ?? ""} onChange={(e) => chooseSolution(e.target.value)}>
            {solutions.map((s) => (
              <option key={s} value={s}>
                {basename(s)}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="tree static" tabIndex={0}>
        <Row depth={0} open={expanded.has("@solution")} onClick={() => toggle("@solution")} icon="codicon-library" iconColor="#9b7bd4" bold>
          {solutionName} <span className="muted">· {projects.length} project{projects.length === 1 ? "" : "s"}</span>
        </Row>
        {expanded.has("@solution") &&
          projects.map((p) => {
            const key = `p:${p.path}`;
            const open = expanded.has(key);
            const isStartup = startup && samePath(startup, p.path);
            return (
              <div key={p.path}>
                <Row
                  depth={1}
                  open={open}
                  onClick={() => toggle(key, p.dir)}
                  onDoubleClick={() => useStore.getState().openFile(p.path)}
                  onContextMenu={(e) => projectMenu(e, p)}
                  icon={p.isTest ? "codicon-beaker" : p.isRunnable ? "codicon-rocket" : "codicon-package"}
                  iconColor={p.isTest ? "#59a869" : p.isRunnable ? "#3794ff" : "#9b7bd4"}
                  bold={!!isStartup}
                  title={p.path}
                >
                  {p.name} <span className="muted">{p.targetFrameworks.join(", ")}</span>
                  {isStartup && <span className="startup-tag">startup</span>}
                </Row>
                {open && (
                  <>
                    <Dependencies project={p} expanded={expanded} toggle={toggle} />
                    <Folder dir={p.dir} depth={2} children={children} expanded={expanded} toggle={toggle} />
                  </>
                )}
              </div>
            );
          })}
      </div>
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

function Dependencies({ project, expanded, toggle }: { project: ProjectInfo; expanded: Set<string>; toggle: (k: string) => void }) {
  const key = `deps:${project.path}`;
  const open = expanded.has(key);
  const pk = `pkgs:${project.path}`;
  const rk = `refs:${project.path}`;
  return (
    <>
      <Row depth={2} open={open} onClick={() => toggle(key)} icon="codicon-references" iconColor="#a0a0a0">
        Dependencies
      </Row>
      {open && (
        <>
          <Row depth={3} icon="codicon-server-environment" iconColor="#a0a0a0">
            Frameworks <span className="muted">{project.targetFrameworks.join(", ") || "—"}</span>
          </Row>
          <Row depth={3} open={expanded.has(pk)} onClick={() => toggle(pk)} icon="codicon-package" iconColor="#a0a0a0">
            Packages <span className="muted">{project.packages.length}</span>
          </Row>
          {expanded.has(pk) &&
            project.packages.map((p) => (
              <Row key={p.name} depth={4} icon="codicon-package" iconColor="#c09553">
                {p.name} <span className="muted">{p.version ?? "(central)"}</span>
              </Row>
            ))}
          <Row depth={3} open={expanded.has(rk)} onClick={() => toggle(rk)} icon="codicon-symbol-reference" iconColor="#a0a0a0">
            Projects <span className="muted">{project.projectRefs.length}</span>
          </Row>
          {expanded.has(rk) &&
            project.projectRefs.map((r) => (
              <Row key={r} depth={4} icon="codicon-package" iconColor="#9b7bd4" title={r}>
                {basename(r).replace(/\.\w+proj$/, "")}
              </Row>
            ))}
        </>
      )}
    </>
  );
}

function Folder(props: { dir: string; depth: number; children: Record<string, DirEntry[]>; expanded: Set<string>; toggle: (k: string, dir?: string) => void }) {
  const { dir, depth, children, expanded, toggle } = props;
  const activePath = useStore((s) => s.groups[s.activeGroup]?.active ?? null);
  return (
    <>
      {(children[dir] ?? []).map((e) => {
        if (e.isDir) {
          const key = `d:${e.path}`;
          return (
            <div key={e.path}>
              <Row depth={depth} open={expanded.has(key)} onClick={() => toggle(key, e.path)} icon={expanded.has(key) ? "codicon-folder-opened" : "codicon-folder"} iconColor="#dcb67a">
                {e.name}
              </Row>
              {expanded.has(key) && <Folder {...props} dir={e.path} depth={depth + 1} />}
            </div>
          );
        }
        const icon = fileIcon(e.name);
        return (
          <Row
            key={e.path}
            depth={depth}
            icon={icon.icon}
            iconColor={icon.color}
            active={!!activePath && samePath(activePath, e.path)}
            onClick={() => useStore.getState().openFile(e.path)}
            title={e.path}
          >
            {e.name}
          </Row>
        );
      })}
    </>
  );
}

function Row(props: {
  depth: number;
  open?: boolean;
  icon: string;
  iconColor?: string;
  bold?: boolean;
  active?: boolean;
  title?: string;
  children: React.ReactNode;
  onClick?: () => void;
  onDoubleClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      className={`tree-row static ${props.active ? "active-file" : ""}`}
      style={{ paddingLeft: 8 + props.depth * 12 }}
      onClick={props.onClick}
      onDoubleClick={props.onDoubleClick}
      onContextMenu={props.onContextMenu}
      title={props.title}
    >
      {props.open === undefined ? <span className="twisty-space" /> : <span className={`codicon ${props.open ? "codicon-chevron-down" : "codicon-chevron-right"} twisty`} />}
      <span className={`codicon ${props.icon} file-icon`} style={{ color: props.iconColor }} />
      <span className="tree-label" style={{ fontWeight: props.bold ? 600 : undefined }}>
        {props.children}
      </span>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="sidebar-view">
      <div className="sidebar-title">Solution</div>
      <div className="empty-explorer">
        <p>{text}</p>
      </div>
    </div>
  );
}

