// A debug session: launch or attach through netcoredbg, then stepping, call stack,
// variables, watches and the Debug Console.
import { create } from "zustand";
import { api, basename, dirname, samePath } from "../lib/api";
import { dirtyPaths, saveModel } from "../lib/models";
import { useStore } from "../store";
import { runBuild } from "../dotnet/build";
import { useSolution } from "../dotnet/solution";
import { DapClient } from "./client";
import { breakpointsFor, clearVerification, onBreakpointsChanged, setVerification, useBreakpoints } from "./breakpoints";

export interface Frame {
  id: number;
  name: string;
  path: string | null;
  line: number;
  column: number;
}
export interface Variable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
  evaluateName?: string;
}
export interface Scope {
  name: string;
  variablesReference: number;
  expensive: boolean;
}
export interface ConsoleLine {
  kind: "stdout" | "stderr" | "console" | "input" | "result" | "error";
  text: string;
}
export interface Watch {
  expression: string;
  value?: string;
  type?: string;
  variablesReference?: number;
  error?: boolean;
}

type Status = "inactive" | "starting" | "running" | "stopped";

interface DebugState {
  status: Status;
  label: string;
  threads: { id: number; name: string }[];
  stoppedThread: number | null;
  stopReason: string;
  exceptionText: string | null;
  frames: Frame[];
  selectedFrame: number | null;
  scopes: Scope[];
  variables: Record<number, Variable[]>;
  console: ConsoleLine[];
  watches: Watch[];
  exceptionFilterOptions: { filter: string; label: string; default?: boolean }[];
}

export const useDebug = create<DebugState>(() => ({
  status: "inactive",
  label: "",
  threads: [],
  stoppedThread: null,
  stopReason: "",
  exceptionText: null,
  frames: [],
  selectedFrame: null,
  scopes: [],
  variables: {},
  console: [],
  watches: JSON.parse(localStorage.getItem("frost.watches") ?? "[]").map((expression: string) => ({ expression })),
  exceptionFilterOptions: [
    { filter: "all", label: "All Exceptions" },
    { filter: "user-unhandled", label: "User-Unhandled Exceptions", default: true },
  ],
}));

let client: DapClient | null = null;
let sessionNo = 0;
let lastStart: (() => Promise<void>) | null = null;
const toast = (t: string, k: "info" | "error" = "info") => useStore.getState().toast(t, k);
const out = (kind: ConsoleLine["kind"], text: string) =>
  useDebug.setState((s) => ({ console: [...s.console, ...text.replace(/\r?\n$/, "").split(/\r?\n/).map((t) => ({ kind, text: t }))].slice(-5000) }));

// ---------- starting ----------

async function debuggerPath(): Promise<string | null> {
  const configured = useStore.getState().settings["dotnet.debugger.path"] || undefined;
  return api.findDebugger(configured);
}

/** Installs netcoredbg from GitHub (after asking), returns its path. */
export async function installDebugger(): Promise<string | null> {
  toast("Downloading netcoredbg from GitHub…");
  try {
    const path = await api.installNetcoredbg();
    toast("netcoredbg installed.");
    return path;
  } catch (e) {
    toast(`Couldn't install netcoredbg: ${e}. Install it manually and set "dotnet.debugger.path".`, "error");
    return null;
  }
}

async function targetPath(project: string, tfms: string[]): Promise<string | null> {
  const args = ["msbuild", project, "-getProperty:TargetPath", "-p:Configuration=Debug"];
  if (tfms.length > 1) args.push(`-p:TargetFramework=${tfms[0]}`);
  const r = await api.runCapture("dotnet", args, dirname(project));
  const path = r.stdout.trim().split(/\r?\n/).pop()?.trim();
  return r.code === 0 && path ? path : null;
}

