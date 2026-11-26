// Debugging inside the editor: breakpoints in the gutter, the current line,
// Rider-style inline values, and hover evaluation while stopped.
import { monaco } from "../lib/highlighting";
import { samePath } from "../lib/api";
import { showMenu, promptInput } from "../lib/overlay";
import {
  addBreakpoint, breakpointsFor, moveBreakpointLines, removeBreakpoint, toggleBreakpoint, updateBreakpoint, useBreakpoints,
  type Breakpoint,
} from "./breakpoints";
import { evaluate, useDebug } from "./session";

const decorations = new Map<string, string[]>(); // model uri -> decoration ids
const bpDecoration = new Map<string, number>(); // decoration id -> breakpoint id

function bpClass(b: Breakpoint, debugging: boolean) {
  const kind = b.logMessage ? "log" : b.condition || b.hitCondition ? "conditional" : "plain";
  const state = !b.enabled ? "disabled" : debugging && b.verified === false ? "unverified" : "";
  return `bp-glyph bp-${kind} ${state}`;
}

function bpHover(b: Breakpoint) {
  const parts = [b.logMessage ? `Logpoint: ${b.logMessage}` : "Breakpoint"];
  if (b.condition) parts.push(`Condition: ${b.condition}`);
  if (b.hitCondition) parts.push(`Hit count: ${b.hitCondition}`);
  if (b.verified === false) parts.push("Not bound: no code on this line, or the module isn't loaded yet");
  return parts.join("\n\n");
}

// Inline values are drawn with generated CSS ::after rules (one class per label).
const styleEl = document.createElement("style");
document.head.appendChild(styleEl);
const contentClasses = new Map<string, string>();
function cssContentClass(label: string): string {
  let cls = contentClasses.get(label);
  if (!cls) {
    if (contentClasses.size > 2000) {
      contentClasses.clear();
      styleEl.textContent = "";
    }
    cls = `iv-${contentClasses.size + 1}`;
    contentClasses.set(label, cls);
    const escaped = label.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
    styleEl.textContent += `.${cls}::after{content:"  ${escaped}";}\n`;
  }
  return cls;
}

function inlineValues(model: monaco.editor.ITextModel, frameLine: number): monaco.editor.IModelDeltaDecoration[] {
  const d = useDebug.getState();
  const locals = d.scopes[0] ? d.variables[d.scopes[0].variablesReference] ?? [] : [];
  if (!locals.length) return [];
  const byName = new Map(locals.filter((v) => /^[A-Za-z_]\w*$/.test(v.name)).map((v) => [v.name, v]));
  const out: monaco.editor.IModelDeltaDecoration[] = [];
  const first = Math.max(1, frameLine - 40);
  const shown = new Set<string>();
  // Walk up from the current line so each variable shows where it was last used.
  for (let line = frameLine; line >= first; line--) {
    const text = model.getLineContent(line);
    const names: string[] = [];
    for (const m of text.matchAll(/[A-Za-z_]\w*/g)) if (byName.has(m[0]) && !shown.has(m[0]) && !names.includes(m[0])) names.push(m[0]);
    if (!names.length) continue;
    names.forEach((n) => shown.add(n));
    const label = names
      .map((n) => {
        const v = byName.get(n)!.value;
        return `${n} = ${v.length > 40 ? v.slice(0, 40) + "…" : v}`;
      })
      .join(", ");
    const col = model.getLineMaxColumn(line);
    out.push({
      range: new monaco.Range(line, col, line, col),
      options: { afterContentClassName: `debug-inline-value ${cssContentClass(label)}` },
    });
  }
  return out;
}

