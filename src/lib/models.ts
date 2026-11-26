// One Monaco text model per open file, shared by all editor groups.
import { monaco, ensureLanguage } from "./highlighting";
import { api, samePath } from "./api";
import { languageForPath } from "./languages";

const saved = new Map<string, number>(); // path -> alternative version id at last save/load
const listeners = new Set<() => void>();

export const uriFor = (path: string) => monaco.Uri.file(path);
export const getModel = (path: string) => monaco.editor.getModel(uriFor(path));

/** Notifies subscribers (tabs, title) when any file's dirty state may have changed. */
export function onDirtyChange(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
const emit = () => listeners.forEach((l) => l());

export async function openModel(path: string): Promise<monaco.editor.ITextModel> {
  const existing = getModel(path);
  if (existing) return existing;
  const [text] = await Promise.all([api.readFile(path), ensureLanguage(languageForPath(path))]);
  const again = getModel(path); // another caller may have created it meanwhile
  if (again) return again;
  const model = monaco.editor.createModel(text, languageForPath(path), uriFor(path));
  model.setEOL(text.includes("\r\n") ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
  saved.set(path, model.getAlternativeVersionId());
  model.onDidChangeContent(emit);
  return model;
}

export function isDirty(path: string): boolean {
  const m = getModel(path);
  return !!m && saved.has(path) && m.getAlternativeVersionId() !== saved.get(path);
}

export function dirtyPaths(): string[] {
  return [...saved.keys()].filter(isDirty);
}

export async function saveModel(path: string): Promise<void> {
  const m = getModel(path);
  if (!m) return;
  await api.writeFile(path, m.getValue());
  saved.set(path, m.getAlternativeVersionId());
  emit();
}

export function disposeModel(path: string) {
  getModel(path)?.dispose();
  saved.delete(path);
  emit();
}

/** Called when files change on disk: reloads open files that have no unsaved edits. */
export async function reloadFromDisk(paths: string[]) {
  for (const path of [...saved.keys()]) {
    if (!paths.some((p) => samePath(p, path)) || isDirty(path)) continue;
    const m = getModel(path);
    if (!m) continue;
    try {
      const text = await api.readFile(path);
      if (text !== m.getValue()) {
        m.pushEditOperations([], [{ range: m.getFullModelRange(), text }], () => null);
        saved.set(path, m.getAlternativeVersionId());
        emit();
      }
    } catch {
      /* deleted: keep the buffer so nothing is lost */
    }
  }
}

/** Moves open models after a rename/move in the explorer. Returns old -> new path pairs. */
export async function renameModels(from: string, to: string): Promise<[string, string][]> {
  const moved: [string, string][] = [];
  for (const path of [...saved.keys()]) {
    const norm = path.replace(/\\/g, "/");
    const f = from.replace(/\\/g, "/");
    if (norm !== f && !norm.startsWith(f + "/")) continue;
    const newPath = to + path.slice(from.length);
    const old = getModel(path)!;
    const wasDirty = isDirty(path);
    await ensureLanguage(languageForPath(newPath));
    const model = monaco.editor.createModel(old.getValue(), languageForPath(newPath), uriFor(newPath));
    saved.set(newPath, wasDirty ? -1 : model.getAlternativeVersionId());
    model.onDidChangeContent(emit);
    old.dispose();
    saved.delete(path);
    moved.push([path, newPath]);
  }
  emit();
  return moved;
}
