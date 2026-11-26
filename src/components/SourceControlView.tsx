import { useEffect, useState } from "react";
import { basename, dirname } from "../lib/api";
import { fileIcon } from "../lib/icons";
import { showMenu, promptInput } from "../lib/overlay";
import { useStore } from "../store";
import {
  changeStyle, checkout, commit, commitAndPush, createBranch, discard, fetchAll, loadBranches, pull, push, refresh, setMessage, stage,
  stageAll, sync, unstage, unstageAll, useGit, type Branch, type Change,
} from "../git/git";
import { diffPath } from "../git/DiffPane";

export function SourceControlView() {
  const root = useStore((s) => s.root);
  const g = useGit();
  const [branchesOpen, setBranchesOpen] = useState(true);

  useEffect(() => {
    refresh();
    loadBranches();
  }, []);

  if (!root) return <Empty text="Open a folder to use source control." />;
  if (!g.available) return <Empty text="Git wasn't found. Install Git for Windows (git-scm.com) and restart Frost." />;
  if (!g.repo) return <Empty text="This folder isn't a git repository. Run 'git init' in the terminal to start one." />;

  const total = g.staged.length + g.changes.length;
  const canCommit = !!g.message.trim() && total > 0 && !g.busy;
  const branchMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY, [
      { label: "Commit", action: () => commit() },
      { label: "Commit & Push", action: () => commitAndPush() },
      { label: "Amend Last Commit", action: () => commit({ amend: true }) },
      { separator: true },
      { label: "Pull", action: () => pull() },
      { label: "Push", action: () => push() },
      { label: "Sync (pull, then push)", action: () => sync() },
      { label: "Fetch", action: () => fetchAll() },
      { separator: true },
      { label: "Stage All Changes", action: () => stageAll() },
      { label: "Unstage All", action: () => unstageAll() },
      { label: "Discard All Changes", action: () => discard(g.changes) },
      { separator: true },
      { label: "Show Git Output", action: () => useStore.getState().showPanel("output") },
    ]);
  };

  return (
    <div className="sidebar-view">
      <div className="sidebar-title">
        <span>Source Control</span>
        <span className="panel-spacer" />
        <button className="icon-button" title="Refresh" onClick={() => (refresh(), loadBranches())}>
          <span className="codicon codicon-refresh" />
        </button>
        <button className="icon-button" title="More actions" onClick={branchMenu}>
          <span className="codicon codicon-ellipsis" />
        </button>
      </div>

      <div className="scm-commit">
        <textarea
          className="text-input scm-message"
          placeholder={`Message (Ctrl+Enter to commit on "${g.branch ?? "…"}")`}
          value={g.message}
          rows={Math.min(6, Math.max(2, g.message.split("\n").length))}
          spellCheck={false}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.ctrlKey) {
              e.preventDefault();
              if (e.shiftKey) commitAndPush();
              else commit();
            }
          }}
        />
        <div className="scm-buttons">
          <button className="primary-button scm-commit-button" disabled={!canCommit} onClick={() => commit()} title={g.staged.length ? "Commit staged changes" : "Commit all changes"}>
            <span className="codicon codicon-check" /> Commit{g.staged.length ? "" : " All"}
          </button>
          <button className="primary-button scm-split" disabled={!canCommit} onClick={() => commitAndPush()} title="Commit & Push (Ctrl+Shift+Enter)">
            <span className="codicon codicon-cloud-upload" />
          </button>
        </div>
        {(g.ahead > 0 || g.behind > 0 || !g.upstream) && g.branch && g.branch !== "HEAD" && (
          <button className="secondary-button" disabled={!!g.busy} onClick={() => (g.upstream ? sync() : push())}>
            <span className="codicon codicon-sync" />{" "}
            {!g.upstream ? `Publish ${g.branch}` : `Sync Changes ${g.behind ? `${g.behind}↓ ` : ""}${g.ahead ? `${g.ahead}↑` : ""}`}
          </button>
        )}
        {g.busy && (
          <div className="muted scm-busy">
            <span className="codicon codicon-loading codicon-modifier-spin" /> {g.busy}…
          </div>
        )}
      </div>

      <div className="scm-lists">
        {g.staged.length > 0 && (
          <ChangeGroup
            title="Staged Changes"
            items={g.staged}
            staged
            actions={
              <button className="icon-button" title="Unstage All" onClick={() => unstageAll()}>
                <span className="codicon codicon-remove" />
              </button>
            }
          />
        )}
        <ChangeGroup
          title="Changes"
          items={g.changes}
          actions={
            <>
              <button className="icon-button" title="Discard All Changes" onClick={() => discard(g.changes)}>
                <span className="codicon codicon-discard" />
              </button>
              <button className="icon-button" title="Stage All Changes" onClick={() => stageAll()}>
                <span className="codicon codicon-add" />
              </button>
            </>
          }
        />

        <div className="section-header scm-branches-header" onClick={() => setBranchesOpen(!branchesOpen)}>
          <span className={`codicon ${branchesOpen ? "codicon-chevron-down" : "codicon-chevron-right"}`} />
          <span className="section-name">Branches</span>
          <span className="section-actions" onClick={(e) => e.stopPropagation()}>
            <button className="icon-button" title="Fetch from remotes" onClick={() => fetchAll()}>
              <span className="codicon codicon-repo-fetch" />
            </button>
            <button className="icon-button" title="New Branch…" onClick={async () => createBranch((await promptInput("New branch name (from the current branch)")) ?? "")}>
              <span className="codicon codicon-add" />
            </button>
          </span>
        </div>
        {branchesOpen && <Branches />}
      </div>
    </div>
  );
}

