// The solution model behind the Solution view, run configurations and builds.
import { create } from "zustand";
import { api, samePath, type ProjectInfo } from "../lib/api";

interface SolutionState {
  root: string | null;
  solutions: string[];
  solution: string | null;
  projects: ProjectInfo[];
  /** Project path started by Run (Rider's "startup project"). */
  startup: string | null;
  loading: boolean;
}

export const useSolution = create<SolutionState>(() => ({
  root: null,
  solutions: [],
  solution: null,
  projects: [],
  startup: null,
  loading: false,
}));

const pref = (root: string, key: string) => `frost.${key}.${root.toLowerCase()}`;

/** Finds the solution (or loose projects) in `root` and reads every project. */
export async function loadSolution(root: string | null, preferred?: string | null) {
  if (!root) {
    useSolution.setState({ root: null, solutions: [], solution: null, projects: [], startup: null, loading: false });
    return;
  }
  useSolution.setState({ root, loading: true });
  const ws = await api.findDotnetWorkspace(root);
  const saved = preferred ?? localStorage.getItem(pref(root, "solution"));
  const solution = ws.solutions.find((s) => saved && samePath(s, saved)) ?? ws.solutions[0] ?? null;
  let paths = ws.projects;
  if (solution) {
    try {
      paths = await api.readSolution(solution);
    } catch {
      /* fall back to every project in the folder */
    }
  }
  const projects = (await Promise.all(paths.map((p) => api.readProject(p).catch(() => null)))).filter(Boolean) as ProjectInfo[];
  projects.sort((a, b) => a.name.localeCompare(b.name));
  if (useSolution.getState().root !== root) return; // folder changed meanwhile

  const savedStartup = localStorage.getItem(pref(root, "startup"));
  const startup =
    projects.find((p) => savedStartup && samePath(p.path, savedStartup) && p.isRunnable)?.path ?? projects.find((p) => p.isRunnable)?.path ?? null;
  useSolution.setState({ solutions: ws.solutions, solution, projects, startup, loading: false });
}

export function setStartup(path: string) {
  const root = useSolution.getState().root;
  if (root) localStorage.setItem(pref(root, "startup"), path);
  useSolution.setState({ startup: path });
}

export function chooseSolution(path: string) {
  const root = useSolution.getState().root;
  if (!root) return;
  localStorage.setItem(pref(root, "solution"), path);
  return loadSolution(root, path);
}

/** What a solution-wide build targets: the solution, else the single project, else the folder. */
export function buildTarget(): string | null {
  const s = useSolution.getState();
  return s.solution ?? (s.projects.length === 1 ? s.projects[0].path : s.root);
}
