// Run / Watch (hot reload) / Stop for the startup project, in a terminal tab.
import { create } from "zustand";
import { api, basename, dirname } from "../lib/api";
import { useStore } from "../store";
import { useSolution } from "./solution";

interface RunState {
  project: string | null;
  mode: "run" | "watch" | null;
}

export const useRun = create<RunState>(() => ({ project: null, mode: null }));

const TERMINAL_ID = "run";
let listening = false;

function ensureListening() {
  if (listening) return;
  listening = true;
  api.onPtyExit((id) => {
    if (id === TERMINAL_ID) useRun.setState({ project: null, mode: null });
  });
}

export function runProject(mode: "run" | "watch", projectPath?: string, opts: { noBuild?: boolean } = {}) {
  ensureListening();
  const project = projectPath ?? useSolution.getState().startup;
  if (!project) {
    useStore.getState().toast("No runnable project found. Projects need <OutputType>Exe</OutputType> or a Web SDK.", "error");
    return;
  }
  // `dotnet run` builds first; `dotnet watch` hot-reloads supported changes and restarts otherwise.
  const args = mode === "watch" ? ["watch", "--project", project] : ["run", "--project", project, ...(opts.noBuild ? ["--no-build"] : [])];
  window.dispatchEvent(
    new CustomEvent("ide:new-terminal", {
      detail: {
        id: TERMINAL_ID,
        cwd: dirname(project),
        command: "dotnet",
        args,
        title: `${mode === "watch" ? "Watch" : "Run"}: ${basename(project).replace(/\.\w+proj$/, "")}`,
        env: { DOTNET_WATCH_RESTART_ON_RUDE_EDIT: "true" },
      },
    }),
  );
  useRun.setState({ project, mode });
}

export function stopRun() {
  if (!useRun.getState().project) return;
  window.dispatchEvent(new CustomEvent("ide:kill-terminal", { detail: { id: TERMINAL_ID } }));
  useRun.setState({ project: null, mode: null });
}