/** F5: builds the startup project and debugs it. */
export async function startDebugging(projectPath?: string) {
  const sol = useSolution.getState();
  const path = projectPath ?? sol.startup;
  if (!path) return useStore.getState().openPalette("projects");
  // Also works for a project the solution model doesn't know (e.g. found next to the open file).
  const project = sol.projects.find((p) => samePath(p.path, path)) ?? (await api.readProject(path).catch(() => null));
  if (!project) return toast(`Couldn't read ${path}.`, "error");
  lastStart = () => startDebugging(project.path);
  if (useDebug.getState().status !== "inactive") await stopDebugging();

  let adapter = await debuggerPath();
  if (!adapter) {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    const ok = await ask("Frost uses netcoredbg (open source, from Samsung) to debug .NET. Download it now from GitHub?", {
      title: "Install debugger",
      okLabel: "Download",
    });
    if (!ok || !(adapter = await installDebugger())) return;
  }

  useDebug.setState({ status: "starting", label: project.name, console: [] });
  await Promise.all(dirtyPaths().map(saveModel));
  if (!(await runBuild("build", project.path, ["-p:Configuration=Debug"]))) {
    useDebug.setState({ status: "inactive" });
    return;
  }
  const program = await targetPath(project.path, project.targetFrameworks);
  if (!program) {
    useDebug.setState({ status: "inactive" });
    return toast("Couldn't find the built program (dotnet msbuild -getProperty:TargetPath failed).", "error");
  }
  await begin(adapter, "launch", {
    name: project.name,
    type: "coreclr",
    request: "launch",
    program,
    args: [],
    cwd: project.dir,
    env: { ASPNETCORE_ENVIRONMENT: "Development", DOTNET_ENVIRONMENT: "Development" },
    console: "internalConsole",
    stopAtEntry: false,
    justMyCode: true,
  });
}

/** Attaches to a running .NET process. */
export async function attachToProcess(pid: number, name: string) {
  lastStart = () => attachToProcess(pid, name);
  if (useDebug.getState().status !== "inactive") await stopDebugging();
  let adapter = await debuggerPath();
  if (!adapter && !(adapter = await installDebugger())) return;
  useDebug.setState({ status: "starting", label: `${name} (${pid})`, console: [] });
  await begin(adapter, "attach", { name, type: "coreclr", request: "attach", processId: pid, justMyCode: true });
}

async function begin(adapter: string, request: "launch" | "attach", args: object) {
  const no = ++sessionNo;
  const c = new DapClient(`dap-${no}`);
  client = c;
  c.onLog = (l) => out("console", l);
  c.onExit = () => no === sessionNo && finish();
  wireEvents(c, no);
  try {
    await c.start(adapter, ["--interpreter=vscode"], undefined);
    const caps: any = await c.request("initialize", {
      clientID: "frost",
      clientName: "Frost",
      adapterID: "coreclr",
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: "path",
      supportsVariableType: true,
      supportsVariablePaging: false,
      supportsRunInTerminalRequest: false,
      locale: "en",
    });
    if (caps?.exceptionBreakpointFilters?.length) useDebug.setState({ exceptionFilterOptions: caps.exceptionBreakpointFilters });
    // The adapter answers launch only after configurationDone, which we send on "initialized".
    const launched = c.request(request, args);
    await launched;
    if (no === sessionNo && useDebug.getState().status === "starting") useDebug.setState({ status: "running" });
  } catch (e) {
    if (no !== sessionNo) return;
    out("error", String(e));
    toast(`Debugging failed: ${e}`, "error");
    useStore.getState().showPanel("debug");
    await stopDebugging();
  }
}

function wireEvents(c: DapClient, no: number) {
  const live = () => no === sessionNo;
  c.on("initialized", async () => {
    if (!live()) return;
    try {
      await sendAllBreakpoints();
      await c.request("configurationDone");
      useDebug.setState({ status: "running" });
      useStore.getState().showPanel("debug");
    } catch (e) {
      out("error", `Configuration failed: ${e}`);
    }
  });
  c.on("output", (b) => {
    if (!live() || b.category === "telemetry") return;
    out(b.category === "stderr" ? "stderr" : b.category === "stdout" ? "stdout" : "console", b.output ?? "");
  });
  c.on("stopped", (b) => live() && onStopped(b));
  c.on("continued", () => live() && onContinued());
  c.on("breakpoint", (b) => {
    if (!live() || !b.breakpoint) return;
    const id = idByAdapterId.get(b.breakpoint.id);
    if (id !== undefined) setVerification(new Map([[id, { verified: !!b.breakpoint.verified, line: b.breakpoint.line }]]));
  });
  c.on("thread", () => live() && refreshThreads());
  c.on("exited", (b) => live() && out("console", `Program exited with code ${b.exitCode}.`));
  c.on("terminated", () => live() && finish());
}

