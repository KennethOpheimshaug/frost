# Frost

A fast, personal IDE for C#, mixing the feel of VS Code, Rider and PyCharm. Built with **Tauri 2** (a Rust backend and the system WebView) and **React + TypeScript**. The editor is **Monaco**. Syntax colors come from real **TextMate grammars and VS Code themes** (through Shiki).

Status: **phase 2 in progress**. C# language support, the Solution view, building, running and debugging work. Claude Code integration comes in phase 3.

## What works now

- **File explorer:** lazy, virtualized tree that respects `.gitignore`. It updates live when files change on disk. New file/folder, rename (F2), delete, drag-and-drop to move, copy path, open in terminal, and keyboard navigation.
- **Editor:** Monaco with tabs and up to 3 side-by-side groups (`Ctrl+\`). It has unsaved markers, breadcrumbs, sticky scroll, bracket colors and minimap. Files edited outside the IDE (git, Claude Code…) reload automatically if you have no unsaved changes.
- **Terminal:** real terminals (ConPTY on Windows, PowerShell 7 if installed). Multiple tabs, themed. Ctrl+C copies when text is selected.
- **Command palette** (`Ctrl+Shift+P` / `F1`), **Go to File** (`Ctrl+P`, add `:42` to jump to a line), **Go to Line** (`Ctrl+G`).
- **Find in Files** (`Ctrl+Shift+F`): plain text or regex, match case, gitignore-aware. The search runs in Rust.
- **Themes:** 65 built-in VS Code themes, with live preview in `Ctrl+Shift+T`. **Import any VS Code theme JSON** from the command palette, or drop theme `.json` files into the themes folder. The whole UI follows the theme, not only the editor.
- **Settings** (`Ctrl+,`) in `settings.json`, using VS Code's key names, including `workbench.colorCustomizations` and `editor.tokenColorCustomizations`.
- Auto save (`files.autoSave`), compact/comfortable layout, resizable side bar and panel, and a prompt before closing with unsaved changes.

### Source control (Git)

- **Source Control view** (`Ctrl+Shift+G`, below the terminal button): staged and unstaged changes with M/A/D/U markers. Click a file for a side-by-side **diff**, whose right side you can edit. Stage, unstage and discard per file or all at once.
- **Commit** (`Ctrl+Enter` in the message box), **Commit & Push** (`Ctrl+Shift+Enter` or the cloud button), amend. With nothing staged, Commit commits all changes. `Ctrl+K` jumps to the message box, as in Rider.
- **Push / Pull / Sync / Fetch.** "Publish" sets the upstream for new branches. Push is also on `Ctrl+Shift+K`.
- **Branches:** the current branch and ahead/behind counts are in the status bar. The Branches section lists local and remote branches; double-click to check one out. A remote branch becomes a local tracking branch. Click the branch in the status bar to switch or create branches.
- Changed files are colored in the explorer and tabs. Every git command and its output is in **Output → Git**.
- Uses your installed Git and its normal settings and credentials (Git Credential Manager on Windows).

### C# (phase 2)

- **C# language support** through Microsoft's Roslyn language server: completion, hover, go to definition / implementation, find references, rename across files, quick fixes and refactorings (`Ctrl+.`), formatting, signature help, inlay hints, outline (`Ctrl+Shift+O`), live errors, and **Go to Symbol in Workspace** (`Ctrl+T`, or `#` in the palette).
- **Solution view** (Rider-style, `Ctrl+Alt+L`): solution → projects (startup project marked) → dependencies (frameworks, NuGet packages, project references) → files. Right-click a project to build, run, run with hot reload or set it as the startup project. Supports `.sln` and `.slnx`. It picks between several solutions and falls back to loose `.csproj` files.
- **Build** (`Ctrl+Shift+B`), rebuild, clean, restore, cancel. Errors and warnings land in the **Problems** panel (`Ctrl+Shift+M`), merged with live errors from Roslyn. The full log is in **Output** (`Ctrl+Shift+U`). Packages are restored automatically when Roslyn asks for it.
- **Run** the startup project (`Ctrl+F5` or `Shift+F10`): it builds first, shows errors in Problems, then runs in a terminal tab. **Run with Hot Reload** (`dotnet watch`, `Ctrl+Alt+F5`). **Stop** (`Shift+F5` or `Ctrl+F2`). Pick the startup project from the toolbar.

### Debugging (phase 2)

- **Debug** the startup project with `F5` (or `Shift+F9`). Frost builds in Debug, asks MSBuild for the program to start, and launches it under **netcoredbg**, the open-source .NET debugger from Samsung. If netcoredbg isn't installed, Frost offers to download it from GitHub.
- **Breakpoints:** click the gutter or press `F9` (`Ctrl+F8`). Right-click for **conditional breakpoints**, **hit counts** and **logpoints**. Breakpoints are saved per folder, stay on the right code when you edit above them, and show hollow when they couldn't bind.
- **While paused:** the current line is highlighted, and **inline values** appear next to the code, Rider-style. Hover a variable or `a.b.c` to see its value. The **Run and Debug** view (`Ctrl+Shift+D`) shows **Variables** (double-click to change a value), **Watch**, **Call Stack** (click a frame to jump there) and **Breakpoints**, plus "All exceptions" / "User-unhandled exceptions".
- **Stepping:** Continue `F5`, Step Over `F10` (`F8`), Step Into `F11` (`F7`), Step Out `Shift+F11` (`Shift+F8`), Pause `F6`, Restart `Ctrl+Shift+F5`, Stop `Shift+F5`. A floating debug toolbar shows them all.
- **Debug Console** (`Ctrl+Shift+Y`): program output, plus evaluating C# expressions in the current frame.
- **Attach to Process** (`Ctrl+Alt+P`): pick a running process by name or id.

#### One-time setup for C#

Install the [.NET SDK](https://dot.net) (8 or newer, 10 recommended), then the language server:

```powershell
dotnet tool install --global roslyn-language-server --prerelease
```

Restart Frost afterwards. The status bar shows `✓ C#` when it's ready. If the server is installed somewhere else, set `"dotnet.languageServer.command"` in settings.

For debugging, Frost downloads netcoredbg on first use (or run **Debug: Download netcoredbg** from the command palette). To use your own copy, set `"dotnet.debugger.path"`.

## Run it on Windows

1. Install the prerequisites (once):
   - [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/), with the "Desktop development with C++" workload
   - WebView2 (already part of Windows 10/11)
   - [Rust](https://rustup.rs/)
   - [Node.js](https://nodejs.org/) 20 or newer
2. Clone and start:
   ```powershell
   git clone https://github.com/KennethOpheimshaug/frost.git
   cd frost
   npm install
   npm run tauri dev
   ```
   The first start compiles the Rust side and takes a few minutes. After that it's fast. Frontend changes hot-reload.
3. Build an installer: `npm run tauri build`. The installer ends up in `src-tauri/target/release/bundle/`.

## Keyboard shortcuts

| Action | Keys |
|---|---|
| Command palette | `Ctrl+Shift+P` / `F1` |
| Go to file | `Ctrl+P` |
| Go to line | `Ctrl+G` |
| Find in files | `Ctrl+Shift+F` |
| Explorer | `Ctrl+Shift+E` |
| Toggle side bar | `Ctrl+B` |
| Toggle terminal / new terminal | ``Ctrl+` `` / ``Ctrl+Shift+` `` |
| Save / save all | `Ctrl+S` / `Ctrl+Alt+S` |
| Close editor | `Ctrl+W` |
| Next / previous editor | `Ctrl+PageDown` / `Ctrl+PageUp` |
| Split editor right | `Ctrl+\` |
| Focus next editor group | `Ctrl+Alt+Right` |
| Color theme | `Ctrl+Shift+T` |
| Settings | `Ctrl+,` |
| Editor font size | `Ctrl+=` / `Ctrl+-` |
| Word wrap | `Alt+Z` |
| Open folder | `Ctrl+O` |
| Go to symbol in workspace | `Ctrl+T` |
| Solution view | `Ctrl+Alt+L` |
| Build solution / cancel | `Ctrl+Shift+B` / `Ctrl+Pause` |
| Run / run with hot reload / stop | `Ctrl+F5` (`Shift+F10`) / `Ctrl+Alt+F5` / `Shift+F5` (`Ctrl+F2`) |
| Problems / Output | `Ctrl+Shift+M` / `Ctrl+Shift+U` |
| Quick fix | `Ctrl+.` |
| Rename symbol | `F2` |
| Go to definition / references | `F12` / `Shift+F12` |
| Start debugging / continue | `F5` (`Shift+F9`) |
| Step over / into / out | `F10` (`F8`) / `F11` (`F7`) / `Shift+F11` (`Shift+F8`) |
| Toggle breakpoint | `F9` (`Ctrl+F8`) |
| Restart / stop debugging | `Ctrl+Shift+F5` / `Shift+F5` |
| Run and Debug view / Debug Console | `Ctrl+Shift+D` / `Ctrl+Shift+Y` |
| Attach to process | `Ctrl+Alt+P` |
| Source Control / commit message | `Ctrl+Shift+G` / `Ctrl+K` |
| Commit / commit & push (in message box) | `Ctrl+Enter` / `Ctrl+Shift+Enter` |
| Push | `Ctrl+Shift+K` |

## Project layout

```
src/                     React frontend
  App.tsx                layout, commands, keybindings, title/activity/status bars
  store.ts               workbench state (zustand)
  components/            Explorer, SolutionView, EditorGroup, BottomPanel (Problems/Output/Terminal),
                         TerminalPanel, SearchView, Palette, ContextMenu
  lsp/                   LSP client, Monaco bridge (all editor features), Roslyn launcher
  dotnet/                solution model, build (dotnet build -> Problems), run/watch/stop
  dap/                   Debug Adapter Protocol client, debug session, breakpoints, editor integration
  git/                   git CLI wrapper (status, stage, commit, push/pull, branches) and diff tabs
  lib/
    api.ts               typed calls to the Rust commands
    highlighting.ts      Monaco + Shiki: TextMate grammars, VS Code themes, customizations
    monaco-core.ts       Monaco editor features without Monaco's built-in languages
    models.ts            one text model per file, dirty tracking, reload from disk
    settings.ts          settings.json (JSONC) load/save
    uiColors.ts          theme colors -> CSS variables + terminal colors
src-tauri/src/           Rust backend
  fs.rs                  file operations
  watch.rs               file watcher (batched events)
  search.rs              quick-open file list and text search (ripgrep's `ignore` crate)
  pty.rs                 terminals (portable-pty)
  proc.rs                language servers (LSP over stdio) and tools with streamed output
  dotnet.rs              .NET SDK detection, .sln/.slnx/.csproj reading
  debug.rs               netcoredbg install/lookup, MSBuild queries, process list for attach
```

## Where settings and themes live

- Windows: `%APPDATA%\com.kennethopheimshaug.frost\settings.json` and `...\themes\`
- Run **Preferences: Show Themes Folder Path** in the command palette to see the exact path.

## Next in phase 2

- Exception popup at the throwing line, and hot reload while debugging.
- .NET build host: MSBuild binary logs, live per-project progress, an exact project model.
- Test explorer and decompiled "go to definition" into libraries.
