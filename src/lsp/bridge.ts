// Connects a language server to Monaco: keeps documents in sync and registers
// completion, hover, go to definition, references, rename, formatting, code actions,
// signature help, inlay hints, outline and diagnostics.
import { monaco } from "../lib/highlighting";
import { useProblems, type Problem, type Severity } from "../lib/problems";
import { useStore } from "../store";
import type { LspClient } from "./client";
import {
  applyWorkspaceEdit, fromUri, toCompletionKind, toLocations, toLspRange, toMarkdown, toPos, toRange,
  toSymbolKind, toTextEdit, toUri, type LspTextEdit,
} from "./convert";

const severities: Record<number, Severity> = { 1: "error", 2: "warning", 3: "info", 4: "hint" };

export interface BridgeOptions {
  languageId: string; // Monaco language id, e.g. "csharp"
  lspLanguageId: string; // languageId sent in didOpen
  source: string; // shown in Problems, e.g. "C#"
}

let commandSeq = 0;

export function connectToMonaco(client: LspClient, caps: any, opts: BridgeOptions): monaco.IDisposable {
  const disposables: monaco.IDisposable[] = [];
  const lang = opts.languageId;
  const synced = new Map<string, { model: monaco.editor.ITextModel; version: number; sub: monaco.IDisposable }>();
  const syncKind: number = typeof caps.textDocumentSync === "number" ? caps.textDocumentSync : caps.textDocumentSync?.change ?? 1;
  const pullDiagnostics = !!caps.diagnosticProvider;
  const token = (t: monaco.CancellationToken) => ({ onCancellationRequested: (cb: () => void) => t.onCancellationRequested(cb) });
  const isOurs = (m: monaco.editor.ITextModel) => m.getLanguageId() === lang && m.uri.scheme === "file";

  // --- diagnostics ---

  const setDiagnostics = (uri: string, diags: any[]) => {
    const path = fromUri(uri);
    const problems: Problem[] = diags.map((d) => ({
      path,
      line: d.range.start.line + 1,
      column: d.range.start.character + 1,
      endLine: d.range.end.line + 1,
      endColumn: d.range.end.character + 1,
      severity: severities[d.severity ?? 1] ?? "error",
      message: d.message,
      code: typeof d.code === "object" ? d.code?.value : d.code != null ? String(d.code) : undefined,
      source: d.source ?? opts.source,
      origin: "lsp",
    }));
    // Hidden diagnostics (severity hint with "unnecessary" tags) stay out of the panel.
    useProblems.getState().set("lsp", path, problems.filter((p) => p.severity !== "hint"));
  };
  client.onNotification("textDocument/publishDiagnostics", (p) => setDiagnostics(p.uri, p.diagnostics));

  const pullTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pull = (uri: string, delay = 400) => {
    if (!pullDiagnostics) return;
    clearTimeout(pullTimers.get(uri));
    pullTimers.set(
      uri,
      setTimeout(async () => {
        try {
          const r = await client.request("textDocument/diagnostic", { textDocument: { uri } });
          if (r?.kind === "full") setDiagnostics(uri, r.items ?? []);
        } catch {
          /* server busy or document closed */
        }
      }, delay),
    );
  };
  const pullAll = () => synced.forEach((_, uri) => pull(uri, 50));
  client.onRequest("workspace/diagnostic/refresh", () => (pullAll(), null));

  // --- document sync ---

  const open = (model: monaco.editor.ITextModel) => {
    if (!isOurs(model)) return;
    const uri = toUri(model.uri.fsPath);
    if (synced.has(uri)) return;
    const entry = { model, version: 1, sub: null as unknown as monaco.IDisposable };
    client.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: opts.lspLanguageId, version: 1, text: model.getValue() },
    });
    entry.sub = model.onDidChangeContent((e) => {
      entry.version++;
      const contentChanges =
        syncKind === 2
          ? e.changes.map((c) => ({ range: toLspRange(c.range), rangeLength: c.rangeLength, text: c.text }))
          : [{ text: model.getValue() }];
      client.notify("textDocument/didChange", { textDocument: { uri, version: entry.version }, contentChanges });
      pull(uri);
    });
    synced.set(uri, entry);
    pull(uri, 100);
  };
  const close = (model: monaco.editor.ITextModel) => {
    const uri = toUri(model.uri.fsPath);
    const entry = synced.get(uri);
    if (!entry) return;
    entry.sub.dispose();
    synced.delete(uri);
    client.notify("textDocument/didClose", { textDocument: { uri } });
  };
  monaco.editor.getModels().forEach(open);
  disposables.push(
    monaco.editor.onDidCreateModel(open),
    monaco.editor.onWillDisposeModel(close),
    monaco.editor.onDidChangeModelLanguage(({ model }) => (isOurs(model) ? open(model) : close(model))),
  );

  // --- commands used by code actions ---

  const applyActionId = `frost.lsp.applyCodeAction.${++commandSeq}`;
  disposables.push(
    monaco.editor.registerCommand(applyActionId, async (_accessor, action: any) => {
      try {
        let a = action;
        if (!a.edit && caps.codeActionProvider?.resolveProvider) a = await client.request("codeAction/resolve", action);
        if (a.edit) await applyWorkspaceEdit(a.edit);
        const cmd = a.command && typeof a.command === "object" ? a.command : null;
        if (cmd && caps.executeCommandProvider?.commands?.includes(cmd.command)) {
          await client.request("workspace/executeCommand", { command: cmd.command, arguments: cmd.arguments });
        }
      } catch (e) {
        useStore.getState().toast(`Code action failed: ${e}`, "error");
      }
    }),
  );

  // --- providers ---

  const docParams = (model: monaco.editor.ITextModel, position: monaco.IPosition) => ({
    textDocument: { uri: toUri(model.uri.fsPath) },
    position: toPos(position),
  });

  if (caps.completionProvider) {
    const resolve = !!caps.completionProvider.resolveProvider;
    disposables.push(
      monaco.languages.registerCompletionItemProvider(lang, {
        triggerCharacters: caps.completionProvider.triggerCharacters ?? ["."],
        async provideCompletionItems(model, position, context, t) {
          const result: any = await client.request(
            "textDocument/completion",
            {
              ...docParams(model, position),
              context: {
                triggerKind: context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter ? 2 : context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerForIncompleteCompletions ? 3 : 1,
                triggerCharacter: context.triggerCharacter,
              },
            },
            token(t),
          );
          const items: any[] = Array.isArray(result) ? result : result?.items ?? [];
          const defaults = result?.itemDefaults ?? {};
          const word = model.getWordUntilPosition(position);
          const fallback = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, position.column);
          const suggestions = items.map((item): monaco.languages.CompletionItem => {
            const te = item.textEdit;
            const editRange = defaults.editRange;
            let range: monaco.languages.CompletionItem["range"] = fallback;
            if (te?.range) range = toRange(te.range);
            else if (te?.insert) range = { insert: toRange(te.insert), replace: toRange(te.replace) };
            else if (editRange?.insert) range = { insert: toRange(editRange.insert), replace: toRange(editRange.replace) };
            else if (editRange?.start) range = toRange(editRange);
            const format = item.insertTextFormat ?? defaults.insertTextFormat;
            return {
              label: item.labelDetails ? { label: item.label, detail: item.labelDetails.detail, description: item.labelDetails.description } : item.label,
              kind: toCompletionKind(item.kind),
              detail: item.detail,
              documentation: toMarkdown(item.documentation)[0],
              insertText: te?.newText ?? item.insertText ?? item.label,
              insertTextRules: format === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
              range,
              filterText: item.filterText,
              sortText: item.sortText,
              preselect: item.preselect,
              commitCharacters: item.commitCharacters ?? defaults.commitCharacters,
              additionalTextEdits: item.additionalTextEdits?.map(toTextEdit),
              tags: item.deprecated || item.tags?.includes(1) ? [monaco.languages.CompletionItemTag.Deprecated] : undefined,
              // Keep the server's item for resolve.
              _lsp: { ...item, data: item.data ?? defaults.data },
            } as monaco.languages.CompletionItem;
          });
          return { suggestions, incomplete: !!result?.isIncomplete };
        },
        async resolveCompletionItem(item, t) {
          const lsp = (item as any)._lsp;
          if (!resolve || !lsp) return item;
          try {
            const r = await client.request("completionItem/resolve", lsp, token(t));
            return {
              ...item,
              detail: r.detail ?? item.detail,
              documentation: toMarkdown(r.documentation)[0] ?? item.documentation,
              additionalTextEdits: r.additionalTextEdits?.map(toTextEdit) ?? item.additionalTextEdits,
            };
          } catch {
            return item;
          }
        },
      }),
    );
  }

  if (caps.hoverProvider) {
    disposables.push(
      monaco.languages.registerHoverProvider(lang, {
        async provideHover(model, position, t) {
          const r = await client.request("textDocument/hover", docParams(model, position), token(t));
          if (!r) return null;
          return { contents: toMarkdown(r.contents), range: r.range ? toRange(r.range) : undefined };
        },
      }),
    );
  }

  const locationProvider = (method: string) => ({
    async provide(model: monaco.editor.ITextModel, position: monaco.Position, t: monaco.CancellationToken) {
      return toLocations(await client.request(method, docParams(model, position), token(t)));
    },
  });
  if (caps.definitionProvider) {
    const p = locationProvider("textDocument/definition");
    disposables.push(monaco.languages.registerDefinitionProvider(lang, { provideDefinition: p.provide }));
  }
  if (caps.typeDefinitionProvider) {
    const p = locationProvider("textDocument/typeDefinition");
    disposables.push(monaco.languages.registerTypeDefinitionProvider(lang, { provideTypeDefinition: p.provide }));
  }
  if (caps.implementationProvider) {
    const p = locationProvider("textDocument/implementation");
    disposables.push(monaco.languages.registerImplementationProvider(lang, { provideImplementation: p.provide }));
  }
  if (caps.referencesProvider) {
    disposables.push(
      monaco.languages.registerReferenceProvider(lang, {
        async provideReferences(model, position, context, t) {
          const r = await client.request(
            "textDocument/references",
            { ...docParams(model, position), context: { includeDeclaration: context.includeDeclaration } },
            token(t),
          );
          return toLocations(r);
        },
      }),
    );
  }
  if (caps.documentHighlightProvider) {
    disposables.push(
      monaco.languages.registerDocumentHighlightProvider(lang, {
        async provideDocumentHighlights(model, position, t) {
          const r: any[] = (await client.request("textDocument/documentHighlight", docParams(model, position), token(t))) ?? [];
          return r.map((h) => ({ range: toRange(h.range), kind: (h.kind ?? 1) - 1 }));
        },
      }),
    );
  }
  if (caps.signatureHelpProvider) {
    disposables.push(
      monaco.languages.registerSignatureHelpProvider(lang, {
        signatureHelpTriggerCharacters: caps.signatureHelpProvider.triggerCharacters ?? ["(", ","],
        signatureHelpRetriggerCharacters: caps.signatureHelpProvider.retriggerCharacters ?? [","],
        async provideSignatureHelp(model, position, t) {
          const r: any = await client.request("textDocument/signatureHelp", docParams(model, position), token(t));
          if (!r?.signatures?.length) return null;
          return {
            value: {
              activeSignature: r.activeSignature ?? 0,
              activeParameter: r.activeParameter ?? 0,
              signatures: r.signatures.map((s: any) => ({
                label: s.label,
                documentation: toMarkdown(s.documentation)[0],
                parameters: (s.parameters ?? []).map((p: any) => ({ label: p.label, documentation: toMarkdown(p.documentation)[0] })),
                activeParameter: s.activeParameter,
              })),
            },
            dispose() {},
          };
        },
      }),
    );
  }
  if (caps.renameProvider) {
    const prepare = typeof caps.renameProvider === "object" && caps.renameProvider.prepareProvider;
    disposables.push(
      monaco.languages.registerRenameProvider(lang, {
        async provideRenameEdits(model, position, newName, t) {
          const edit = await client.request("textDocument/rename", { ...docParams(model, position), newName }, token(t));
          // Applied by us so files that aren't open are changed on disk too.
          await applyWorkspaceEdit(edit);
          return { edits: [] };
        },
        resolveRenameLocation: prepare
          ? async (model, position, t) => {
              const r: any = await client.request("textDocument/prepareRename", docParams(model, position), token(t));
              if (!r) return { range: new monaco.Range(1, 1, 1, 1), text: "", rejectReason: "You cannot rename this element." };
              const range = r.range ?? r;
              return { range: toRange(range), text: r.placeholder ?? model.getValueInRange(toRange(range)) };
            }
          : undefined,
      }),
    );
  }
  const formatOptions = (o: monaco.languages.FormattingOptions) => ({ tabSize: o.tabSize, insertSpaces: o.insertSpaces });
  if (caps.documentFormattingProvider) {
    disposables.push(
      monaco.languages.registerDocumentFormattingEditProvider(lang, {
        async provideDocumentFormattingEdits(model, options, t) {
          const r: LspTextEdit[] = (await client.request("textDocument/formatting", { textDocument: { uri: toUri(model.uri.fsPath) }, options: formatOptions(options) }, token(t))) ?? [];
          return r.map(toTextEdit);
        },
      }),
    );
  }
  if (caps.documentRangeFormattingProvider) {
    disposables.push(
      monaco.languages.registerDocumentRangeFormattingEditProvider(lang, {
        async provideDocumentRangeFormattingEdits(model, range, options, t) {
          const r: LspTextEdit[] =
            (await client.request("textDocument/rangeFormatting", { textDocument: { uri: toUri(model.uri.fsPath) }, range: toLspRange(range), options: formatOptions(options) }, token(t))) ?? [];
          return r.map(toTextEdit);
        },
      }),
    );
  }
  if (caps.codeActionProvider) {
    disposables.push(
      monaco.languages.registerCodeActionProvider(lang, {
        async provideCodeActions(model, range, context, t) {
          const diagnostics = context.markers.map((m) => ({
            range: toLspRange(m),
            message: m.message,
            severity: m.severity === monaco.MarkerSeverity.Error ? 1 : m.severity === monaco.MarkerSeverity.Warning ? 2 : 3,
            code: typeof m.code === "string" ? m.code : m.code?.value,
            source: m.source,
          }));
          const r: any[] =
            (await client.request("textDocument/codeAction", { textDocument: { uri: toUri(model.uri.fsPath) }, range: toLspRange(range), context: { diagnostics } }, token(t))) ?? [];
          const actions: monaco.languages.CodeAction[] = r
            .filter((a) => !a.disabled)
            .map((a) => ({
              title: a.title,
              kind: a.kind,
              isPreferred: a.isPreferred,
              diagnostics: a.diagnostics ? context.markers.filter((m) => a.diagnostics.some((d: any) => d.message === m.message)) : undefined,
              command: { id: applyActionId, title: a.title, arguments: [a] },
            }));
          return { actions, dispose() {} };
        },
      }),
    );
  }
  if (caps.inlayHintProvider) {
    disposables.push(
      monaco.languages.registerInlayHintsProvider(lang, {
        async provideInlayHints(model, range, t) {
          const r: any[] = (await client.request("textDocument/inlayHint", { textDocument: { uri: toUri(model.uri.fsPath) }, range: toLspRange(range) }, token(t))) ?? [];
          return {
            hints: r.map((h) => ({
              label: typeof h.label === "string" ? h.label : h.label.map((p: any) => p.value).join(""),
              position: { lineNumber: h.position.line + 1, column: h.position.character + 1 },
              kind: h.kind === 1 ? monaco.languages.InlayHintKind.Type : monaco.languages.InlayHintKind.Parameter,
              paddingLeft: h.paddingLeft,
              paddingRight: h.paddingRight,
            })),
            dispose() {},
          };
        },
      }),
    );
  }
  if (caps.documentSymbolProvider) {
    disposables.push(
      monaco.languages.registerDocumentSymbolProvider(lang, {
        async provideDocumentSymbols(model, t) {
          const r: any[] = (await client.request("textDocument/documentSymbol", { textDocument: { uri: toUri(model.uri.fsPath) } }, token(t))) ?? [];
          const convert = (s: any): monaco.languages.DocumentSymbol => ({
            name: s.name,
            detail: s.detail ?? "",
            kind: toSymbolKind(s.kind),
            tags: [],
            range: toRange(s.range ?? s.location.range),
            selectionRange: toRange(s.selectionRange ?? s.location.range),
            children: s.children?.map(convert),
          });
          return r.map(convert);
        },
      }),
    );
  }

  // Server-driven requests.
  client.onRequest("workspace/applyEdit", async (p) => ({ applied: await applyWorkspaceEdit(p.edit) }));
  client.onRequest("workspace/inlayHint/refresh", () => null);
  client.onRequest("window/showDocument", (p) => {
    const path = fromUri(p.uri);
    useStore.getState().openFile(path, p.selection ? { line: p.selection.start.line + 1, column: p.selection.start.character + 1 } : undefined);
    return { success: true };
  });

  return {
    dispose() {
      disposables.forEach((d) => d.dispose());
      synced.forEach((e) => e.sub.dispose());
      synced.clear();
      pullTimers.forEach((t) => clearTimeout(t));
      useProblems.getState().clear("lsp");
    },
  };
}

/** Workspace-wide symbol search (used by the palette's "#" mode). */
export async function workspaceSymbols(client: LspClient, query: string) {
  const r: any[] = (await client.request("workspace/symbol", { query })) ?? [];
  return r
    .filter((s) => s.location?.uri?.startsWith("file:"))
    .map((s) => ({
      name: s.name as string,
      container: (s.containerName as string) ?? "",
      kind: toSymbolKind(s.kind),
      path: fromUri(s.location.uri),
      line: (s.location.range?.start.line ?? 0) + 1,
      column: (s.location.range?.start.character ?? 0) + 1,
    }));
}