// ---------- breakpoints ----------

const idByAdapterId = new Map<number, number>();

async function sendBreakpoints(path: string) {
  if (!client?.running) return;
  const bps = breakpointsFor(path).filter((b) => b.enabled);
  try {
    const r: any = await client.request("setBreakpoints", {
      source: { path, name: basename(path) },
      breakpoints: bps.map((b) => ({ line: b.line, condition: b.condition || undefined, hitCondition: b.hitCondition || undefined, logMessage: b.logMessage || undefined })),
      sourceModified: false,
    });
    const results = new Map<number, { verified: boolean; line?: number }>();
    (r.breakpoints ?? []).forEach((rb: any, i: number) => {
      const bp = bps[i];
      if (!bp) return;
      results.set(bp.id, { verified: !!rb.verified, line: rb.line });
      if (rb.id !== undefined) idByAdapterId.set(rb.id, bp.id);
    });
    setVerification(results);
  } catch (e) {
    out("error", `Couldn't set breakpoints in ${basename(path)}: ${e}`);
  }
}

async function sendExceptionFilters() {
  if (!client?.running) return;
  await client.request("setExceptionBreakpoints", { filters: useBreakpoints.getState().exceptionFilters }).catch(() => {});
}

async function sendAllBreakpoints() {
  const paths = [...new Set(useBreakpoints.getState().list.map((b) => b.path.toLowerCase()))]
    .map((lp) => useBreakpoints.getState().list.find((b) => b.path.toLowerCase() === lp)!.path);
  await Promise.all(paths.map(sendBreakpoints));
  await sendExceptionFilters();
}

onBreakpointsChanged((path) => {
  if (useDebug.getState().status === "inactive") return;
  if (path === "*exceptions*") sendExceptionFilters();
  else sendBreakpoints(path);
});

// ---------- stopped state ----------

async function refreshThreads() {
  if (!client?.running) return;
  try {
    const r: any = await client.request("threads");
    useDebug.setState({ threads: r.threads ?? [] });
  } catch {
    /* running */
  }
}

async function onStopped(b: any) {
  const threadId: number = b.threadId ?? useDebug.getState().threads[0]?.id;
  useDebug.setState({
    status: "stopped",
    stoppedThread: threadId,
    stopReason: b.reason ?? "pause",
    exceptionText: b.reason === "exception" ? b.text ?? b.description ?? "Exception thrown" : null,
    variables: {},
  });
  await refreshThreads();
  try {
    const r: any = await client!.request("stackTrace", { threadId, startFrame: 0, levels: 100 });
    const frames: Frame[] = (r.stackFrames ?? []).map((f: any) => ({
      id: f.id,
      name: f.name,
      path: f.source?.path ?? null,
      line: f.line,
      column: f.column,
    }));
    useDebug.setState({ frames });
    const first = frames.find((f) => f.path) ?? frames[0];
    if (first) await selectFrame(first.id);
  } catch (e) {
    out("error", `Couldn't read the call stack: ${e}`);
  }
  if (b.reason === "exception") useStore.getState().showPanel("debug");
}

function onContinued() {
  useDebug.setState({ status: "running", stoppedThread: null, frames: [], selectedFrame: null, scopes: [], variables: {}, exceptionText: null });
}

export async function selectFrame(frameId: number) {
  const frame = useDebug.getState().frames.find((f) => f.id === frameId);
  useDebug.setState({ selectedFrame: frameId, scopes: [], variables: {} });
  if (frame?.path) useStore.getState().openFile(frame.path, { line: frame.line, column: frame.column || 1 });
  if (!client?.running) return;
  try {
    const r: any = await client.request("scopes", { frameId });
    const scopes: Scope[] = (r.scopes ?? []).map((s: any) => ({ name: s.name, variablesReference: s.variablesReference, expensive: !!s.expensive }));
    useDebug.setState({ scopes });
    for (const s of scopes) if (!s.expensive) await loadVariables(s.variablesReference);
  } catch {
    /* frame gone */
  }
  refreshWatches();
}

