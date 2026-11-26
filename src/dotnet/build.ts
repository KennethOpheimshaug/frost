// Runs dotnet build/rebuild/clean/restore and turns its output into Problems.
import { create } from "zustand";
import { api, basename, dirname, samePath } from "../lib/api";
import { useOutput } from "../lib/output";
import { useProblems, type Problem } from "../lib/problems";
import { useStore } from "../store";

export type BuildKind = "build" | "rebuild" | "clean" | "restore";

interface BuildState {
  running: BuildKind | null;
  target: string | null;
  result: "succeeded" | "failed" | "cancelled" | null;
  errors: number;
  warnings: number;
  seconds: number;
}

export const useBuild = create<BuildState>(() => ({
  running: null,
  target: null,
  result: null,
  errors: 0,
  warnings: 0,
  seconds: 0,
}));

const ID = "build";
// C:\src\App\Program.cs(12,5,12,9): error CS1002: ; expected [C:\src\App\App.csproj]
const WITH_POSITION = /^\s*(.+?)\((\d+)(?:,(\d+))?(?:,(\d+),(\d+))?\)\s*:\s+(error|warning)\s+([A-Za-z]*\d*)\s*:\s*(.*?)(?:\s+\[([^\]]+)\])?\s*$/;
// C:\src\App\App.csproj : error NU1101: Unable to find package Foo. [C:\src\App\App.csproj]
const WITHOUT_POSITION = /^\s*(.+?)\s*:\s+(error|warning)\s+([A-Za-z]+\d+)\s*:\s*(.*?)(?:\s+\[([^\]]+)\])?\s*$/;

let pending: Map<string, Problem[]> = new Map();
let seen = new Set<string>();
let started = 0;
let finish: ((ok: boolean) => void) | null = null;
let listening = false;

function parse(line: string, cwd: string) {
  let m = WITH_POSITION.exec(line);
  let problem: Problem | null = null;
  if (m) {
    const [, file, l, c, el, ec, sev, code, message, project] = m;
    problem = {
      path: isAbsolute(file) ? file : `${cwd}/${file}`,
      line: +l,
      column: c ? +c : 1,
      endLine: el ? +el : +l,
      endColumn: ec ? +ec : c ? +c + 1 : 1000,
      severity: sev as "error" | "warning",
      code,
      message,
      source: "build",
      origin: "build",
      project: project ? basename(project) : undefined,
    };
  } else if ((m = WITHOUT_POSITION.exec(line)) && !line.includes("warning(s)") && !line.includes("error(s)")) {
    const [, file, sev, code, message, project] = m;
    problem = {
      path: isAbsolute(file) ? file : project ?? `${cwd}/${file}`,
      line: 1,
      column: 1,
      endLine: 1,
      endColumn: 1000,
      severity: sev as "error" | "warning",
      code,
      message,
      source: "build",
      origin: "build",
      project: project ? basename(project) : undefined,
    };
  }
  if (!problem) return;
  // MSBuild repeats each diagnostic in its summary; count it once.
  const k = `${problem.path}|${problem.line}|${problem.column}|${problem.code}|${problem.message}`.toLowerCase();
  if (seen.has(k)) return;
  seen.add(k);
  const list = pending.get(problem.path) ?? [];
  list.push(problem);
  pending.set(problem.path, list);
  useBuild.setState((s) => (problem!.severity === "error" ? { errors: s.errors + 1 } : { warnings: s.warnings + 1 }));
}

const isAbsolute = (p: string) => /^([a-zA-Z]:[\\/]|\/)/.test(p);

function ensureListening() {
  if (listening) return;
  listening = true;
  api.onProcLine((id, _stream, line) => {
    if (id !== ID) return;
    useOutput.getState().append("Build", line);
    const target = useBuild.getState().target;
    parse(line, target ? dirname(target) : "");
  });
  api.onProcExit((id, code) => {
    if (id !== ID) return;
    const s = useBuild.getState();
    const cancelled = s.result === "cancelled";
    const ok = code === 0 && !cancelled;
    // Replace the previous build's problems with this build's.
    const problems = useProblems.getState();
    problems.clear("build");
    for (const [path, list] of pending) problems.set("build", path, list);
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    useOutput.getState().append("Build", "", `${s.running} ${cancelled ? "cancelled" : ok ? "succeeded" : "failed"} in ${seconds}s — ${s.errors} error(s), ${s.warnings} warning(s)`);
    useBuild.setState({ running: null, result: cancelled ? "cancelled" : ok ? "succeeded" : "failed", seconds });
    const store = useStore.getState();
    if (!ok && !cancelled) {
      store.toast(`Build failed with ${s.errors} error(s).`, "error");
      if (s.errors) store.showPanel("problems");
    }
    finish?.(ok);
    finish = null;
  });
}

/** Builds `target` (a .sln/.slnx/.csproj or folder). Resolves true on success. */
export function runBuild(kind: BuildKind, target: string, extraArgs: string[] = []): Promise<boolean> {
  ensureListening();
  if (useBuild.getState().running) {
    useStore.getState().toast("A build is already running.");
    return Promise.resolve(false);
  }
  pending = new Map();
  seen = new Set();
  started = Date.now();
  const out = useOutput.getState();
  out.clear("Build");
  const args = [
    kind,
    target,
    "-nologo",
    // Full paths in diagnostics, no summary duplicates, no fancy terminal logger.
    "-p:GenerateFullPaths=true",
    "-clp:NoSummary;ForceNoAlign",
    "-tl:off",
    ...extraArgs,
  ];
  if (kind === "restore") args.splice(args.indexOf("-clp:NoSummary;ForceNoAlign"), 1);
  out.append("Build", `> dotnet ${args.join(" ")}`, "");
  useBuild.setState({ running: kind, target, result: null, errors: 0, warnings: 0 });
  return new Promise((resolve) => {
    finish = resolve;
    const cwd = /\.(sln|slnx|csproj|fsproj|vbproj)$/i.test(target) ? dirname(target) : target;
    api.procStart(ID, "dotnet", args, cwd).catch((e) => {
      out.append("Build", String(e));
      useBuild.setState({ running: null, result: "failed" });
      useStore.getState().toast(String(e), "error");
      finish = null;
      resolve(false);
    });
  });
}

export function cancelBuild() {
  if (!useBuild.getState().running) return;
  useBuild.setState({ result: "cancelled" });
  api.procKill(ID);
}

/** Problems from the build for a given project only (for the Solution view badges). */
export const buildErrorsFor = (projectPath: string) =>
  Object.values(useProblems.getState().byFile)
    .flat()
    .filter((p) => p.origin === "build" && p.severity === "error" && p.project && samePath(p.project, basename(projectPath))).length;
