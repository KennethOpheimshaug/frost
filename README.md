# Frost

A fast, personal IDE for C#, mixing the feel of VS Code, Rider and PyCharm. Built with **Tauri 2** (a Rust backend and the system WebView) and **React + TypeScript**. The editor is **Monaco**. Syntax colors come from real **TextMate grammars and VS Code themes** (through Shiki).

Status: **phase 1 (editor MVP)**. C# language support, building and debugging come in phase 2. Claude Code integration comes in phase 3.

## What works now

- **File explorer:** lazy, virtualized tree that respects `.gitignore`. It updates live when files change on disk. New file/folder, rename (F2), delete, drag-and-drop to move, copy path, open in terminal, and keyboard navigation.
- **Editor:** Monaco with tabs and up to 3 side-by-side groups (`Ctrl+\`). It has unsaved markers, breadcrumbs, sticky scroll, bracket colors and minimap. Files edited outside the IDE (git, Claude Code…) reload automatically if you have no unsaved changes.
- **Terminal:** real terminals (ConPTY on Windows, PowerShell 7 if installed). Multiple tabs, themed. Ctrl+C copies when text is selected.
- **Command palette** (`Ctrl+Shift+P` / `F1`), **Go to File** (`Ctrl+P`, add `:42` to jump to a line), **Go to Line** (`Ctrl+G`).
- **Find in Files** (`Ctrl+Shift+F`): plain text or regex, match case, gitignore-aware. The search runs in Rust.
- **Themes:** 65 built-in VS Code themes, with live preview in `Ctrl+Shift+T`. **Import any VS Code theme JSON** from the command palette, or drop theme `.json` files into the themes folder. The whole UI follows the theme, not only the editor.
- **Settings** (`Ctrl+,`) in `settings.json`, using VS Code's key names, including `workbench.colorCustomizations` and `editor.tokenColorCustomizations`.
- Auto save (`files.autoSave`), compact/comfortable layout, resizable side bar and panel, and a prompt before closing with unsaved changes.

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

## Project layout

```
src/                     React frontend
  App.tsx                layout, commands, keybindings, title/activity/status bars
  store.ts               workbench state (zustand)
  components/            Explorer, EditorGroup, TerminalPanel, SearchView, Palette, ContextMenu
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
```

## Where settings and themes live

- Windows: `%APPDATA%\com.kennethopheimshaug.frost\settings.json` and `...\themes\`
- Run **Preferences: Show Themes Folder Path** in the command palette to see the exact path.

## Next: phase 2

C# with Roslyn LSP, a .NET build host (MSBuild binary logs, live progress, Problems panel), `dotnet watch` hot reload, and a DAP debugger. See the plan doc for details.
