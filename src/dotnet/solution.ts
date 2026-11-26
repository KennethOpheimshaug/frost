// The solution model behind the Solution view, run configurations and builds.
import { create } from "zustand";
import { api, dirname, samePath, type ProjectInfo } from "../lib/api";

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

  useSolution.setState({ solutions: ws.solutions, solution, projects, startup: pickStartup(root, projects), loading: false });

  // The quick read above misses settings from Directory.Build.props, imports and SDKs.
  // Ask MSBuild for the real values in the background and refine.
  const evaluated = await evaluateProjects(projects);
  if (useSolution.getState().root !== root) return;
  useSolution.setState({ projects: evaluated, startup: pickStartup(root, evaluated) });
}

function pickStartup(root: string, projects: ProjectInfo[]): string | null {
  const saved = localStorage.getItem(pref(root, "startup"));
  // A project the user picked stays picked, even if it doesn't look runnable to us.
  return projects.find((p) => saved && samePath(p.path, saved))?.path ?? projects.find((p) => p.isRunnable)?.path ?? null;
}

const PROPS = ["OutputType", "TargetFramework", "TargetFrameworks", "IsTestProject", "UsingMicrosoftNETSdkWeb", "UsingMicrosoftNETSdkBlazorWebAssembly", "AssemblyName"];

async function evaluateOne(p: ProjectInfo): Promise<ProjectInfo> {
  try {
    const r = await api.runCapture("dotnet", ["msbuild", p.path, ...PROPS.map((x) => `-getProperty:${x}`)], dirname(p.path));
    if (r.code !== 0) return p;
    const props: Record<string, string> = JSON.parse(r.stdout.slice(r.stdout.indexOf("{"))).Properties ?? {};
    const ot = (props.OutputType ?? "").toLowerCase();
    const isTest = props.IsTestProject?.toLowerCase() === "true" || p.isTest;
    const tfms = (props.TargetFrameworks || props.TargetFramework || "").split(";").map((t) => t.trim()).filter(Boolean);
    const web = props.UsingMicrosoftNETSdkWeb?.toLowerCase() === "true" || props.UsingMicrosoftNETSdkBlazorWebAssembly?.toLowerCase() === "true";
    return {
      ...p,
      outputType: props.OutputType || p.outputType,
      targetFrameworks: tfms.length ? tfms : p.targetFrameworks,
      isTest,
      isRunnable: !isTest && (ot === "exe" || ot === "winexe" || web),
    };
  } catch {
    return p;
  }
}

/** Evaluates projects with MSBuild, four at a time. */
async function evaluateProjects(projects: ProjectInfo[]): Promise<ProjectInfo[]> {
  const out = [...projects];
  let next = 0;
  const worker = async () => {
    while (next < out.length) {
      const i = next++;
      out[i] = await evaluateOne(out[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, out.length) }, worker));
  return out;
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
