// Breakpoints: stored per folder, shown in the editor gutter, sent to the debugger.
import { create } from "zustand";
import { samePath } from "../lib/api";

export interface Breakpoint {
  id: number;
  path: string;
  line: number;
  enabled: boolean;
  condition?: string;
  hitCondition?: string;
  /** Logpoint: prints this message instead of stopping. {expr} is evaluated. */
  logMessage?: string;
  /** Set by the debugger: false means it couldn't bind (e.g. no code on that line). */
  verified?: boolean;
  /** Line the debugger actually bound to, if different. */
  boundLine?: number;
}

interface BreakpointState {
  root: string | null;
  list: Breakpoint[];
  exceptionFilters: string[];
}

export const useBreakpoints = create<BreakpointState>(() => ({ root: null, list: [], exceptionFilters: ["user-unhandled"] }));

let nextId = 1;
const key = (root: string) => `frost.breakpoints.${root.toLowerCase()}`;
const listeners = new Set<(path: string) => void>();

/** Called with a file path whenever that file's breakpoints change. */
export function onBreakpointsChanged(cb: (path: string) => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function save(list: Breakpoint[], changedPath?: string) {
  const s = useBreakpoints.getState();
  useBreakpoints.setState({ list });
  if (s.root) {
    const stored = list.map(({ verified: _v, boundLine: _b, ...rest }) => rest);
    localStorage.setItem(key(s.root), JSON.stringify({ list: stored, exceptionFilters: s.exceptionFilters }));
  }
  if (changedPath) listeners.forEach((l) => l(changedPath));
}

export function loadBreakpoints(root: string | null) {
  if (!root) return useBreakpoints.setState({ root: null, list: [] });
  try {
    const data = JSON.parse(localStorage.getItem(key(root)) ?? "{}");
    const list: Breakpoint[] = (data.list ?? []).map((b: Breakpoint) => ({ ...b, id: nextId++ }));
    useBreakpoints.setState({ root, list, exceptionFilters: data.exceptionFilters ?? ["user-unhandled"] });
  } catch {
    useBreakpoints.setState({ root, list: [] });
  }
}

export const breakpointsFor = (path: string) => useBreakpoints.getState().list.filter((b) => samePath(b.path, path));

export function toggleBreakpoint(path: string, line: number) {
  const list = useBreakpoints.getState().list;
  const existing = list.find((b) => samePath(b.path, path) && b.line === line);
  save(existing ? list.filter((b) => b !== existing) : [...list, { id: nextId++, path, line, enabled: true }], path);
}

export function updateBreakpoint(id: number, patch: Partial<Breakpoint>) {
  const list = useBreakpoints.getState().list;
  const bp = list.find((b) => b.id === id);
  if (!bp) return;
  save(list.map((b) => (b.id === id ? { ...b, ...patch } : b)), bp.path);
}

export function addBreakpoint(path: string, line: number, extra: Partial<Breakpoint>) {
  const list = useBreakpoints.getState().list.filter((b) => !(samePath(b.path, path) && b.line === line));
  save([...list, { id: nextId++, path, line, enabled: true, ...extra }], path);
}

export function removeBreakpoint(id: number) {
  const list = useBreakpoints.getState().list;
  const bp = list.find((b) => b.id === id);
  if (bp) save(list.filter((b) => b.id !== id), bp.path);
}

export function removeAllBreakpoints() {
  const paths = [...new Set(useBreakpoints.getState().list.map((b) => b.path))];
  save([]);
  paths.forEach((p) => listeners.forEach((l) => l(p)));
}

/** Lines moved because of edits: keeps breakpoints on the same code. No change event (no resend needed mid-edit). */
export function moveBreakpointLines(moves: Map<number, number>) {
  if (!moves.size) return;
  save(useBreakpoints.getState().list.map((b) => (moves.has(b.id) ? { ...b, line: moves.get(b.id)! } : b)));
}

/** Debugger results: verified/bound line per breakpoint id (no persistence, no resend). */
export function setVerification(results: Map<number, { verified: boolean; line?: number }>) {
  useBreakpoints.setState((s) => ({
    list: s.list.map((b) => (results.has(b.id) ? { ...b, verified: results.get(b.id)!.verified, boundLine: results.get(b.id)!.line } : b)),
  }));
}

export function clearVerification() {
  useBreakpoints.setState((s) => ({ list: s.list.map(({ verified: _v, boundLine: _b, ...b }) => b) }));
}

export function setExceptionFilters(filters: string[]) {
  useBreakpoints.setState({ exceptionFilters: filters });
  save(useBreakpoints.getState().list);
  listeners.forEach((l) => l("*exceptions*"));
}
