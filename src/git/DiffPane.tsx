// Side-by-side diff of a changed file, shown as an editor tab ("git-diff:work:<path>").
import { useEffect, useRef, useState } from "react";
import { monaco, ensureLanguage } from "../lib/highlighting";
import { basename, relative } from "../lib/api";
import { languageForPath } from "../lib/languages";
import { openModel } from "../lib/models";
import { useStore } from "../store";
import { originalContent, useGit } from "./git";

export type DiffKind = "work" | "staged";
const PREFIX = "git-diff:";

export const diffPath = (kind: DiffKind, path: string) => `${PREFIX}${kind}:${path}`;
export const isDiffPath = (p: string | null | undefined): p is string => !!p?.startsWith(PREFIX);
export function parseDiffPath(p: string): { kind: DiffKind; path: string } {
  const rest = p.slice(PREFIX.length);
  const i = rest.indexOf(":");
  return { kind: rest.slice(0, i) as DiffKind, path: rest.slice(i + 1) };
}
export const diffLabel = (p: string) => {
  const { kind, path } = parseDiffPath(p);
  return `${basename(path)} (${kind === "staged" ? "Staged" : "Working Tree"})`;
};

let seq = 0;

export function DiffPane({ spec }: { spec: string }) {
  const host = useRef<HTMLDivElement>(null);
  const settings = useStore((s) => s.settings);
  const [error, setError] = useState<string | null>(null);
  const [inline, setInline] = useState(false);

  useEffect(() => {
    const { kind, path } = parseDiffPath(spec);
    const repo = useGit.getState().repo;
    if (!repo) return;
    const rel = relative(repo, path).replace(/\\/g, "/");
    const lang = languageForPath(path);
    const editor = monaco.editor.createDiffEditor(host.current!, {
      automaticLayout: true,
      renderSideBySide: !inline,
      originalEditable: false,
      fontSize: settings["editor.fontSize"],
      fontFamily: settings["editor.fontFamily"],
      fontLigatures: settings["editor.fontLigatures"],
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderOverviewRuler: true,
      ignoreTrimWhitespace: false,
      readOnly: kind === "staged",
    });
    let original: monaco.editor.ITextModel | null = null;
    let stagedModel: monaco.editor.ITextModel | null = null;
    let disposed = false;
    // After a commit, stage or pull, the left side changes: reload it.
    const reloadOriginal = async () => {
      if (!original || disposed) return;
      const text = kind === "staged" ? await originalContent(rel) : (await originalContent(rel, true)) || (await originalContent(rel));
      if (!disposed && original.getValue() !== text) original.setValue(text);
      if (kind === "staged" && stagedModel && !disposed) {
        const index = await originalContent(rel, true);
        if (stagedModel.getValue() !== index) stagedModel.setValue(index);
      }
    };
    const unsub = useGit.subscribe((g, prev) => {
      if (g.staged !== prev.staged || g.changes !== prev.changes || g.branch !== prev.branch) reloadOriginal();
    });
    (async () => {
      try {
        await ensureLanguage(lang);
        const id = ++seq;
        if (kind === "staged") {
          const [head, index] = await Promise.all([originalContent(rel), originalContent(rel, true)]);
          original = monaco.editor.createModel(head, lang, monaco.Uri.parse(`git-head:/${id}/${rel}`));
          stagedModel = monaco.editor.createModel(index, lang, monaco.Uri.parse(`git-index:/${id}/${rel}`));
          if (!disposed) editor.setModel({ original, modified: stagedModel });
        } else {
          // Working tree against the index (what `git diff` shows); falls back to HEAD.
          const base = (await originalContent(rel, true)) || (await originalContent(rel));
          original = monaco.editor.createModel(base, lang, monaco.Uri.parse(`git-index:/${id}/${rel}`));
          let modified: monaco.editor.ITextModel;
          try {
            modified = await openModel(path);
          } catch {
            modified = monaco.editor.createModel("", lang, monaco.Uri.parse(`git-deleted:/${id}/${rel}`)); // deleted file
          }
          if (!disposed) editor.setModel({ original, modified });
        }
      } catch (e) {
        setError(String(e));
      }
    })();
    return () => {
      disposed = true;
      unsub();
      editor.setModel(null);
      editor.dispose();
      original?.dispose();
      stagedModel?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, inline]);

  return (
    <div className="diff-pane">
      <div className="diff-toolbar">
        <span className="muted">{parseDiffPath(spec).kind === "staged" ? "HEAD ↔ Staged" : "Index ↔ Working Tree (editable on the right)"}</span>
        <span className="panel-spacer" />
        <button className="icon-button" title={inline ? "Side by side" : "Inline"} onClick={() => setInline(!inline)}>
          <span className={`codicon ${inline ? "codicon-split-horizontal" : "codicon-list-flat"}`} />
        </button>
        <button className="icon-button" title="Open File" onClick={() => useStore.getState().openFile(parseDiffPath(spec).path)}>
          <span className="codicon codicon-go-to-file" />
        </button>
      </div>
      <div ref={host} className="diff-host" />
      {error && <div className="editor-error">{error}</div>}
    </div>
  );
}