function ChangeGroup({ title, items, staged, actions }: { title: string; items: Change[]; staged?: boolean; actions: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="scm-group">
      <div className="section-header" onClick={() => setOpen(!open)}>
        <span className={`codicon ${open ? "codicon-chevron-down" : "codicon-chevron-right"}`} />
        <span className="section-name">{title}</span>
        <span className="section-actions" onClick={(e) => e.stopPropagation()}>
          {actions}
        </span>
        <span className="badge">{items.length}</span>
      </div>
      {open && items.length === 0 && <div className="debug-empty">No changes.</div>}
      {open && items.map((c) => <ChangeRow key={c.rel + (staged ? ":s" : "")} change={c} staged={!!staged} />)}
    </div>
  );
}

function ChangeRow({ change, staged }: { change: Change; staged: boolean }) {
  const icon = fileIcon(basename(change.rel));
  const style = changeStyle(change.kind);
  const openDiff = () =>
    change.kind === "untracked" || (change.kind === "added" && !staged)
      ? useStore.getState().openFile(change.path)
      : change.kind === "deleted" && !staged
        ? useStore.getState().openFile(diffPath("work", change.path))
        : useStore.getState().openFile(diffPath(staged ? "staged" : "work", change.path));
  return (
    <div
      className="scm-row"
      title={`${change.rel}${change.oldRel ? ` (renamed from ${change.oldRel})` : ""}`}
      onClick={openDiff}
      onContextMenu={(e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [
          { label: "Open Changes", action: openDiff },
          { label: "Open File", action: () => useStore.getState().openFile(change.path), disabled: change.kind === "deleted" },
          { separator: true },
          staged ? { label: "Unstage", action: () => unstage([change.rel]) } : { label: "Stage", action: () => stage([change.rel]) },
          ...(staged ? [] : [{ label: "Discard Changes", action: () => discard([change]) }]),
          { separator: true },
          { label: "Copy Path", action: () => navigator.clipboard.writeText(change.path) },
        ]);
      }}
    >
      <span className={`codicon ${icon.icon} file-icon`} style={{ color: icon.color }} />
      <span className="scm-name" style={{ textDecoration: change.kind === "deleted" ? "line-through" : undefined }}>
        {basename(change.rel)}
      </span>
      <span className="scm-dir">{dirname(change.rel) === change.rel ? "" : dirname(change.rel).replace(/^\.$/, "")}</span>
      <span className="scm-actions">
        {!staged && (
          <button
            className="icon-button"
            title="Discard Changes"
            onClick={(e) => {
              e.stopPropagation();
              discard([change]);
            }}
          >
            <span className="codicon codicon-discard" />
          </button>
        )}
        <button
          className="icon-button"
          title={staged ? "Unstage" : "Stage"}
          onClick={(e) => {
            e.stopPropagation();
            if (staged) unstage([change.rel]);
            else stage([change.rel]);
          }}
        >
          <span className={`codicon ${staged ? "codicon-remove" : "codicon-add"}`} />
        </button>
      </span>
      <span className="scm-letter" style={{ color: style.color }}>
        {style.letter}
      </span>
    </div>
  );
}

function Branches() {
  const branches = useGit((g) => g.branches);
  const current = useGit((g) => g.branch);
  const local = branches.filter((b) => !b.remote);
  const remote = branches.filter((b) => b.remote);
  const row = (b: Branch) => (
    <div
      key={(b.remote ? "r:" : "l:") + b.name}
      className={`scm-row branch-row ${b.current || (!b.remote && b.name === current) ? "current" : ""}`}
      onDoubleClick={() => !b.current && checkout(b)}
      title={b.remote ? `Remote branch ${b.name}. Double-click to check out.` : b.upstream ? `Tracks ${b.upstream}. Double-click to check out.` : "Double-click to check out."}
      onContextMenu={(e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [{ label: b.remote ? "Check Out as Local Branch" : "Check Out", action: () => checkout(b), disabled: b.current }]);
      }}
    >
      <span className={`codicon ${b.remote ? "codicon-cloud" : "codicon-git-branch"}`} />
      <span className="scm-name">{b.name}</span>
      {b.upstream && <span className="scm-dir">→ {b.upstream}</span>}
      {(b.current || (!b.remote && b.name === current)) && <span className="codicon codicon-check scm-letter" />}
    </div>
  );
  return (
    <div className="scm-group">
      <div className="scm-subtitle">Local</div>
      {local.length ? local.map(row) : <div className="debug-empty">No local branches yet (make a first commit).</div>}
      <div className="scm-subtitle">Remote</div>
      {remote.length ? remote.map(row) : <div className="debug-empty">No remote branches. Add a remote, then Fetch.</div>}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="sidebar-view">
      <div className="sidebar-title">Source Control</div>
      <div className="empty-explorer">
        <p>{text}</p>
      </div>
    </div>
  );
}
