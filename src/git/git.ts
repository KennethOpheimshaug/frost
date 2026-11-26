// Version control through the git command line: status, staging, commit, push/pull and branches.
import { create } from "zustand";
import { api, join } from "../lib/api";
import { useOutput } from "../lib/output";
import { useStore } from "../store";

export type ChangeKind = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflict" | "copied" | "typechange";

export interface Change {
  path: string; // absolute
  rel: string; // relative to the repo, forward slashes
  kind: ChangeKind;
  oldRel?: string; // for renames
}

export interface Branch {
  name: string;
  remote: boolean;
  current: boolean;
  upstream?: string;
}

interface GitState {
  /** Repo root, or null when the folder isn't a git repository (or git is missing). */
  repo: string | null;
  available: boolean;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: Change[];
  changes: Change[];
  branches: Branch[];
  busy: string | null;
  message: string;
}

export const useGit = create<GitState>(() => ({
  repo: null,
  available: true,
  branch: null,
  detached: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  staged: [],
  changes: [],
  branches: [],
  busy: null,
  message: localStorage.getItem("frost.commitMessage") ?? "",
}));

const log = (line: string) => useOutput.getState().append("Git", line);

async function git(args: string[], opts: { quiet?: boolean } = {}): Promise<string> {
  const repo = useGit.getState().repo ?? useStore.getState().root;
  if (!repo) throw new Error("No folder open");
  const r = await api.runCapture("git", args, repo);
  if (!opts.quiet) log(`> git ${args.join(" ")}${r.code === 0 ? "" : `  (exit ${r.code})`}`);
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout).trim();
    if (!opts.quiet && msg) log(msg);
    throw new Error(msg || `git ${args[0]} failed`);
  }
  if (!opts.quiet && r.stderr.trim() && args[0] !== "status") log(r.stderr.trim());
  return r.stdout;
}

/** Runs a git operation, showing errors as toasts and refreshing afterwards. */
async function op(label: string, fn: () => Promise<unknown>, success?: string): Promise<boolean> {
  useGit.setState({ busy: label });
  try {
    await fn();
    if (success) useStore.getState().toast(success);
    return true;
  } catch (e) {
    const msg = String(e).replace(/^Error: /, "");
    useStore.getState().toast(`${label} failed: ${msg.split("\n").slice(0, 3).join(" ")}`, "error");
    return false;
  } finally {
    useGit.setState({ busy: null });
    await refresh();
  }
}

// ---------- status ----------

const kinds: Record<string, ChangeKind> = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", T: "typechange", U: "conflict" };

