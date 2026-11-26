import { useEffect, useRef, useState } from "react";
import { basename } from "../lib/api";
import { promptInput, showMenu } from "../lib/overlay";
import { useSolution } from "../dotnet/solution";
import { removeAllBreakpoints, removeBreakpoint, setExceptionFilters, updateBreakpoint, useBreakpoints } from "../dap/breakpoints";
import {
  addWatch, clearConsole, continueRun, loadVariables, pause, refreshWatches, removeWatch, replEvaluate, restartDebugging,
  selectFrame, setVariable, startDebugging, stepInto, stepOut, stepOver, stopDebugging, useDebug, type Variable,
} from "../dap/session";
import { runCommand } from "../lib/commands";
import { useStore } from "../store";

// ---------- sidebar: Run and Debug ----------

export function DebugView() {
  const status = useDebug((s) => s.status);
  const { projects, startup } = useSolution();
  const current = projects.find((p) => p.path === startup);
  return (
    <div className="sidebar-view">
      <div className="sidebar-title">Run and Debug</div>
      {status === "inactive" && (
        <div className="debug-start">
          <button className="primary-button" disabled={!current} onClick={() => startDebugging()}>
            <span className="codicon codicon-debug-alt" /> Debug {current?.name ?? "…"}
          </button>
          <button className="link-button" onClick={() => runCommand("debug.attach")}>
            Attach to Process…
          </button>
          {!current && <p className="muted">Pick a startup project in the toolbar first.</p>}
        </div>
      )}
      <div className="debug-sections">
        <Section title="Variables" grow>
          <Variables />
        </Section>
        <Section title="Watch" actions={<IconBtn icon="add" title="Add Expression" onClick={async () => addWatch((await promptInput("Expression to watch")) ?? "")} />}>
          <Watches />
        </Section>
        <Section title="Call Stack">
          <CallStack />
        </Section>
        <Section
          title="Breakpoints"
          actions={<IconBtn icon="close-all" title="Remove All Breakpoints" onClick={removeAllBreakpoints} />}
        >
          <Breakpoints />
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children, actions, grow }: { title: string; children: React.ReactNode; actions?: React.ReactNode; grow?: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <div className={`debug-section ${open && grow ? "grow" : ""}`}>
      <div className="section-header" onClick={() => setOpen(!open)}>
        <span className={`codicon ${open ? "codicon-chevron-down" : "codicon-chevron-right"}`} />
        <span className="section-name">{title}</span>
        <span className="section-actions" onClick={(e) => e.stopPropagation()}>
          {actions}
        </span>
      </div>
      {open && <div className="debug-section-body">{children}</div>}
    </div>
  );
}

const IconBtn = ({ icon, title, onClick, disabled }: { icon: string; title: string; onClick: () => void; disabled?: boolean }) => (
  <button className="icon-button" title={title} onClick={onClick} disabled={disabled}>
    <span className={`codicon codicon-${icon}`} />
  </button>
);

function Variables() {
  const { scopes, status } = useDebug();
  if (status !== "stopped") return <div className="debug-empty">{status === "inactive" ? "Not debugging." : "Running…"}</div>;
  return (
    <>
      {scopes.map((s) => (
        <VarNode key={s.variablesReference} name={s.name} value="" reference={s.variablesReference} depth={0} initiallyOpen={!s.expensive} isScope container={0} />
      ))}
    </>
  );
}

