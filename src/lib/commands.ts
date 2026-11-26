// Command registry: everything in the command palette, with optional keybindings.

export interface Command {
  id: string;
  label: string;
  /** Shown in the palette, e.g. "Ctrl+Shift+P". */
  keybinding?: string;
  /** Extra keybindings (e.g. Rider's next to Visual Studio's). */
  keys?: string[];
  run: () => void | Promise<void>;
}

const commands = new Map<string, Command>();

export function registerCommands(list: Command[]) {
  for (const c of list) commands.set(c.id, c);
}

export const allCommands = () => [...commands.values()].sort((a, b) => a.label.localeCompare(b.label));
export const runCommand = (id: string) => commands.get(id)?.run();

/** Recently used command ids, most recent first (kept per session). */
const recent: string[] = [];
export function markRecent(id: string) {
  const i = recent.indexOf(id);
  if (i >= 0) recent.splice(i, 1);
  recent.unshift(id);
  recent.length = Math.min(recent.length, 10);
}
export const recentCommands = () => recent.map((id) => commands.get(id)).filter(Boolean) as Command[];

/** Turns a KeyboardEvent into "Ctrl+Shift+P" style text. */
export function keyString(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  let key = e.key;
  if (e.code === "Backquote") key = "`";
  else if (e.code === "Backslash") key = "\\";
  else if (e.code.startsWith("Key")) key = e.code.slice(3);
  else if (e.code.startsWith("Digit")) key = e.code.slice(5);
  else if (key.length === 1) key = key.toUpperCase();
  if (["Control", "Shift", "Alt", "Meta"].includes(key)) return "";
  parts.push(key);
  return parts.join("+");
}

/** Finds the command bound to a key string, if any. */
export function commandForKey(key: string): Command | undefined {
  for (const c of commands.values()) if (c.keybinding === key || c.keys?.includes(key)) return c;
  return undefined;
}
