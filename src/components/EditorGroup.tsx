import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { monaco } from "../lib/highlighting";
import { basename, relative, samePath } from "../lib/api";
import { openModel, isDirty, onDirtyChange, saveModel, disposeModel } from "../lib/models";
import { fileIcon } from "../lib/icons";
import { useStore, type EditorGroup as Group } from "../store";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { attachDebugToEditor } from "../dap/editorDebug";
import { addRunActions } from "../dotnet/editorRun";
import { DiffPane, diffLabel, isDiffPath, parseDiffPath } from "../git/DiffPane";
import { decorationFor, useGit } from "../git/git";
import type { Settings } from "../lib/settings";

const editors = new Map<number, monaco.editor.IStandaloneCodeEditor>();

// "Go to Definition" into another file opens it as a tab instead of doing nothing.
monaco.editor.registerEditorOpener({
  openCodeEditor(_source, resource, selectionOrPosition) {
    if (resource.scheme !== "file") return false;
    const pos = selectionOrPosition
      ? "startLineNumber" in selectionOrPosition
        ? { line: selectionOrPosition.startLineNumber, column: selectionOrPosition.startColumn }
        : { line: selectionOrPosition.lineNumber, column: selectionOrPosition.column }
      : undefined;
    useStore.getState().openFile(resource.fsPath, pos ?? {});
    return true;
  },
});

/** The Monaco editor of the focused group (used by commands like "Go to Line"). */
export const activeEditor = () => {
  const s = useStore.getState();
  return editors.get(s.groups[s.activeGroup]?.id ?? -1) ?? null;
};

function editorOptions(s: Settings): monaco.editor.IEditorOptions & monaco.editor.IGlobalEditorOptions {
  return {
    fontSize: s["editor.fontSize"],
    fontFamily: s["editor.fontFamily"],
    fontLigatures: s["editor.fontLigatures"],
    tabSize: s["editor.tabSize"],
    insertSpaces: s["editor.insertSpaces"],
    wordWrap: s["editor.wordWrap"],
    minimap: { enabled: s["editor.minimap.enabled"] },
    lineNumbers: s["editor.lineNumbers"],
  };
}

/** Closes a tab, asking to save first if it has unsaved changes. */
export async function closeTabSafely(gi: number, path: string) {
  const s = useStore.getState();
  const openElsewhere = s.groups.some((g, i) => i !== gi && g.tabs.includes(path));
  if (!openElsewhere && isDirty(path)) {
    const save = await ask(`Do you want to save the changes you made to ${basename(path)}?`, {
      title: "Unsaved changes",
      kind: "warning",
      okLabel: "Save",
      cancelLabel: "Don't Save",
    });
    if (save) await saveModel(path);
  }
  useStore.getState().closeTab(gi, path);
  if (!openElsewhere) disposeModel(path);
}

