import { useEffect, useMemo, useRef, useState } from "react";
import { api, basename, dirname, relative } from "../lib/api";
import { allCommands, markRecent, recentCommands, type Command } from "../lib/commands";
import { fuzzyFilter } from "../lib/fuzzy";
import { applyTheme, listThemes, type ThemeInfo } from "../lib/highlighting";
import { updateSetting } from "../lib/settings";
import { fileIcon } from "../lib/icons";
import { activeEditor } from "./EditorGroup";
import { useStore, type PaletteMode } from "../store";
import { searchSymbols, useCsharp } from "../lsp/roslyn";
import { setStartup, useSolution } from "../dotnet/solution";
import { attachToProcess } from "../dap/session";

interface Item {
  key: string;
  label: string;
  detail?: string;
  hint?: string;
  icon?: { icon: string; color?: string };
  positions?: number[];
  group?: string;
  run: () => void;
  preview?: () => void;
}

const prefixFor: Record<PaletteMode, string> = { commands: ">", files: "", line: ":", themes: "", symbols: "#", projects: "", processes: "" };

export function Palette() {
  const palette = useStore((s) => s.palette)!;
  const root = useStore((s) => s.root);
  const close = useStore((s) => s.closePalette);
  const [mode, setMode] = useState<PaletteMode>(palette.mode);
  const [text, setText] = useState(prefixFor[palette.mode]);
  const [index, setIndex] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  const [themes, setThemes] = useState<ThemeInfo[]>([]);
  const [processes, setProcesses] = useState<{ pid: number; name: string; command: string }[]>([]);
  const [symbols, setSymbols] = useState<Awaited<ReturnType<typeof searchSymbols>>>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const originalTheme = useRef(useStore.getState().settings["workbench.colorTheme"]);
  const committed = useRef(false);

  useEffect(() => {
    setMode(palette.mode);
    setText(prefixFor[palette.mode]);
    setIndex(0);
    inputRef.current?.focus();
  }, [palette.nonce, palette.mode]);

  useEffect(() => {
    if (mode === "files" && root) api.listFiles(root).then(setFiles).catch(() => setFiles([]));
    if (mode === "themes") listThemes().then(setThemes);
    if (mode === "processes") api.listProcesses().then(setProcesses);
  }, [mode, root]);

  // Typing ">", ":" or "#" switches mode, like VS Code.
  const onChange = (v: string) => {
    if (mode !== "themes" && mode !== "projects" && mode !== "processes") {
      if (v.startsWith(">")) setMode("commands");
      else if (v.startsWith(":")) setMode("line");
      else if (v.startsWith("#")) setMode("symbols");
      else setMode("files");
    }
    setText(v);
    setIndex(0);
  };

  const query = mode === "commands" || mode === "line" || mode === "symbols" ? text.slice(1).trim() : text.trim();

  // Workspace symbols come from the language server, debounced.
  useEffect(() => {
    if (mode !== "symbols") return;
    if (!query) return setSymbols([]);
    const t = setTimeout(() => searchSymbols(query).then(setSymbols).catch(() => setSymbols([])), 150);
    return () => clearTimeout(t);
  }, [mode, query]);

  const items: Item[] = useMemo(() => {
    if (mode === "commands") {
      const toItem = (c: Command, positions?: number[], group?: string): Item => ({
        key: c.id + (group ?? ""),
        label: c.label,
        hint: c.keybinding,
        positions,
        group,
        run: () => {
          markRecent(c.id);
          c.run();
        },
      });
      if (!query) {
        const recent = recentCommands();
        const rest = allCommands().filter((c) => !recent.includes(c));
        return [...recent.map((c, i) => toItem(c, undefined, i === 0 ? "recently used" : undefined)), ...rest.map((c, i) => toItem(c, undefined, i === 0 && recent.length ? "other commands" : undefined))];
      }
      return fuzzyFilter(allCommands(), query, (c) => c.label).map((r) => toItem(r.item, r.result.positions));
    }

    if (mode === "line") {
      const model = activeEditor()?.getModel();
      const [l, c] = query.split(/[:,]/).map((n) => parseInt(n, 10));
      if (!model) return [{ key: "none", label: "Open a file first to go to a line.", run: () => {} }];
      const total = model.getLineCount();
      if (!l) return [{ key: "hint", label: `Current line: ${activeEditor()!.getPosition()?.lineNumber}. Type a line number between 1 and ${total}.`, run: () => {} }];
      return [
        {
          key: "go",
          label: `Go to line ${Math.min(l, total)}${c ? `, column ${c}` : ""}`,
          run: () => {
            const path = useStore.getState().groups[useStore.getState().activeGroup].active!;
            useStore.getState().openFile(path, { line: Math.min(l, total), column: c || 1 });
          },
        },
      ];
    }

    if (mode === "symbols") {
      if (useCsharp.getState().status === "off" || useCsharp.getState().status === "missing")
        return [{ key: "none", label: "Symbol search needs the C# language server (see the C# item in the status bar).", run: () => {} }];
      if (!query) return [{ key: "hint", label: "Type the name of a class, method or property.", run: () => {} }];
      return symbols.slice(0, 100).map((sym, i) => ({
        key: `${sym.path}:${sym.line}:${i}`,
        label: sym.name,
        detail: `${sym.container ? sym.container + " · " : ""}${basename(sym.path)}`,
        icon: { icon: "codicon-symbol-" + symbolIcon(sym.kind) },
        run: () => useStore.getState().openFile(sym.path, { line: sym.line, column: sym.column }),
      }));
    }

    if (mode === "processes") {
      return fuzzyFilter(processes, query, (p) => `${p.name} ${p.pid} ${p.command}`, 80).map(({ item: p }) => ({
        key: String(p.pid),
        label: `${p.name}`,
        detail: `${p.pid}  ${p.command}`,
        icon: { icon: "codicon-server-process" },
        run: () => attachToProcess(p.pid, p.name),
      }));
    }

    if (mode === "projects") {
      const { projects, startup } = useSolution.getState();
      if (!projects.length) return [{ key: "none", label: "No .NET projects found in this folder.", run: () => {} }];
      const sorted = [...projects].sort((a, b) => Number(b.isRunnable) - Number(a.isRunnable) || a.name.localeCompare(b.name));
      return fuzzyFilter(sorted, query, (p) => p.name).map(({ item: p, result }) => ({
        key: p.path,
        label: p.name,
        positions: result.positions,
        detail:
          (p.path === startup ? "current startup project · " : "") +
          (p.isRunnable ? "" : p.isTest ? "test project · " : "library? · ") +
          (root ? relative(root, p.path) : p.path),
        icon: p.isRunnable ? { icon: "codicon-rocket", color: "#3794ff" } : { icon: "codicon-package", color: "#9b7bd4" },
        run: () => setStartup(p.path),
      }));
    }

    if (mode === "themes") {
      const filtered = query ? fuzzyFilter(themes, query, (t) => t.label).map((r) => ({ t: r.item, p: r.result.positions })) : [...themes]
            .sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label))
            .map((t) => ({ t, p: undefined }));
      let lastGroup = "";
      return filtered.map(({ t, p }) => {
        const group = t.source === "user" ? "your themes" : t.type === "light" ? "light themes" : "dark themes";
        const showGroup = !query && group !== lastGroup;
        lastGroup = group;
        return {
          key: t.ref,
          label: t.label,
          positions: p,
          group: showGroup ? group : undefined,
          preview: () => previewTheme(t.label),
          run: async () => {
            committed.current = true;
            const s = useStore.getState();
            const settings = await updateSetting(s.settings, "workbench.colorTheme", t.label);
            s.setSettings(settings);
          },
        };
      });
    }

    // files
    if (!root) return [{ key: "none", label: "Open a folder to search files.", run: () => {} }];
    const m = query.match(/^(.*?)(?::(\d+))?(?::(\d+))?$/)!;
    const [name, line, col] = [m[1], m[2], m[3]];
    const rel = (p: string) => relative(root, p);
    const results = name ? fuzzyFilter(files, name, rel, 60) : files.slice(0, 60).map((item) => ({ item, result: { score: 0, positions: [] as number[] } }));
    return results.map(({ item, result }) => {
      const r = rel(item);
      const nameStart = r.length - basename(r).length;
      return {
        key: item,
        label: basename(item),
        detail: relative(root, dirname(item)),
        icon: fileIcon(basename(item)),
        positions: result.positions.filter((i) => i >= nameStart).map((i) => i - nameStart),
        run: () => useStore.getState().openFile(item, line ? { line: +line, column: col ? +col : 1 } : undefined),
      };
    });
  }, [mode, query, files, themes, root, symbols, processes]);

  // Live preview while moving through themes.
  useEffect(() => {
    items[index]?.preview?.();
  }, [index, items]);

  useEffect(() => {
    listRef.current?.querySelector(".palette-item.selected")?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const dismiss = () => {
    if (mode === "themes" && !committed.current) previewTheme(originalTheme.current);
    close();
  };

  const accept = (item?: Item) => {
    if (!item) return;
    close();
    item.run();
  };

  return (
    <div className="palette-backdrop" onMouseDown={dismiss}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          value={text}
          placeholder={
            mode === "themes"
              ? "Select Color Theme (Up/Down keys to preview)"
              : mode === "processes"
                ? "Attach to process (type a name or process id)"
                : mode === "projects"
                ? "Select the startup project to run"
                : mode === "files"
                  ? "Search files by name (:line to go to a line, > for commands, # for symbols)"
                  : ""
          }
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setIndex((i) => Math.min(i + 1, items.length - 1));
            else if (e.key === "ArrowUp") setIndex((i) => Math.max(i - 1, 0));
            else if (e.key === "PageDown") setIndex((i) => Math.min(i + 10, items.length - 1));
            else if (e.key === "PageUp") setIndex((i) => Math.max(i - 10, 0));
            else if (e.key === "Enter") accept(items[index]);
            else if (e.key === "Escape") dismiss();
            else return;
            e.preventDefault();
            e.stopPropagation();
          }}
        />
        <div className="palette-list" ref={listRef}>
          {items.length === 0 && <div className="palette-empty">No matching results</div>}
          {items.map((item, i) => (
            <div key={item.key}>
              {item.group && <div className="palette-group">{item.group}</div>}
              <div className={`palette-item ${i === index ? "selected" : ""}`} onMouseMove={() => i !== index && setIndex(i)} onClick={() => accept(item)}>
                {item.icon && <span className={`codicon ${item.icon.icon}`} style={{ color: item.icon.color }} />}
                <span className="palette-label">
                  <Highlight text={item.label} positions={item.positions} />
                </span>
                {item.detail && <span className="palette-detail">{item.detail}</span>}
                {item.hint && <span className="palette-hint">{item.hint.split("+").map((k, j) => <kbd key={j}>{k}</kbd>)}</span>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const symbolNames = ["file", "module", "namespace", "package", "class", "method", "property", "field", "constructor", "enum", "interface", "function", "variable", "constant", "string", "number", "boolean", "array", "object", "key", "null", "enum-member", "struct", "event", "operator", "type-parameter"];
const symbolIcon = (kind: number) => symbolNames[kind] ?? "misc";

/** Your themes first, then dark, then light. */
const rank = (t: ThemeInfo) => (t.source === "user" ? 0 : t.type === "dark" ? 1 : 2);

let previewRun = 0;
async function previewTheme(label: string) {
  const run = ++previewRun;
  const theme = await applyTheme(label, useStore.getState().settings);
  if (run === previewRun) useStore.getState().setTheme(theme);
}

function Highlight({ text, positions }: { text: string; positions?: number[] }) {
  if (!positions?.length) return <>{text}</>;
  const set = new Set(positions);
  return (
    <>
      {[...text].map((ch, i) => (set.has(i) ? <b key={i}>{ch}</b> : <span key={i}>{ch}</span>))}
    </>
  );
}
