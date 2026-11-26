// Conversions between LSP (0-based, URIs) and Monaco (1-based, models), plus applying edits.
import { monaco } from "../lib/highlighting";
import { api } from "../lib/api";
import { getModel, openModel } from "../lib/models";

export interface LspPosition {
  line: number;
  character: number;
}
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
export interface LspTextEdit {
  range: LspRange;
  newText: string;
}
export interface LspLocation {
  uri: string;
  range: LspRange;
}

export const toUri = (path: string) => monaco.Uri.file(path).toString();
export const fromUri = (uri: string) => monaco.Uri.parse(uri).fsPath;

export const toPos = (p: monaco.IPosition): LspPosition => ({ line: p.lineNumber - 1, character: p.column - 1 });
export const toLspRange = (r: monaco.IRange): LspRange => ({
  start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
  end: { line: r.endLineNumber - 1, character: r.endColumn - 1 },
});
export const toRange = (r: LspRange): monaco.IRange => ({
  startLineNumber: r.start.line + 1,
  startColumn: r.start.character + 1,
  endLineNumber: r.end.line + 1,
  endColumn: r.end.character + 1,
});
export const toTextEdit = (e: LspTextEdit): monaco.languages.TextEdit => ({ range: toRange(e.range), text: e.newText });

export function toMarkdown(contents: any): monaco.IMarkdownString[] {
  if (!contents) return [];
  if (Array.isArray(contents)) return contents.flatMap(toMarkdown);
  if (typeof contents === "string") return [{ value: contents }];
  if ("kind" in contents) return [{ value: contents.kind === "markdown" ? contents.value : escape(contents.value) }];
  if ("language" in contents) return [{ value: "```" + contents.language + "\n" + contents.value + "\n```" }];
  return [];
}
const escape = (s: string) => s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");

/** Locations or LocationLinks to Monaco locations, loading target files so peek views work. */
export async function toLocations(result: any): Promise<monaco.languages.Location[]> {
  if (!result) return [];
  const list: any[] = Array.isArray(result) ? result : [result];
  const out: monaco.languages.Location[] = [];
  for (const l of list) {
    const uri: string = l.targetUri ?? l.uri;
    const range: LspRange = l.targetSelectionRange ?? l.range;
    if (!uri?.startsWith("file:")) continue; // decompiled sources etc. aren't supported yet
    try {
      await openModel(fromUri(uri));
    } catch {
      continue;
    }
    out.push({ uri: monaco.Uri.parse(uri), range: toRange(range) });
  }
  return out;
}

/** Applies text edits to one file: in the open model if there is one, else straight on disk. */
async function applyToFile(path: string, edits: LspTextEdit[]) {
  const model = getModel(path);
  if (model) {
    model.pushEditOperations([], edits.map((e) => ({ range: toRange(e.range), text: e.newText, forceMoveMarkers: true })), () => null);
    model.pushStackElement();
    return;
  }
  const text = await api.readFile(path);
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const offset = (p: LspPosition) => Math.min(text.length, (lineStarts[p.line] ?? text.length) + p.character);
  // Apply from the end so earlier offsets stay valid.
  const sorted = [...edits].sort((a, b) => offset(b.range.start) - offset(a.range.start));
  let out = text;
  for (const e of sorted) out = out.slice(0, offset(e.range.start)) + e.newText + out.slice(offset(e.range.end));
  await api.writeFile(path, out);
}

/** Applies an LSP WorkspaceEdit (text changes; file create/rename/delete is not supported yet). */
export async function applyWorkspaceEdit(edit: any): Promise<boolean> {
  if (!edit) return false;
  const perFile = new Map<string, LspTextEdit[]>();
  for (const [uri, edits] of Object.entries<LspTextEdit[]>(edit.changes ?? {})) perFile.set(fromUri(uri), edits);
  for (const dc of edit.documentChanges ?? []) {
    if (dc.textDocument && dc.edits) perFile.set(fromUri(dc.textDocument.uri), [...(perFile.get(fromUri(dc.textDocument.uri)) ?? []), ...dc.edits]);
  }
  for (const [path, edits] of perFile) await applyToFile(path, edits);
  return perFile.size > 0;
}

const symbolKinds = monaco.languages.SymbolKind;
export const toSymbolKind = (k: number): monaco.languages.SymbolKind => (k >= 1 && k <= 26 ? k - 1 : symbolKinds.Variable);

const ck = monaco.languages.CompletionItemKind;
const completionKinds: Record<number, monaco.languages.CompletionItemKind> = {
  1: ck.Text, 2: ck.Method, 3: ck.Function, 4: ck.Constructor, 5: ck.Field, 6: ck.Variable, 7: ck.Class,
  8: ck.Interface, 9: ck.Module, 10: ck.Property, 11: ck.Unit, 12: ck.Value, 13: ck.Enum, 14: ck.Keyword,
  15: ck.Snippet, 16: ck.Color, 17: ck.File, 18: ck.Reference, 19: ck.Folder, 20: ck.EnumMember,
  21: ck.Constant, 22: ck.Struct, 23: ck.Event, 24: ck.Operator, 25: ck.TypeParameter,
};
export const toCompletionKind = (k?: number) => (k ? completionKinds[k] ?? ck.Text : ck.Text);