function VarNode(props: { name: string; value: string; type?: string; reference: number; depth: number; initiallyOpen?: boolean; isScope?: boolean; container: number }) {
  const [open, setOpen] = useState(!!props.initiallyOpen);
  const children = useDebug((s) => s.variables[props.reference]);
  useEffect(() => {
    if (open && props.reference && !children) loadVariables(props.reference);
  }, [open, props.reference, children]);
  const expandable = props.reference > 0;
  return (
    <>
      <div
        className="var-row"
        style={{ paddingLeft: 8 + props.depth * 12 }}
        onClick={() => expandable && setOpen(!open)}
        onDoubleClick={async () => {
          if (props.isScope || expandable) return;
          const v = await promptInput(`Set value of ${props.name}`, props.value);
          if (v !== null) setVariable(props.container, props.name, v);
        }}
        title={props.type ? `${props.name}: ${props.type}` : props.name}
      >
        {expandable ? <span className={`codicon ${open ? "codicon-chevron-down" : "codicon-chevron-right"} twisty`} /> : <span className="twisty-space" />}
        <span className={props.isScope ? "var-scope" : "var-name"}>{props.name}</span>
        {!props.isScope && (
          <>
            <span className="var-sep">=</span>
            <span className={`var-value ${valueClass(props.value)}`}>{props.value}</span>
          </>
        )}
      </div>
      {open &&
        (children ?? []).map((v: Variable, i) => (
          <VarNode key={`${v.name}-${i}`} name={v.name} value={v.value} type={v.type} reference={v.variablesReference} depth={props.depth + 1} container={props.reference} />
        ))}
    </>
  );
}

const valueClass = (v: string) => (/^".*"$/.test(v) ? "str" : /^-?[\d.]+[fdmLU]*$/.test(v) ? "num" : v === "true" || v === "false" || v === "null" ? "kw" : "");

function Watches() {
  const watches = useDebug((s) => s.watches);
  const status = useDebug((s) => s.status);
  useEffect(() => {
    refreshWatches();
  }, [status]);
  if (!watches.length) return <div className="debug-empty">No watch expressions. Use + to add one.</div>;
  return (
    <>
      {watches.map((w, i) => (
        <div key={i} className="var-row watch-row">
          {w.variablesReference ? <VarNode name={w.expression} value={w.value ?? ""} reference={w.variablesReference} depth={0} container={0} /> : (
            <>
              <span className="twisty-space" />
              <span className="var-name">{w.expression}</span>
              {w.value !== undefined && (
                <>
                  <span className="var-sep">=</span>
                  <span className={`var-value ${w.error ? "error-text" : valueClass(w.value)}`}>{w.value}</span>
                </>
              )}
            </>
          )}
          <button className="icon-button row-action" title="Remove" onClick={() => removeWatch(i)}>
            <span className="codicon codicon-close" />
          </button>
        </div>
      ))}
    </>
  );
}

function CallStack() {
  const { frames, selectedFrame, status, threads, stoppedThread, stopReason } = useDebug();
  if (status !== "stopped") return <div className="debug-empty">{status === "inactive" ? "Not debugging." : "Running…"}</div>;
  const thread = threads.find((t) => t.id === stoppedThread);
  return (
    <>
      <div className="stack-thread">
        <span className="codicon codicon-debug-pause" /> {thread?.name || `Thread ${stoppedThread}`} <span className="muted">paused on {stopReason}</span>
      </div>
      {frames.map((f) => (
        <div key={f.id} className={`stack-frame ${f.id === selectedFrame ? "selected" : ""} ${f.path ? "" : "external"}`} onClick={() => f.path && selectFrame(f.id)} title={f.path ?? "External code"}>
          <span className="frame-name">{f.name}</span>
          {f.path && (
            <span className="muted">
              {basename(f.path)}:{f.line}
            </span>
          )}
        </div>
      ))}
    </>
  );
}

