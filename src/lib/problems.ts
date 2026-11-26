// Problems from every source (language server, build), shown in the Problems panel
// and as squiggles in the editor.
import { create } from "zustand";
import { monaco } from "./highlighting";
import { samePath } from "./api";

export type Severity = "error" | "warning" | "info" | "hint";

export interface Problem {
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: Severity;
  message: string;
  code?: string;
  source: string;
  /** "lsp" problems update live; "build" problems come from the last build. */
  origin: "lsp" | "build";
  project?: string;
}

interface ProblemsState {
  /** key = origin + "|" + path (lowercase). */
  byFile: Record<string, Problem[]>;
  set(origin: Problem["origin"], path: string, problems: Problem[]): void;
  clear(origin: Problem["origin"]): void;
}

const key = (origin: string, path: string) => `${origin}|${path.replace(/\\/g, "/").toLowerCase()}`;

export const useProblems = create<ProblemsState>((set) => ({
  byFile: {},
  set: (origin, path, problems) => {
    set((s) => {
      const byFile = { ...s.byFile };
      if (problems.length) byFile[key(origin, path)] = problems;
      else delete byFile[key(origin, path)];
      return { byFile };
    });
    applyMarkers(path);
  },
  clear: (origin) => {
    const paths: string[] = [];
    set((s) => {
      const byFile: Record<string, Problem[]> = {};
      for (const [k, v] of Object.entries(s.byFile)) {
        if (k.startsWith(origin + "|")) paths.push(v[0]?.path);
        else byFile[k] = v;
      }
      return { byFile };
    });
    paths.forEach((p) => p && applyMarkers(p));
  },
}));

/** All problems for a file, preferring live language-server results over the last build. */
export function problemsFor(path: string): Problem[] {
  const s = useProblems.getState().byFile;
  const lsp = s[key("lsp", path)] ?? [];
  const build = s[key("build", path)] ?? [];
  // A build error that the language server also reports is shown once.
  const seen = new Set(lsp.map((p) => `${p.line}:${p.code}`));
  return [...lsp, ...build.filter((b) => !seen.has(`${b.line}:${b.code}`))];
}

export function allProblems(): Problem[] {
  const files = new Set<string>();
  for (const list of Object.values(useProblems.getState().byFile)) if (list[0]) files.add(list[0].path);
  return [...files].flatMap(problemsFor);
}

const toMarkerSeverity = (s: Severity) =>
  s === "error"
    ? monaco.MarkerSeverity.Error
    : s === "warning"
      ? monaco.MarkerSeverity.Warning
      : s === "info"
        ? monaco.MarkerSeverity.Info
        : monaco.MarkerSeverity.Hint;

function applyMarkers(path: string) {
  const model = monaco.editor.getModels().find((m) => samePath(m.uri.fsPath, path));
  if (!model) return;
  monaco.editor.setModelMarkers(
    model,
    "frost",
    problemsFor(path).map((p) => ({
      startLineNumber: p.line,
      startColumn: p.column,
      endLineNumber: p.endLine,
      endColumn: p.endColumn,
      severity: toMarkerSeverity(p.severity),
      message: p.message,
      code: p.code,
      source: p.source,
    })),
  );
}

// Files opened later get their squiggles too.
monaco.editor.onDidCreateModel((m) => applyMarkers(m.uri.fsPath));
