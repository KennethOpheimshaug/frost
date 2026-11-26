// Recently opened folders for the welcome screen.
import { samePath } from "./api";

export interface RecentEntry {
  path: string;
  /** Solution or project file the folder was opened through, if any. */
  solution?: string;
  openedAt: number;
  pinned?: boolean;
}

const KEY = "frost.recent";
const MAX = 30;

export function recentList(): RecentEntry[] {
  try {
    const list: RecentEntry[] = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return list.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.openedAt - a.openedAt);
  } catch {
    return [];
  }
}

function save(list: RecentEntry[]) {
  localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
}

export function addRecent(path: string, solution?: string) {
  const list = recentList();
  const old = list.find((r) => samePath(r.path, path));
  save([{ path, solution: solution ?? old?.solution, openedAt: Date.now(), pinned: old?.pinned }, ...list.filter((r) => r !== old)]);
}

export function removeRecent(path: string) {
  save(recentList().filter((r) => !samePath(r.path, path)));
}

export function togglePinned(path: string) {
  save(recentList().map((r) => (samePath(r.path, path) ? { ...r, pinned: !r.pinned } : r)));
}

export function timeAgo(t: number): string {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  return new Date(t).toLocaleDateString();
}