function render(model: monaco.editor.ITextModel) {
  if (model.uri.scheme !== "file") return;
  const path = model.uri.fsPath;
  const d = useDebug.getState();
  const debugging = d.status !== "inactive";
  const next: monaco.editor.IModelDeltaDecoration[] = [];
  const bps = breakpointsFor(path);
  for (const b of bps) {
    next.push({
      range: new monaco.Range(b.line, 1, b.line, 1),
      options: {
        glyphMarginClassName: bpClass(b, debugging),
        glyphMarginHoverMessage: { value: bpHover(b) },
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        className: b.enabled && !b.logMessage ? "bp-line" : undefined,
        isWholeLine: true,
      },
    });
  }
  let inline: monaco.editor.IModelDeltaDecoration[] = [];
  const frame = d.frames.find((f) => f.id === d.selectedFrame);
  if (d.status === "stopped" && frame?.path && samePath(frame.path, path) && frame.line <= model.getLineCount()) {
    const top = d.frames.find((f) => f.path) === frame;
    next.push({
      range: new monaco.Range(frame.line, 1, frame.line, 1),
      options: {
        isWholeLine: true,
        className: top ? "debug-current-line" : "debug-frame-line",
        glyphMarginClassName: top ? "debug-current-glyph" : "debug-frame-glyph",
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    });
    inline = inlineValues(model, frame.line);
  }
  next.push(...inline);
  const key = model.uri.toString();
  const ids = model.deltaDecorations(decorations.get(key) ?? [], next);
  decorations.set(key, ids);
  // Remember which decoration belongs to which breakpoint (the first bps.length decorations).
  ids.slice(0, bps.length).forEach((id, i) => bpDecoration.set(id, bps[i].id));
}

const renderAll = () => monaco.editor.getModels().forEach(render);
useBreakpoints.subscribe(renderAll);
useDebug.subscribe((s, prev) => {
  if (s.status !== prev.status || s.selectedFrame !== prev.selectedFrame || s.variables !== prev.variables || s.frames !== prev.frames) renderAll();
});

monaco.editor.onDidCreateModel((model) => {
  render(model);
  // Keep breakpoints on the same code when lines are added or removed above them.
  model.onDidChangeContent(() => {
    const moves = new Map<number, number>();
    for (const id of decorations.get(model.uri.toString()) ?? []) {
      const bpId = bpDecoration.get(id);
      const range = model.getDecorationRange(id);
      if (bpId === undefined || !range) continue;
      const bp = useBreakpoints.getState().list.find((b) => b.id === bpId);
      if (bp && bp.line !== range.startLineNumber) moves.set(bpId, range.startLineNumber);
    }
    moveBreakpointLines(moves);
  });
});

/** Gutter clicks and the breakpoint context menu for one editor. */
export function attachDebugToEditor(editor: monaco.editor.IStandaloneCodeEditor): monaco.IDisposable {
  const glyph = monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN;
  const lineNumbers = monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS;
  const subs = [
    editor.onMouseDown((e) => {
      const model = editor.getModel();
      if (!model || !e.target.position) return;
      const line = e.target.position.lineNumber;
      if (e.event.rightButton && (e.target.type === glyph || e.target.type === lineNumbers)) {
        e.event.preventDefault();
        breakpointMenu(model.uri.fsPath, line, e.event.posx, e.event.posy);
      } else if (e.event.leftButton && e.target.type === glyph) {
        toggleBreakpoint(model.uri.fsPath, line);
      }
    }),
  ];
  return {
    dispose: () => subs.forEach((s) => s.dispose()),
  };
}

export function breakpointMenu(path: string, line: number, x: number, y: number) {
  const bp = breakpointsFor(path).find((b) => b.line === line);
  const items = bp
    ? [
        { label: "Remove Breakpoint", action: () => removeBreakpoint(bp.id) },
        { label: bp.enabled ? "Disable Breakpoint" : "Enable Breakpoint", action: () => updateBreakpoint(bp.id, { enabled: !bp.enabled }) },
        {
          label: "Edit Condition…",
          action: async () => {
            const v = await promptInput("Break when this expression is true (C#)", bp.condition ?? "", "e.g. i == 10");
            if (v !== null) updateBreakpoint(bp.id, { condition: v || undefined });
          },
        },
        {
          label: "Edit Hit Count…",
          action: async () => {
            const v = await promptInput("Break when the hit count is reached", bp.hitCondition ?? "", "e.g. 5");
            if (v !== null) updateBreakpoint(bp.id, { hitCondition: v || undefined });
          },
        },
        {
          label: "Edit Log Message…",
          action: async () => {
            const v = await promptInput("Log a message instead of stopping. Use {expression} for values.", bp.logMessage ?? "", "e.g. i = {i}");
            if (v !== null) updateBreakpoint(bp.id, { logMessage: v || undefined });
          },
        },
      ]
    : [
        { label: "Add Breakpoint", hint: "F9", action: () => toggleBreakpoint(path, line) },
        {
          label: "Add Conditional Breakpoint…",
          action: async () => {
            const v = await promptInput("Break when this expression is true (C#)", "", "e.g. i == 10");
            if (v) addBreakpoint(path, line, { condition: v });
          },
        },
        {
          label: "Add Logpoint…",
          action: async () => {
            const v = await promptInput("Log a message instead of stopping. Use {expression} for values.", "", "e.g. i = {i}");
            if (v) addBreakpoint(path, line, { logMessage: v });
          },
        },
      ];
  showMenu(x, y, items);
}

// Hover over a variable or member access (a.b.c) while stopped to see its value.
monaco.languages.registerHoverProvider("csharp", {
  async provideHover(model, position) {
    if (useDebug.getState().status !== "stopped") return null;
    const line = model.getLineContent(position.lineNumber);
    const re = /[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      const start = m.index + 1;
      const end = start + m[0].length;
      if (position.column < start || position.column > end) continue;
      // Only up to the hovered identifier: hovering "b" in a.b.c evaluates a.b.
      const upTo = m[0].slice(0, m[0].indexOf(".", position.column - start) === -1 ? undefined : m[0].indexOf(".", position.column - start));
      try {
        const r = await evaluate(upTo, "hover");
        return {
          range: new monaco.Range(position.lineNumber, start, position.lineNumber, start + upTo.length),
          contents: [{ value: `\`${upTo}\` = **${r.result.replace(/[*_`]/g, "\\$&")}**${r.type ? `  \n*${r.type}*` : ""}` }],
        };
      } catch {
        return null;
      }
    }
    return null;
  },
});