function Breakpoints() {
  const { list, exceptionFilters } = useBreakpoints();
  const options = useDebug((s) => s.exceptionFilterOptions);
  return (
    <>
      {options.map((o) => (
        <label key={o.filter} className="bp-row">
          <input
            type="checkbox"
            checked={exceptionFilters.includes(o.filter)}
            onChange={(e) => setExceptionFilters(e.target.checked ? [...exceptionFilters, o.filter] : exceptionFilters.filter((f) => f !== o.filter))}
          />
          <span>{o.label}</span>
        </label>
      ))}
      {[...list]
        .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
        .map((b) => (
          <div
            key={b.id}
            className="bp-row"
            onClick={() => useStore.getState().openFile(b.path, { line: b.line })}
            onContextMenu={(e) => {
              e.preventDefault();
              showMenu(e.clientX, e.clientY, [
                { label: "Remove", action: () => removeBreakpoint(b.id) },
                {
                  label: "Edit Condition…",
                  action: async () => {
                    const v = await promptInput("Break when this expression is true (C#)", b.condition ?? "");
                    if (v !== null) updateBreakpoint(b.id, { condition: v || undefined });
                  },
                },
              ]);
            }}
            title={b.path}
          >
            <input type="checkbox" checked={b.enabled} onClick={(e) => e.stopPropagation()} onChange={(e) => updateBreakpoint(b.id, { enabled: e.target.checked })} />
            <span className={`bp-dot ${b.logMessage ? "log" : b.condition || b.hitCondition ? "conditional" : ""} ${b.verified === false ? "unverified" : ""}`} />
            <span>{basename(b.path)}</span>
            <span className="muted">
              {b.line}
              {b.condition ? ` · when ${b.condition}` : ""}
              {b.logMessage ? ` · log "${b.logMessage}"` : ""}
            </span>
            <button
              className="icon-button row-action"
              title="Remove"
              onClick={(e) => {
                e.stopPropagation();
                removeBreakpoint(b.id);
              }}
            >
              <span className="codicon codicon-close" />
            </button>
          </div>
        ))}
    </>
  );
}

// ---------- floating toolbar ----------

export function DebugToolbar() {
  const status = useDebug((s) => s.status);
  if (status === "inactive") return null;
  const stopped = status === "stopped";
  return (
    <div className="debug-toolbar">
      {stopped ? (
        <IconBtn icon="debug-continue" title="Continue (F5)" onClick={continueRun} />
      ) : (
        <IconBtn icon="debug-pause" title="Pause (F6)" onClick={pause} disabled={status === "starting"} />
      )}
      <IconBtn icon="debug-step-over" title="Step Over (F10 / F8)" onClick={stepOver} disabled={!stopped} />
      <IconBtn icon="debug-step-into" title="Step Into (F11 / F7)" onClick={stepInto} disabled={!stopped} />
      <IconBtn icon="debug-step-out" title="Step Out (Shift+F11 / Shift+F8)" onClick={stepOut} disabled={!stopped} />
      <IconBtn icon="debug-restart" title="Restart (Ctrl+Shift+F5)" onClick={restartDebugging} />
      <IconBtn icon="debug-stop" title="Stop (Shift+F5)" onClick={stopDebugging} />
    </div>
  );
}

// ---------- panel: Debug Console ----------

export function DebugConsole({ tabs }: { tabs: React.ReactNode }) {
  const lines = useDebug((s) => s.console);
  const status = useDebug((s) => s.status);
  const exceptionText = useDebug((s) => s.exceptionText);
  const ref = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState("");
  const history = useRef<string[]>([]);
  const hi = useRef(0);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines]);
  return (
    <div className="panel">
      <div className="panel-header">
        {tabs}
        <div className="panel-spacer" />
        <button className="icon-button" title="Clear Console" onClick={clearConsole}>
          <span className="codicon codicon-clear-all" />
        </button>
      </div>
      {exceptionText && (
        <div className="exception-banner">
          <span className="codicon codicon-error" /> {exceptionText}
        </div>
      )}
      <div className="debug-console" ref={ref}>
        {lines.map((l, i) => (
          <div key={i} className={`console-line ${l.kind}`}>
            {l.text}
          </div>
        ))}
      </div>
      <div className="console-input">
        <span className="codicon codicon-chevron-right" />
        <input
          className="text-input"
          placeholder={status === "stopped" ? "Evaluate an expression in the current frame" : "Pause at a breakpoint to evaluate expressions"}
          disabled={status !== "stopped"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && input.trim()) {
              history.current.push(input);
              hi.current = history.current.length;
              replEvaluate(input);
              setInput("");
            } else if (e.key === "ArrowUp" && hi.current > 0) setInput(history.current[--hi.current]);
            else if (e.key === "ArrowDown" && hi.current < history.current.length) setInput(history.current[++hi.current] ?? "");
          }}
        />
      </div>
    </div>
  );
}
