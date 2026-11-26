import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { api, basename, dirname, join, relative, samePath, type DirEntry } from "../lib/api";
import { renameModels, disposeModel } from "../lib/models";
import { fileIcon } from "../lib/icons";
import { useStore } from "../store";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { decorationFor, useGit } from "../git/git";

const ROW = 22;

interface Row {
  entry: DirEntry;
  depth: number;
}

type Edit =
  | { kind: "rename"; path: string }
  | { kind: "new-file" | "new-folder"; parent: string };

export function Explorer({ onOpenFolder }: { onOpenFolder: () => void }) {
  const root = useStore((s) => s.root);
  const selected = useStore((s) => s.selected);
  const select = useStore((s) => s.select);
  const openFile = useStore((s) => s.openFile);
  const toast = useStore((s) => s.toast);
  const activePath = useStore((s) => s.groups[s.activeGroup]?.active ?? null);
  useGit((g) => g.changes);
  useGit((g) => g.staged);

  const [children, setChildren] = useState<Record<string, DirEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [edit, setEdit] = useState<Edit | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (dir: string) => {
    try {
      // Like VS Code, the .git folder isn't shown.
      const list = (await api.listDir(dir)).filter((e) => e.name !== ".git");
      setChildren((c) => ({ ...c, [dir]: list }));
    } catch {
      setChildren((c) => {
        const copy = { ...c };
        delete copy[dir];
        return copy;
      });
    }
  }, []);

  // New folder opened: reset the tree.
  useEffect(() => {
    setChildren({});
    setExpanded(new Set());
    if (root) load(root);
  }, [root, load]);

  // Refresh directories that changed on disk.
  const childrenRef = useRef(children);
  childrenRef.current = children;
  useEffect(() => {
    const un = api.onFsChange((c) => {
      for (const d of c.dirs) {
        const key = Object.keys(childrenRef.current).find((k) => samePath(k, d));
        if (key) load(key);
      }
    });
    return () => void un.then((f) => f());
  }, [load]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [root]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (dir: string, depth: number) => {
      for (const entry of children[dir] ?? []) {
        out.push({ entry, depth });
        if (entry.isDir && expanded.has(entry.path)) walk(entry.path, depth + 1);
      }
    };
    if (root) walk(root, 0);
    return out;
  }, [children, expanded, root]);

  const toggle = (path: string) => {
    setExpanded((e) => {
      const next = new Set(e);
      if (next.has(path)) next.delete(path);
      else {
        next.add(path);
        if (!children[path]) load(path);
      }
      return next;
    });
  };

  const expand = (path: string) => {
    if (!expanded.has(path)) toggle(path);
  };

  // --- file operations ---

  const commitEdit = async (value: string) => {
    const e = edit;
    setEdit(null);
    const name = value.trim();
    if (!e || !name) return;
    try {
      if (e.kind === "rename") {
        if (name === basename(e.path)) return;
        const to = join(dirname(e.path), name);
        await api.rename(e.path, to);
        const moved = await renameModels(e.path, to);
        useStore.getState().replacePaths(moved);
        select(to);
      } else {
        const path = join(e.parent, name);
        if (e.kind === "new-file") {
          await api.createFile(path);
          openFile(path);
        } else await api.createDir(path);
        select(path);
        await load(e.parent);
      }
    } catch (err) {
      toast(String(err), "error");
    }
  };

  const remove = async (path: string) => {
    const ok = await ask(`Delete "${basename(path)}"? This can't be undone.`, {
      title: "Delete",
      kind: "warning",
      okLabel: "Delete",
    });
    if (!ok) return;
    try {
      await api.remove(path);
      const s = useStore.getState();
      const open = s.groups.flatMap((g) => g.tabs).filter((t) => samePath(t, path) || t.startsWith(path));
      s.closePaths(path);
      open.forEach(disposeModel);
      await load(dirname(path));
    } catch (err) {
      toast(String(err), "error");
    }
  };

  const move = async (from: string, toDir: string) => {
    if (samePath(dirname(from), toDir) || samePath(from, toDir)) return;
    const to = join(toDir, basename(from));
    try {
      await api.rename(from, to);
      const moved = await renameModels(from, to);
      useStore.getState().replacePaths(moved);
      await Promise.all([load(dirname(from)), load(toDir)]);
      expand(toDir);
    } catch (err) {
      toast(String(err), "error");
    }
  };

  const startNew = (kind: "new-file" | "new-folder", target?: DirEntry) => {
    if (!root) return;
    const parent = target ? (target.isDir ? target.path : dirname(target.path)) : root;
    if (parent !== root) expand(parent);
    setEdit({ kind, parent });
  };

  const openMenu = (ev: React.MouseEvent, entry?: DirEntry) => {
    ev.preventDefault();
    if (!root) return;
    if (entry) select(entry.path);
    const items: MenuItem[] = [
      { label: "New File…", action: () => startNew("new-file", entry) },
      { label: "New Folder…", action: () => startNew("new-folder", entry) },
    ];
    if (entry) {
      items.push(
        { separator: true },
        { label: "Rename", hint: "F2", action: () => setEdit({ kind: "rename", path: entry.path }) },
        { label: "Delete", hint: "Del", action: () => remove(entry.path) },
        { separator: true },
        { label: "Copy Path", action: () => navigator.clipboard.writeText(entry.path) },
        { label: "Copy Relative Path", action: () => navigator.clipboard.writeText(relative(root, entry.path)) },
      );
    }
    items.push(
      { separator: true },
      {
        label: "Open in Terminal",
        action: () =>
          window.dispatchEvent(
            new CustomEvent("ide:new-terminal", {
              detail: { cwd: entry ? (entry.isDir ? entry.path : dirname(entry.path)) : root },
            }),
          ),
      },
    );
    setMenu({ x: ev.clientX, y: ev.clientY, items });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!selected || edit) return;
    const idx = rows.findIndex((r) => r.entry.path === selected);
    const row = rows[idx];
    if (e.key === "F2") setEdit({ kind: "rename", path: selected });
    else if (e.key === "Delete") remove(selected);
    else if (e.key === "ArrowDown" && idx < rows.length - 1) select(rows[idx + 1].entry.path);
    else if (e.key === "ArrowUp" && idx > 0) select(rows[idx - 1].entry.path);
    else if (e.key === "ArrowRight" && row?.entry.isDir) expand(row.entry.path);
    else if (e.key === "ArrowLeft" && row) {
      if (row.entry.isDir && expanded.has(row.entry.path)) toggle(row.entry.path);
      else if (!samePath(dirname(row.entry.path), root ?? "")) select(dirname(row.entry.path));
    } else if (e.key === "Enter" && row) {
      if (row.entry.isDir) toggle(row.entry.path);
      else openFile(row.entry.path);
    } else return;
    e.preventDefault();
  };

  // Keep the selected row in view when using the keyboard.
  useEffect(() => {
    const idx = rows.findIndex((r) => r.entry.path === selected);
    const el = listRef.current;
    if (idx < 0 || !el) return;
    if (idx * ROW < el.scrollTop) el.scrollTop = idx * ROW;
    else if ((idx + 1) * ROW > el.scrollTop + el.clientHeight) el.scrollTop = (idx + 1) * ROW - el.clientHeight;
  }, [selected, rows]);

  if (!root) {
    return (
      <div className="sidebar-view">
        <div className="sidebar-title">Explorer</div>
        <div className="empty-explorer">
          <p>You have not opened a folder yet.</p>
          <button className="primary-button" onClick={onOpenFolder}>
            Open Folder
          </button>
        </div>
      </div>
    );
  }

  // Inline input rows for "new file/folder" go right under their parent folder.
  const display: (Row | { input: Edit; depth: number })[] = [];
  if (edit && edit.kind !== "rename" && samePath(edit.parent, root)) display.push({ input: edit, depth: 0 });
  for (const r of rows) {
    display.push(r);
    if (edit && edit.kind !== "rename" && samePath(edit.parent, r.entry.path)) display.push({ input: edit, depth: r.depth + 1 });
  }

  const first = Math.max(0, Math.floor(scrollTop / ROW) - 10);
  const last = Math.min(display.length, Math.ceil((scrollTop + height) / ROW) + 10);

  return (
    <div className="sidebar-view">
      <div className="sidebar-title">
        <span>Explorer</span>
      </div>
      <div className="section-header">
        <span className="codicon codicon-chevron-down" />
        <span className="section-name">{basename(root)}</span>
        <span className="section-actions">
          <button title="New File" className="icon-button" onClick={() => startNew("new-file", rowFor(selected, rows))}>
            <span className="codicon codicon-new-file" />
          </button>
          <button title="New Folder" className="icon-button" onClick={() => startNew("new-folder", rowFor(selected, rows))}>
            <span className="codicon codicon-new-folder" />
          </button>
          <button title="Refresh" className="icon-button" onClick={() => Object.keys(children).forEach(load)}>
            <span className="codicon codicon-refresh" />
          </button>
          <button title="Collapse All" className="icon-button" onClick={() => setExpanded(new Set())}>
            <span className="codicon codicon-collapse-all" />
          </button>
        </span>
      </div>
      <div
        className={`tree ${dropTarget && samePath(dropTarget, root) ? "drop-root" : ""}`}
        ref={listRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onContextMenu={(e) => openMenu(e)}
        onDragOver={(e) => {
          e.preventDefault();
          setDropTarget(root);
        }}
        onDragLeave={() => setDropTarget(null)}
        onDrop={(e) => {
          e.preventDefault();
          const from = e.dataTransfer.getData("text/x-ide-path");
          setDropTarget(null);
          if (from) move(from, root);
        }}
      >
        <div style={{ height: display.length * ROW, position: "relative" }}>
          {display.slice(first, last).map((item, i) => {
            const top = (first + i) * ROW;
            if ("input" in item) {
              return (
                <div key="new-input" className="tree-row" style={{ top, paddingLeft: 8 + item.depth * 12 }}>
                  <span className={`codicon ${item.input.kind === "new-folder" ? "codicon-folder" : "codicon-file"}`} />
                  <InlineInput initial="" onDone={commitEdit} onCancel={() => setEdit(null)} />
                </div>
              );
            }
            const { entry, depth } = item;
            const isOpen = expanded.has(entry.path);
            const renaming = edit?.kind === "rename" && edit.path === entry.path;
            const icon = entry.isDir ? null : fileIcon(entry.name);
            const deco = entry.isDir ? null : decorationFor(entry.path);
            return (
              <div
                key={entry.path}
                className={[
                  "tree-row",
                  selected === entry.path ? "selected" : "",
                  activePath && samePath(activePath, entry.path) ? "active-file" : "",
                  dropTarget === entry.path ? "drop-target" : "",
                ].join(" ")}
                style={{ top, paddingLeft: 8 + depth * 12 }}
                draggable={!renaming}
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/x-ide-path", entry.path);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e) => {
                  if (!entry.isDir) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setDropTarget(entry.path);
                }}
                onDrop={(e) => {
                  if (!entry.isDir) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const from = e.dataTransfer.getData("text/x-ide-path");
                  setDropTarget(null);
                  if (from) move(from, entry.path);
                }}
                onClick={() => {
                  select(entry.path);
                  if (entry.isDir) toggle(entry.path);
                  else openFile(entry.path);
                }}
                onContextMenu={(e) => {
                  e.stopPropagation();
                  openMenu(e, entry);
                }}
                title={entry.path}
              >
                {entry.isDir ? (
                  <span className={`codicon ${isOpen ? "codicon-chevron-down" : "codicon-chevron-right"} twisty`} />
                ) : (
                  <span className="twisty-space" />
                )}
                {entry.isDir ? (
                  <span className={`codicon ${isOpen ? "codicon-folder-opened" : "codicon-folder"} file-icon folder`} />
                ) : (
                  <span className={`codicon ${icon!.icon} file-icon`} style={{ color: icon!.color }} />
                )}
                {renaming ? (
                  <InlineInput initial={entry.name} onDone={commitEdit} onCancel={() => setEdit(null)} />
                ) : (
                  <>
                    <span className="tree-label" style={{ color: deco?.color }}>
                      {entry.name}
                    </span>
                    {deco && (
                      <span className="tree-deco" style={{ color: deco.color }}>
                        {deco.letter}
                      </span>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

function rowFor(path: string | null, rows: Row[]) {
  return rows.find((r) => r.entry.path === path)?.entry;
}

function InlineInput({ initial, onDone, onCancel }: { initial: string; onDone: (v: string) => void; onCancel: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current!;
    el.focus();
    const dot = initial.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);
  const finish = (fn: () => void) => {
    if (done.current) return;
    done.current = true;
    fn();
  };
  return (
    <input
      ref={ref}
      className="inline-input"
      defaultValue={initial}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(() => onDone(e.currentTarget.value));
        if (e.key === "Escape") finish(onCancel);
      }}
      onBlur={(e) => finish(() => onDone(e.currentTarget.value))}
    />
  );
}
