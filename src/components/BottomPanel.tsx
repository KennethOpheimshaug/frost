import { useEffect, useMemo, useRef, useState } from "react";
import { basename, dirname, relative } from "../lib/api";
import { fileIcon } from "../lib/icons";
import { useOutput, type Channel } from "../lib/output";
import { allProblems, useProblems, type Problem } from "../lib/problems";
import { useStore, type PanelTab } from "../store";
import { TerminalPanel } from "./TerminalPanel";
import { DebugConsole } from "./DebugView";

export function BottomPanel() {
  const tab = useStore((s) => s.panelTab);
  useProblems((s) => s.byFile);
  const problems = allProblems();
  const errors = problems.filter((p) => p.severity === "error").length;
  const warnings = problems.filter((p) => p.severity === "warning").length;

  const tabs = (
    <div className="panel-tabs">
      {(
        [
          ["problems", "Problems", errors + warnings || null],
          ["output", "Output", null],
          ["debug", "Debug Console", null],
          ["terminal", "Terminal", null],
        ] as [PanelTab, string, number | null][]
      ).map(([id, label, count]) => (
        <button key={id} className={`panel-tab ${tab === id ? "active" : ""}`} onClick={() => useStore.getState().showPanel(id)}>
          {label}
          {count != null && <span className="badge">{count}</span>}
        </button>
      ))}
    </div>
  );

  return (
    <>
      {tab === "problems" && <ProblemsPanel tabs={tabs} problems={problems} />}
      {tab === "output" && <OutputPanel tabs={tabs} />}
      {tab === "debug" && <DebugConsole tabs={tabs} />}
      <TerminalPanel tabs={tabs} visible={tab === "terminal"} />
    </>
  );
}

const sevIcon: Record<Problem["severity"], string> = {
  error: "codicon-error",
  warning: "codicon-warning",
  info: "codicon-info",
  hint: "codicon-lightbulb",
};

function ProblemsPanel({ tabs, problems }: { tabs: React.ReactNode; problems: Problem[] }) {
  const root = useStore((s) => s.root);
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const groups = useMemo(() => {
    const f = filter.toLowerCase();
    const map = new Map<string, Problem[]>();
    for (const p of problems) {
      if (f && !`${p.message} ${p.code ?? ""} ${p.path}`.toLowerCase().includes(f)) continue;
      const list = map.get(p.path) ?? [];
      list.push(p);
      map.set(p.path, list);
    }
    const rank = (list: Problem[]) => (list.some((p) => p.severity === "error") ? 0 : 1);
    return [...map.entries()]
      .map(([path, list]) => [path, list.sort((a, b) => a.line - b.line)] as const)
      .sort((a, b) => rank(a[1]) - rank(b[1]) || a[0].localeCompare(b[0]));
  }, [problems, filter]);

  return (
    <div className="panel">
      <div className="panel-header">
        {tabs}
        <div className="panel-spacer" />
        <input className="text-input panel-filter" placeholder="Filter (e.g. CS0103, text, path)" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="problems-list">
        {groups.length === 0 && <div className="panel-empty">No problems have been detected.</div>}
        {groups.map(([path, list]) => {
          const icon = fileIcon(basename(path));
          const isCollapsed = collapsed.has(path);
          return (
            <div key={path}>
              <div
                className="result-file"
                onClick={() =>
                  setCollapsed((c) => {
                    const n = new Set(c);
                    if (n.has(path)) n.delete(path);
                    else n.add(path);
                    return n;
                  })
                }
              >
                <span className={`codicon ${isCollapsed ? "codicon-chevron-right" : "codicon-chevron-down"}`} />
                <span className={`codicon ${icon.icon}`} style={{ color: icon.color }} />
                <span className="result-name">{basename(path)}</span>
                <span className="result-dir">{root ? relative(root, dirname(path)) : dirname(path)}</span>
                <span className="badge">{list.length}</span>
              </div>
              {!isCollapsed &&
                list.map((p, i) => (
                  <div key={i} className="problem-row" onClick={() => useStore.getState().openFile(p.path, { line: p.line, column: p.column })}>
                    <span className={`codicon ${sevIcon[p.severity]} sev-${p.severity}`} />
                    <span className="problem-message">{p.message}</span>
                    <span className="problem-meta">
                      {p.source}
                      {p.code ? `(${p.code})` : ""} [Ln {p.line}, Col {p.column}]
                    </span>
                  </div>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function OutputPanel({ tabs }: { tabs: React.ReactNode }) {
  const [channel, setChannel] = useState<Channel>("Build");
  const lines = useOutput((s) => s.lines[channel]);
  const ref = useRef<HTMLPreElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div className="panel">
      <div className="panel-header">
        {tabs}
        <div className="panel-spacer" />
        <select className="text-input panel-select" value={channel} onChange={(e) => setChannel(e.target.value as Channel)}>
          <option value="Build">Build</option>
          <option value="C#">C# Language Server</option>
          <option value="Frost">Frost (workspace)</option>
        </select>
        <button className="icon-button" title="Clear Output" onClick={() => useOutput.getState().clear(channel)}>
          <span className="codicon codicon-clear-all" />
        </button>
      </div>
      <pre
        className="output-text"
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
        }}
      >
        {lines.join("\n")}
      </pre>
    </div>
  );
}