export async function loadVariables(ref: number): Promise<Variable[]> {
  const cached = useDebug.getState().variables[ref];
  if (cached || !client?.running || !ref) return cached ?? [];
  try {
    const r: any = await client.request("variables", { variablesReference: ref });
    const vars: Variable[] = r.variables ?? [];
    useDebug.setState((s) => ({ variables: { ...s.variables, [ref]: vars } }));
    return vars;
  } catch {
    return [];
  }
}

export async function evaluate(expression: string, context: "watch" | "repl" | "hover"): Promise<{ result: string; type?: string; variablesReference: number }> {
  if (!client?.running) throw new Error("Not debugging");
  const frameId = useDebug.getState().selectedFrame ?? undefined;
  const r: any = await client.request("evaluate", { expression, frameId, context });
  return { result: r.result, type: r.type, variablesReference: r.variablesReference ?? 0 };
}

export async function setVariable(container: number, name: string, value: string) {
  if (!client?.running) return;
  try {
    await client.request("setVariable", { variablesReference: container, name, value });
    useDebug.setState((s) => {
      const variables = { ...s.variables };
      delete variables[container];
      return { variables };
    });
    await loadVariables(container);
  } catch (e) {
    toast(`Couldn't set ${name}: ${e}`, "error");
  }
}

// ---------- watches and console ----------

const saveWatches = () => localStorage.setItem("frost.watches", JSON.stringify(useDebug.getState().watches.map((w) => w.expression)));

export async function refreshWatches() {
  const { watches, status } = useDebug.getState();
  if (status !== "stopped") return useDebug.setState({ watches: watches.map((w) => ({ expression: w.expression })) });
  const next = await Promise.all(
    watches.map(async (w) => {
      try {
        const r = await evaluate(w.expression, "watch");
        return { expression: w.expression, value: r.result, type: r.type, variablesReference: r.variablesReference };
      } catch (e) {
        return { expression: w.expression, value: String(e).replace(/^Error: /, ""), error: true };
      }
    }),
  );
  useDebug.setState({ watches: next });
}

export function addWatch(expression: string) {
  if (!expression.trim()) return;
  useDebug.setState((s) => ({ watches: [...s.watches, { expression: expression.trim() }] }));
  saveWatches();
  refreshWatches();
}

export function removeWatch(index: number) {
  useDebug.setState((s) => ({ watches: s.watches.filter((_, i) => i !== index) }));
  saveWatches();
}

export async function replEvaluate(expression: string) {
  out("input", `> ${expression}`);
  try {
    const r = await evaluate(expression, "repl");
    out("result", r.result);
  } catch (e) {
    out("error", String(e).replace(/^Error: /, ""));
  }
}

export const clearConsole = () => useDebug.setState({ console: [] });

// ---------- controls ----------

const threadArg = () => ({ threadId: useDebug.getState().stoppedThread ?? useDebug.getState().threads[0]?.id ?? 0 });
const step = (command: string) => async () => {
  if (!client?.running || useDebug.getState().status !== "stopped") return;
  onContinued();
  await client.request(command, threadArg()).catch((e) => out("error", `${command}: ${e}`));
};
export const continueRun = step("continue");
export const stepOver = step("next");
export const stepInto = step("stepIn");
export const stepOut = step("stepOut");

export async function pause() {
  if (client?.running && useDebug.getState().status === "running") await client.request("pause", threadArg()).catch(() => {});
}

export async function stopDebugging() {
  const c = client;
  if (!c) return finish();
  try {
    await Promise.race([c.request("disconnect", { terminateDebuggee: true }), new Promise((r) => setTimeout(r, 1500))]);
  } catch {
    /* already gone */
  }
  finish();
}

export async function restartDebugging() {
  await stopDebugging();
  await lastStart?.();
}

function finish() {
  sessionNo++;
  client?.kill();
  client = null;
  idByAdapterId.clear();
  clearVerification();
  const wasActive = useDebug.getState().status !== "inactive";
  useDebug.setState({ status: "inactive", threads: [], stoppedThread: null, frames: [], selectedFrame: null, scopes: [], variables: {}, exceptionText: null });
  if (wasActive) out("console", "Debugging stopped.");
  refreshWatches();
}

export const isDebugging = () => useDebug.getState().status !== "inactive";