/** Finds the repository for `root` (or clears git state). */
export async function openRepo(root: string | null) {
  if (!root) return useGit.setState({ repo: null, branch: null, staged: [], changes: [], branches: [] });
  try {
    const r = await api.runCapture("git", ["rev-parse", "--show-toplevel"], root);
    if (r.code !== 0) return useGit.setState({ repo: null, available: true, branch: null, staged: [], changes: [], branches: [] });
    const top = r.stdout.trim();
    // git prints forward slashes on Windows too; use the OS form.
    const repo = root.includes("\\") ? top.replace(/\//g, "\\") : top;
    useGit.setState({ repo, available: true });
    await refresh();
    loadBranches();
  } catch {
    useGit.setState({ repo: null, available: false });
  }
}

let refreshing: Promise<void> | null = null;
let again = false;

/** Re-reads `git status`. Calls during a refresh are merged into one more refresh. */
export function refresh(): Promise<void> {
  if (refreshing) {
    again = true;
    return refreshing;
  }
  refreshing = (async () => {
    do {
      again = false;
      await readStatus();
    } while (again);
    refreshing = null;
  })();
  return refreshing;
}

async function readStatus() {
  const repo = useGit.getState().repo;
  if (!repo) return;
  let out: string;
  try {
    out = await git(["status", "--porcelain=v1", "-b", "-z", "--untracked-files=all"], { quiet: true });
  } catch {
    return;
  }
  const parts = out.split("\0");
  const staged: Change[] = [];
  const changes: Change[] = [];
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let detached = false;
  const abs = (rel: string) => join(repo, repo.includes("\\") ? rel.replace(/\//g, "\\") : rel);
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    if (entry.startsWith("## ")) {
      const head = entry.slice(3);
      if (head.startsWith("HEAD (no branch)")) detached = true;
      const m = /^(?:No commits yet on |Initial commit on )?([^.\s]+(?:\.(?!\.)[^.\s]+)*)(?:\.\.\.(\S+))?(?: \[(.*)\])?/.exec(head);
      if (m) {
        branch = detached ? "HEAD" : m[1];
        upstream = m[2] ?? null;
        ahead = +(/ahead (\d+)/.exec(m[3] ?? "")?.[1] ?? 0);
        behind = +(/behind (\d+)/.exec(m[3] ?? "")?.[1] ?? 0);
      }
      continue;
    }
    const x = entry[0];
    const y = entry[1];
    const rel = entry.slice(3);
    let oldRel: string | undefined;
    if (x === "R" || x === "C") oldRel = parts[++i];
    if (x === "?" && y === "?") {
      changes.push({ path: abs(rel), rel, kind: "untracked" });
      continue;
    }
    if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
      changes.push({ path: abs(rel), rel, kind: "conflict" });
      continue;
    }
    if (x !== " " && x !== "?") staged.push({ path: abs(rel), rel, kind: kinds[x] ?? "modified", oldRel });
    if (y !== " " && y !== "?") changes.push({ path: abs(rel), rel, kind: kinds[y] ?? "modified" });
  }
  useGit.setState({ branch, upstream, ahead, behind, detached, staged, changes });
}

// ---------- staging and committing ----------

export const stage = (paths: string[]) => op("Stage", () => git(["add", "--", ...paths]));
export const stageAll = () => op("Stage all", () => git(["add", "-A"]));

export async function unstage(paths: string[]) {
  // `git restore --staged` needs a first commit; `git rm --cached` works before it.
  const hasHead = await api.runCapture("git", ["rev-parse", "--verify", "HEAD"], useGit.getState().repo ?? undefined).then((r) => r.code === 0);
  return op("Unstage", () => (hasHead ? git(["restore", "--staged", "--", ...paths]) : git(["rm", "--cached", "-r", "-q", "--", ...paths])));
}
export const unstageAll = () => unstage(["."]);

/** Throws away working-tree changes (asks first). Untracked files are deleted. */
export async function discard(changes: Change[]) {
  const { ask } = await import("@tauri-apps/plugin-dialog");
  const names = changes.length === 1 ? `"${changes[0].rel}"` : `${changes.length} files`;
  const ok = await ask(`Discard changes in ${names}? This can't be undone.`, { title: "Discard changes", kind: "warning", okLabel: "Discard" });
  if (!ok) return false;
  const untracked = changes.filter((c) => c.kind === "untracked").map((c) => c.rel);
  const tracked = changes.filter((c) => c.kind !== "untracked").map((c) => c.rel);
  return op("Discard", async () => {
    if (tracked.length) await git(["restore", "--", ...tracked]);
    if (untracked.length) await git(["clean", "-f", "-q", "--", ...untracked]);
  });
}

export function setMessage(message: string) {
  useGit.setState({ message });
  localStorage.setItem("frost.commitMessage", message);
}

/** Commits staged changes. With nothing staged, commits all changes (like VS Code's smart commit). */
export async function commit(opts: { amend?: boolean } = {}): Promise<boolean> {
  const { message, staged, changes } = useGit.getState();
  if (!message.trim() && !opts.amend) {
    useStore.getState().toast("Write a commit message first.", "error");
    return false;
  }
  if (!staged.length && !changes.length && !opts.amend) {
    useStore.getState().toast("There are no changes to commit.");
    return false;
  }
  const ok = await op(
    "Commit",
    async () => {
      if (!staged.length && !opts.amend) await git(["add", "-A"]);
      const args = ["commit", "-q"];
      if (opts.amend) args.push("--amend");
      if (message.trim()) args.push("-m", message.trim());
      else args.push("--no-edit");
      await git(args);
    },
    opts.amend ? "Amended the last commit." : "Committed.",
  );
  if (ok) setMessage("");
  return ok;
}

// ---------- remote ----------

export async function push() {
  const { branch, upstream } = useGit.getState();
  if (!branch || branch === "HEAD") return useStore.getState().toast("Check out a branch before pushing.", "error");
  return op("Push", () => (upstream ? git(["push"]) : git(["push", "-u", "origin", branch])), upstream ? "Pushed." : `Pushed and set upstream to origin/${branch}.`);
}

export const pull = () => op("Pull", () => git(["pull", "--ff-only"]), "Pulled.");
export const fetchAll = () => op("Fetch", async () => {
  await git(["fetch", "--all", "--prune"]);
  await loadBranches();
});

/** Pull then push, like VS Code's "Sync Changes". */
export async function sync() {
  const { upstream } = useGit.getState();
  if (upstream && !(await pull())) return;
  await push();
}

export async function commitAndPush() {
  if (await commit()) await push();
}

// ---------- branches ----------

export async function loadBranches() {
  if (!useGit.getState().repo) return;
  try {
    const out = await git(["for-each-ref", "--format=%(HEAD)%09%(refname)%09%(upstream:short)", "refs/heads", "refs/remotes"], { quiet: true });
    const branches: Branch[] = [];
    for (const line of out.split("\n")) {
      const [head, ref, up] = line.split("\t");
      if (!ref || ref.endsWith("/HEAD")) continue;
      if (ref.startsWith("refs/heads/")) branches.push({ name: ref.slice(11), remote: false, current: head === "*", upstream: up || undefined });
      else if (ref.startsWith("refs/remotes/")) branches.push({ name: ref.slice(13), remote: true, current: false });
    }
    useGit.setState({ branches });
  } catch {
    /* no commits yet */
  }
}

/** Switches to a local branch, or creates a tracking branch for a remote one. */
export function checkout(b: Branch) {
  if (b.remote) {
    const local = b.name.split("/").slice(1).join("/");
    const exists = useGit.getState().branches.some((x) => !x.remote && x.name === local);
    return op("Checkout", async () => {
      await git(exists ? ["switch", local] : ["switch", "--track", b.name]);
      await loadBranches();
    }, `Switched to ${local}.`);
  }
  return op("Checkout", async () => {
    await git(["switch", b.name]);
    await loadBranches();
  }, `Switched to ${b.name}.`);
}

export async function createBranch(name: string) {
  const clean = name.trim().replace(/\s+/g, "-");
  if (!clean) return;
  return op("Create branch", async () => {
    await git(["switch", "-c", clean]);
    await loadBranches();
  }, `Created and switched to ${clean}.`);
}

/** File content at HEAD (or in the index with `staged`), for diffs. Empty for new files. */
export async function originalContent(rel: string, fromIndex = false): Promise<string> {
  try {
    return await git(["show", `${fromIndex ? "" : "HEAD"}:${rel}`], { quiet: true });
  } catch {
    return "";
  }
}

/** Status letter + color for a path (explorer, tabs). */
export function decorationFor(path: string): { letter: string; color: string } | null {
  const lower = path.replace(/\\/g, "/").toLowerCase();
  const { staged, changes } = useGit.getState();
  const hit = changes.find((c) => c.path.replace(/\\/g, "/").toLowerCase() === lower) ?? staged.find((c) => c.path.replace(/\\/g, "/").toLowerCase() === lower);
  if (!hit) return null;
  return changeStyle(hit.kind);
}

export function changeStyle(kind: ChangeKind): { letter: string; color: string } {
  switch (kind) {
    case "untracked":
      return { letter: "U", color: "var(--git-untracked)" };
    case "added":
      return { letter: "A", color: "var(--git-added)" };
    case "deleted":
      return { letter: "D", color: "var(--git-deleted)" };
    case "renamed":
      return { letter: "R", color: "var(--git-added)" };
    case "conflict":
      return { letter: "!", color: "var(--git-conflict)" };
    default:
      return { letter: "M", color: "var(--git-modified)" };
  }
}