export function EditorGroup({ group, index, focused }: { group: Group; index: number; focused: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const viewStates = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>());
  const shownPath = useRef<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const settings = useStore((s) => s.settings);
  const root = useStore((s) => s.root);
  const reveal = useStore((s) => s.reveal);
  const dirtyTick = useSyncExternalStore(onDirtyChange, () => dirtyVersion());

  // Create the editor once per group.
  useEffect(() => {
    const editor = monaco.editor.create(containerRef.current!, {
      ...editorOptions(useStore.getState().settings),
      automaticLayout: true,
      model: null,
      smoothScrolling: true,
      cursorSmoothCaretAnimation: "on",
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: "active", indentation: true },
      renderWhitespace: "selection",
      stickyScroll: { enabled: true },
      scrollBeyondLastLine: false,
      padding: { top: 6 },
      glyphMargin: true,
    });
    const debugSubs = attachDebugToEditor(editor);
    const runActions = addRunActions(editor);
    editorRef.current = editor;
    editors.set(group.id, editor);
    const subs = [
      editor.onDidFocusEditorText(() => {
        const s = useStore.getState();
        const gi = s.groups.findIndex((g) => g.id === group.id);
        if (gi >= 0 && gi !== s.activeGroup) s.focusGroup(gi);
        const p = editor.getPosition();
        if (p) s.setCursor({ line: p.lineNumber, column: p.column });
      }),
      editor.onDidChangeCursorPosition((e) => {
        if (editor.hasTextFocus()) useStore.getState().setCursor({ line: e.position.lineNumber, column: e.position.column });
      }),
    ];
    return () => {
      subs.forEach((d) => d.dispose());
      debugSubs.dispose();
      runActions.forEach((a) => a.dispose());
      editors.delete(group.id);
      editor.dispose();
    };
  }, [group.id]);

  useEffect(() => {
    editorRef.current?.updateOptions(editorOptions(settings));
  }, [settings]);

  // Show the active tab's file.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const path = group.active;
    if (shownPath.current) viewStates.current.set(shownPath.current, editor.saveViewState());
    if (!path || isDiffPath(path)) {
      editor.setModel(null);
      shownPath.current = null;
      return;
    }
    let cancelled = false;
    openModel(path)
      .then((model) => {
        if (cancelled) return;
        setError(null);
        editor.setModel(model);
        const vs = viewStates.current.get(path);
        if (vs) editor.restoreViewState(vs);
        shownPath.current = path;
        if (useStore.getState().groups[useStore.getState().activeGroup]?.id === group.id) editor.focus();
      })
      .catch((e) => {
        if (cancelled) return;
        editor.setModel(null);
        shownPath.current = null;
        setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [group.active, group.id]);

  // Jump to a line (from search results, quick open "file:line", go to line).
  useEffect(() => {
    if (!reveal || !focused || !group.active || !samePath(reveal.path, group.active)) return;
    const editor = editorRef.current!;
    const go = () => {
      const pos = { lineNumber: reveal.line, column: reveal.column };
      editor.setPosition(pos);
      editor.revealPositionInCenter(pos);
      editor.focus();
    };
    // The model may still be loading.
    if (editor.getModel() && samePath(editor.getModel()!.uri.fsPath, reveal.path)) go();
    else {
      const d = editor.onDidChangeModel(() => {
        d.dispose();
        go();
      });
      return () => d.dispose();
    }
  }, [reveal, focused, group.active]);

  const tabMenu = (e: React.MouseEvent, path: string) => {
    e.preventDefault();
    const s = useStore.getState();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "Close", hint: "Ctrl+W", action: () => closeTabSafely(index, path) },
        { label: "Close Others", action: () => group.tabs.filter((t) => t !== path).forEach((t) => closeTabSafely(index, t)) },
        { separator: true },
        { label: "Copy Path", action: () => navigator.clipboard.writeText(path) },
        { label: "Copy Relative Path", action: () => navigator.clipboard.writeText(root ? relative(root, path) : path) },
        { label: "Reveal in Explorer", action: () => (s.select(path), s.sidebar !== "explorer" && s.toggleSidebar("explorer")) },
        { separator: true },
        { label: "Split Right", hint: "Ctrl+\\", action: () => (s.setActiveTab(index, path), s.splitRight()) },
      ],
    });
  };

  const realActive = isDiffPath(group.active) ? parseDiffPath(group.active).path : group.active;
  const crumbs = realActive ? (root ? relative(root, realActive) : realActive).split(/[\\/]/) : [];
  const showingDiff = isDiffPath(group.active);
  useGit((g) => g.changes);

  return (
    <div className={`editor-group ${focused ? "focused" : ""}`} onMouseDown={() => !focused && useStore.getState().focusGroup(index)}>
      <div className="tabs" onWheel={(e) => (e.currentTarget.scrollLeft += e.deltaY)} data-dirty={dirtyTick}>
        {group.tabs.map((path) => {
          const real = isDiffPath(path) ? parseDiffPath(path).path : path;
          const icon = fileIcon(basename(real));
          const deco = isDiffPath(path) ? null : decorationFor(path);
          const dirty = isDirty(path);
          const active = path === group.active;
          return (
            <div
              key={path}
              className={`tab ${active ? "active" : ""} ${dirty ? "dirty" : ""}`}
              title={path}
              onClick={() => useStore.getState().setActiveTab(index, path)}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  closeTabSafely(index, path);
                }
              }}
              onContextMenu={(e) => tabMenu(e, path)}
            >
              <span className={`codicon ${icon.icon} file-icon`} style={{ color: icon.color }} />
              <span className="tab-label" style={{ color: deco?.color }}>
                {isDiffPath(path) ? diffLabel(path) : basename(path)}
              </span>
              <button
                className="tab-close icon-button"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTabSafely(index, path);
                }}
              >
                <span className={`codicon ${dirty ? "codicon-circle-filled" : "codicon-close"}`} />
              </button>
            </div>
          );
        })}
        <div className="tabs-filler" />
        {index === useStore.getState().groups.length - 1 && (
          <button className="icon-button tabs-action" title="Split Editor Right (Ctrl+\)" onClick={() => useStore.getState().splitRight()}>
            <span className="codicon codicon-split-horizontal" />
          </button>
        )}
      </div>
      {crumbs.length > 0 && (
        <div className="breadcrumbs">
          {crumbs.map((c, i) => (
            <span key={i} className="crumb">
              {i > 0 && <span className="codicon codicon-chevron-right" />}
              {c}
            </span>
          ))}
        </div>
      )}
      <div className="editor-host">
        <div ref={containerRef} className="monaco-container" style={{ visibility: group.active && !error && !showingDiff ? "visible" : "hidden" }} />
        {showingDiff && <DiffPane key={group.active!} spec={group.active!} />}
        {!group.active && <Watermark />}
        {error && <div className="editor-error">{error}</div>}
      </div>
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

let dv = 0;
onDirtyChange(() => dv++);
const dirtyVersion = () => dv;

function Watermark() {
  const rows: [string, string][] = [
    ["Show All Commands", "Ctrl+Shift+P"],
    ["Go to File", "Ctrl+P"],
    ["Find in Files", "Ctrl+Shift+F"],
    ["Toggle Terminal", "Ctrl+`"],
    ["Open Folder", "Ctrl+O"],
  ];
  return (
    <div className="watermark">
      <div className="watermark-logo codicon codicon-code" />
      <table>
        <tbody>
          {rows.map(([label, keys]) => (
            <tr key={label}>
              <td>{label}</td>
              <td>
                {keys.split(" ").map((k) => (
                  <kbd key={k}>{k}</kbd>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
