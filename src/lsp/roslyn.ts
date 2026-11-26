// Starts and manages the Roslyn C# language server for the open folder.
import { create } from "zustand";
import { api, dirname, samePath } from "../lib/api";
import { useOutput } from "../lib/output";
import { monaco } from "../lib/highlighting";
import { LspClient } from "./client";
import { connectToMonaco, workspaceSymbols } from "./bridge";
import { toUri } from "./convert";

export type CsharpStatus = "off" | "missing" | "starting" | "loading" | "ready" | "error";

interface CsharpState {
  status: CsharpStatus;
  detail: string;
  sdk: string | null;
  set(s: Partial<Omit<CsharpState, "set">>): void;
}

export const useCsharp = create<CsharpState>((set) => ({
  status: "off",
  detail: "",
  sdk: null,
  set: (s) => set(s),
}));

/** Answers for the server's workspace/configuration requests. Unknown keys get null (= default). */
const serverSettings: Record<string, unknown> = {
  "csharp|inlay_hints.dotnet_enable_inlay_hints_for_parameters": true,
  "csharp|inlay_hints.dotnet_enable_inlay_hints_for_literal_parameters": true,
  "csharp|inlay_hints.dotnet_suppress_inlay_hints_for_parameters_that_match_argument_name": true,
  "csharp|inlay_hints.csharp_enable_inlay_hints_for_implicit_variable_types": false,
  "csharp|code_lens.dotnet_enable_references_code_lens": false,
  "csharp|background_analysis.dotnet_analyzer_diagnostics_scope": "openFiles",
  "csharp|background_analysis.dotnet_compiler_diagnostics_scope": "fullSolution",
  "csharp|completion.dotnet_show_completion_items_from_unimported_namespaces": true,
  "csharp|symbol_search.dotnet_search_reference_assemblies": true,
};

let client: LspClient | null = null;
let bridge: monaco.IDisposable | null = null;
let generation = 0;

const log = (line: string) => useOutput.getState().append("C#", line);

export async function stopCsharp() {
  generation++;
  bridge?.dispose();
  bridge = null;
  const c = client;
  client = null;
  if (c) {
    await c.stop();
    c.dispose();
  }
  useCsharp.getState().set({ status: "off", detail: "" });
}

/**
 * Starts Roslyn for `root` if it contains C# projects.
 * `solution` picks which solution to load when there are several.
 */
export async function startCsharp(root: string, opts: { command: string; solution?: string | null; onRestoreNeeded?: (projects: string[]) => void }) {
  await stopCsharp();
  const gen = generation;
  const state = useCsharp.getState();

  const ws = await api.findDotnetWorkspace(root);
  if (!ws.solutions.length && !ws.projects.length) return;

  const info = await api.dotnetInfo(opts.command);
  state.set({ sdk: info.sdk });
  if (!info.sdk) {
    state.set({ status: "missing", detail: "The .NET SDK was not found. Install it from https://dot.net and restart Frost." });
    return;
  }
  if (!info.roslyn) {
    state.set({
      status: "missing",
      detail: "C# language server not installed. Run: dotnet tool install --global roslyn-language-server --prerelease",
    });
    return;
  }

  state.set({ status: "starting", detail: "Starting C# language server…" });
  const id = `roslyn-${gen}`;
  const c = new LspClient(id);
  client = c;
  c.onLog = (l) => log(l);
  c.onExit = (code) => {
    if (gen !== generation) return;
    bridge?.dispose();
    bridge = null;
    state.set({ status: "error", detail: `C# language server stopped (exit code ${code}). Use "C#: Restart Language Server" to try again.` });
  };

  // Load the chosen solution. Roslyn picks a single root solution, or all projects, by itself.
  const chosen = opts.solution ?? ws.solutions[0] ?? null;
  const rootSolutions = ws.solutions.filter((s) => samePath(dirname(s), root));
  const autoLoad = !chosen || (rootSolutions.length === 1 && samePath(rootSolutions[0], chosen));

  try {
    const logDir = `${await api.configDir()}${root.includes("\\") ? "\\" : "/"}logs`;
    const exe = await c.start(opts.command, ["--stdio", "--logLevel", "Information", "--extensionLogDirectory", logDir], root);
    log(`Started ${exe}`);
  } catch (e) {
    state.set({ status: "error", detail: String(e) });
    return;
  }

  // Server requests that need an answer.
  c.onRequest("workspace/configuration", (p) => (p.items ?? []).map((i: any) => serverSettings[i.section] ?? null));
  c.onRequest("client/registerCapability", () => null);
  c.onRequest("client/unregisterCapability", () => null);
  c.onRequest("window/workDoneProgress/create", () => null);
  c.onRequest("window/showMessageRequest", (p) => (log(`[server] ${p.message}`), null));
  c.onRequest("workspace/_roslyn_projectNeedsRestore", (p) => {
    const projects: string[] = p?.projectFilePaths ?? [];
    log(`Projects need restore: ${projects.join(", ") || "(all)"}`);
    opts.onRestoreNeeded?.(projects);
    return null;
  });
  c.onRequest("workspace/codeLens/refresh", () => null);
  c.onRequest("workspace/semanticTokens/refresh", () => null);
  c.onNotification("window/logMessage", (p) => log(p.message));
  c.onNotification("window/showMessage", (p) => log(`[server] ${p.message}`));
  c.onNotification("workspace/projectInitializationComplete", () => {
    if (gen === generation) state.set({ status: "ready", detail: "C# ready" });
  });
  c.onNotification("$/progress", (p) => {
    if (gen !== generation || useCsharp.getState().status === "ready") return;
    const v = p.value ?? {};
    if (v.kind === "begin" || v.kind === "report") state.set({ status: "loading", detail: [v.title, v.message].filter(Boolean).join(": ") || "Loading projects…" });
  });

  const init: any = await c
    .request("initialize", {
      processId: null,
      clientInfo: { name: "Frost", version: "0.2" },
      rootUri: toUri(root),
      workspaceFolders: [{ uri: toUri(root), name: root }],
      initializationOptions: { autoLoadProjects: autoLoad ? 500 : 0 },
      capabilities: clientCapabilities,
    })
    .catch((e) => {
      state.set({ status: "error", detail: `Initialize failed: ${e}` });
      return null;
    });
  if (!init || gen !== generation) return;
  c.notify("initialized", {});
  if (!autoLoad && chosen) c.notify("solution/open", { solution: toUri(chosen) });
  state.set({ status: "loading", detail: "Loading projects…" });
  bridge = connectToMonaco(c, init.capabilities ?? {}, { languageId: "csharp", lspLanguageId: "csharp", source: "C#" });
}

