// Global workbench state.
import { create } from "zustand";
import { samePath } from "./lib/api";
import type { ActiveTheme } from "./lib/highlighting";
import { defaultSettings, type Settings } from "./lib/settings";

export interface EditorGroup {
  id: number;
  tabs: string[];
  active: string | null;
}

export type SidebarView = "explorer" | "solution" | "search";
export type PanelTab = "terminal" | "problems" | "output";
export type PaletteMode = "commands" | "files" | "line" | "themes" | "symbols" | "projects";

export interface Toast {
  id: number;
  kind: "info" | "error";
  text: string;
}

interface Reveal {
  path: string;
  line: number;
  column: number;
  /** Changes on every request so the same location can be revealed twice. */
  nonce: number;
}

interface State {
  root: string | null;
  settings: Settings;
  theme: ActiveTheme | null;
  groups: EditorGroup[];
  activeGroup: number;
  sidebar: SidebarView | null;
  panelOpen: boolean;
  panelTab: PanelTab;
  palette: { mode: PaletteMode; nonce: number } | null;
  cursor: { line: number; column: number } | null;
  reveal: Reveal | null;
  toasts: Toast[];
  /** Path of the item selected in the explorer. */
  selected: string | null;

  setRoot(root: string | null): void;
  setSettings(s: Settings): void;
  setTheme(t: ActiveTheme): void;
  openFile(path: string, opts?: { group?: number; line?: number; column?: number }): void;
  closeTab(group: number, path: string): void;
  closeOthers(group: number, path: string): void;
  setActiveTab(group: number, path: string): void;
  focusGroup(group: number): void;
  splitRight(): void;
  replacePaths(pairs: [string, string][]): void;
  closePaths(prefix: string): void;
  toggleSidebar(view?: SidebarView): void;
  togglePanel(open?: boolean): void;
  showPanel(tab: PanelTab): void;
  openPalette(mode: PaletteMode): void;
  closePalette(): void;
  setCursor(c: { line: number; column: number } | null): void;
  toast(text: string, kind?: Toast["kind"]): void;
  dismissToast(id: number): void;
  select(path: string | null): void;
}

let nextGroupId = 1;
let toastId = 0;
let nonce = 0;

const underPrefix = (path: string, prefix: string) => {
  const p = path.replace(/\\/g, "/").toLowerCase();
  const f = prefix.replace(/\\/g, "/").toLowerCase();
  return p === f || p.startsWith(f + "/");
};

export const useStore = create<State>((set, get) => ({
  root: null,
  settings: defaultSettings,
  theme: null,
  groups: [{ id: 0, tabs: [], active: null }],
  activeGroup: 0,
  sidebar: "explorer",
  panelOpen: false,
  panelTab: "terminal",
  palette: null,
  cursor: null,
  reveal: null,
  toasts: [],
  selected: null,

  setRoot: (root) => set({ root, groups: [{ id: nextGroupId++, tabs: [], active: null }], activeGroup: 0, selected: null }),
  setSettings: (settings) => set({ settings }),
  setTheme: (theme) => set({ theme }),

  openFile: (path, opts = {}) =>
    set((s) => {
      const gi = Math.min(opts.group ?? s.activeGroup, s.groups.length - 1);
      const groups = s.groups.map((g, i) => {
        if (i !== gi) return g;
        const has = g.tabs.some((t) => samePath(t, path));
        const tabs = has ? g.tabs : g.active ? insertAfter(g.tabs, g.active, path) : [...g.tabs, path];
        return { ...g, tabs, active: g.tabs.find((t) => samePath(t, path)) ?? path };
      });
      const reveal = opts.line ? { path, line: opts.line, column: opts.column ?? 1, nonce: ++nonce } : s.reveal;
      return { groups, activeGroup: gi, reveal };
    }),

  closeTab: (gi, path) =>
    set((s) => {
      let groups = s.groups.map((g, i) => {
        if (i !== gi) return g;
        const idx = g.tabs.indexOf(path);
        const tabs = g.tabs.filter((t) => t !== path);
        const active = g.active === path ? (tabs[Math.min(idx, tabs.length - 1)] ?? null) : g.active;
        return { ...g, tabs, active };
      });
      // An empty split closes itself; the last group always stays.
      if (groups.length > 1 && groups[gi].tabs.length === 0) groups = groups.filter((_, i) => i !== gi);
      return { groups, activeGroup: Math.min(s.activeGroup, groups.length - 1) };
    }),

  closeOthers: (gi, path) =>
    set((s) => ({ groups: s.groups.map((g, i) => (i === gi ? { ...g, tabs: [path], active: path } : g)) })),

  setActiveTab: (gi, path) =>
    set((s) => ({ groups: s.groups.map((g, i) => (i === gi ? { ...g, active: path } : g)), activeGroup: gi })),

  focusGroup: (gi) => set({ activeGroup: gi }),

  splitRight: () =>
    set((s) => {
      if (s.groups.length >= 3) return {};
      const current = s.groups[s.activeGroup];
      const g: EditorGroup = {
        id: nextGroupId++,
        tabs: current.active ? [current.active] : [],
        active: current.active,
      };
      const groups = [...s.groups];
      groups.splice(s.activeGroup + 1, 0, g);
      return { groups, activeGroup: s.activeGroup + 1 };
    }),

  replacePaths: (pairs) =>
    set((s) => {
      const map = (p: string | null) => pairs.find(([from]) => from === p)?.[1] ?? p;
      return {
        groups: s.groups.map((g) => ({ ...g, tabs: g.tabs.map((t) => map(t)!), active: map(g.active) })),
        selected: map(s.selected),
      };
    }),

  closePaths: (prefix) =>
    set((s) => {
      let groups = s.groups.map((g) => {
        const tabs = g.tabs.filter((t) => !underPrefix(t, prefix));
        const active = g.active && underPrefix(g.active, prefix) ? (tabs[tabs.length - 1] ?? null) : g.active;
        return { ...g, tabs, active };
      });
      if (groups.length > 1) groups = groups.filter((g) => g.tabs.length > 0);
      if (groups.length === 0) groups = [{ id: nextGroupId++, tabs: [], active: null }];
      return { groups, activeGroup: Math.min(s.activeGroup, groups.length - 1) };
    }),

  toggleSidebar: (view) =>
    set((s) => {
      if (!view) return { sidebar: s.sidebar ? null : "explorer" };
      return { sidebar: s.sidebar === view ? null : view };
    }),
  togglePanel: (open) => set((s) => ({ panelOpen: open ?? !s.panelOpen })),
  showPanel: (panelTab) => set({ panelOpen: true, panelTab }),
  openPalette: (mode) => set({ palette: { mode, nonce: ++nonce } }),
  closePalette: () => set({ palette: null }),
  setCursor: (cursor) => set({ cursor }),
  toast: (text, kind = "info") => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
    setTimeout(() => get().dismissToast(id), kind === "error" ? 8000 : 4000);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  select: (selected) => set({ selected }),
}));

function insertAfter(list: string[], after: string, item: string) {
  const i = list.indexOf(after);
  const copy = [...list];
  copy.splice(i + 1, 0, item);
  return copy;
}

/** Path of the file shown in the focused editor group. */
export const activeFile = () => {
  const s = useStore.getState();
  return s.groups[s.activeGroup]?.active ?? null;
};
