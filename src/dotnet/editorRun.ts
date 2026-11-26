// Run/Debug right from a C# file: "▶ Run | Debug" above Main (or top-level statements)
// and Run/Debug in the editor's right-click menu.
import { monaco } from "../lib/highlighting";
import { basename } from "../lib/api";
import { runCommand } from "../lib/commands";

const RUN = "frost.editor.run";
const DEBUG = "frost.editor.debug";
monaco.editor.registerCommand(RUN, () => runCommand("run.run"));
monaco.editor.registerCommand(DEBUG, () => runCommand("debug.start"));

const MAIN = /\bstatic\s+(?:async\s+)?(?:void|int|Task(?:<int>)?)\s+Main\s*\(/;
const SKIP = /^\s*(using\s|global\s+using\s|\/\/|\/\*|\*|#|$)/;

/** Line of the program's entry point in this file, or 0 if it has none. */
function entryLine(model: monaco.editor.ITextModel): number {
  const lines = model.getLinesContent();
  const main = lines.findIndex((l) => MAIN.test(l));
  if (main >= 0) return main + 1;
  // Top-level statements live in Program.cs without a class around them.
  if (basename(model.uri.fsPath).toLowerCase() === "program.cs" && !lines.some((l) => /\b(class|record|struct)\s+\w+/.test(l) && !/^\s*\/\//.test(l))) {
    const first = lines.findIndex((l) => !SKIP.test(l));
    return first >= 0 ? first + 1 : 1;
  }
  return 0;
}

monaco.languages.registerCodeLensProvider("csharp", {
  provideCodeLenses(model) {
    const line = entryLine(model);
    if (!line) return { lenses: [], dispose() {} };
    const range = new monaco.Range(line, 1, line, 1);
    return {
      lenses: [
        { range, command: { id: RUN, title: "▶ Run" } },
        { range, command: { id: DEBUG, title: "Debug" } },
      ],
      dispose() {},
    };
  },
});

/** Adds Run/Debug to an editor's context menu. */
export function addRunActions(editor: monaco.editor.IStandaloneCodeEditor): monaco.IDisposable[] {
  return [
    editor.addAction({
      id: "frost.run",
      label: "Run Project",
      precondition: "editorLangId == csharp",
      contextMenuGroupId: "0_run",
      contextMenuOrder: 1,
      run: () => runCommand("run.run"),
    }),
    editor.addAction({
      id: "frost.debug",
      label: "Debug Project",
      precondition: "editorLangId == csharp",
      contextMenuGroupId: "0_run",
      contextMenuOrder: 2,
      run: () => runCommand("debug.start"),
    }),
    editor.addAction({
      id: "frost.toggleBreakpoint",
      label: "Toggle Breakpoint",
      contextMenuGroupId: "0_run",
      contextMenuOrder: 3,
      run: () => runCommand("debug.toggleBreakpoint"),
    }),
  ];
}