/** Tells the server about files changed on disk (new files, edits from git, ...). */
export function notifyFileChanges(created: string[], changed: string[], removed: string[]) {
  if (!client?.running) return;
  const relevant = (p: string) => /\.(cs|csx|razor|cshtml|csproj|props|targets|sln|slnx|editorconfig|json)$/i.test(p);
  const changes = [
    ...created.filter(relevant).map((p) => ({ uri: toUri(p), type: 1 })),
    ...changed.filter(relevant).map((p) => ({ uri: toUri(p), type: 2 })),
    ...removed.filter(relevant).map((p) => ({ uri: toUri(p), type: 3 })),
  ];
  if (changes.length) client.notify("workspace/didChangeWatchedFiles", { changes });
}

export const notifySaved = (path: string) => client?.notify("textDocument/didSave", { textDocument: { uri: toUri(path) } });

export async function searchSymbols(query: string) {
  if (!client?.running || useCsharp.getState().status === "off") return [];
  return workspaceSymbols(client, query);
}

const clientCapabilities = {
  general: { positionEncodings: ["utf-16"] },
  textDocument: {
    synchronization: { didSave: true, dynamicRegistration: false },
    completion: {
      completionItem: {
        snippetSupport: true,
        commitCharactersSupport: true,
        documentationFormat: ["markdown", "plaintext"],
        deprecatedSupport: true,
        preselectSupport: true,
        insertReplaceSupport: true,
        labelDetailsSupport: true,
        tagSupport: { valueSet: [1] },
        resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] },
      },
      completionList: { itemDefaults: ["commitCharacters", "editRange", "insertTextFormat", "data"] },
      contextSupport: true,
    },
    hover: { contentFormat: ["markdown", "plaintext"] },
    signatureHelp: {
      signatureInformation: { documentationFormat: ["markdown", "plaintext"], parameterInformation: { labelOffsetSupport: true }, activeParameterSupport: true },
      contextSupport: true,
    },
    definition: { linkSupport: true },
    typeDefinition: { linkSupport: true },
    implementation: { linkSupport: true },
    references: {},
    documentHighlight: {},
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    codeAction: {
      codeActionLiteralSupport: {
        codeActionKind: { valueSet: ["", "quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite", "source", "source.organizeImports"] },
      },
      resolveSupport: { properties: ["edit"] },
      dataSupport: true,
      isPreferredSupport: true,
    },
    formatting: {},
    rangeFormatting: {},
    rename: { prepareSupport: true },
    publishDiagnostics: { relatedInformation: false, tagSupport: { valueSet: [1, 2] } },
    diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
    inlayHint: {},
  },
  workspace: {
    applyEdit: true,
    workspaceEdit: { documentChanges: true },
    configuration: true,
    workspaceFolders: true,
    didChangeWatchedFiles: { dynamicRegistration: true },
    symbol: {},
    diagnostics: { refreshSupport: true },
    inlayHint: { refreshSupport: true },
  },
  window: { workDoneProgress: true, showDocument: { support: true } },
};
