import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openUrl } from "@tauri-apps/plugin-opener";
import "@xterm/xterm/css/xterm.css";
import { api, basename } from "../lib/api";
import { themeToXterm } from "../lib/uiColors";
import { useStore } from "../store";

interface Session {
  id: string;
  title: string;
  term: Terminal;
  fit: FitAddon;
  exited: boolean;
}

let counter = 0;
const sessions = new Map<string, Session>();

// One listener for all terminals.
api.onPtyData((id, data) => sessions.get(id)?.term.write(data));
api.onPtyExit((id) => {
  const s = sessions.get(id);
  if (s) {
    s.exited = true;
    s.term.write("\r\n\x1b[90m[Process exited. Press any key to close.]\x1b[0m");
  }
});

interface NewTerminal {
  id?: string;
  cwd?: string;
  command?: string;
  args?: string[];
  title?: string;
  env?: Record<string, string>;
}

export function TerminalPanel({ tabs, visible }: { tabs: React.ReactNode; visible: boolean }) {
  const [ids, setIds] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const panelOpen = useStore((s) => s.panelOpen);
  const theme = useStore((s) => s.theme);
  const settings = useStore((s) => s.settings);
  const root = useStore((s) => s.root);
  const hostRef = useRef<HTMLDivElement>(null);

  const create = async (opts: NewTerminal = {}) => {
    const { cwd } = opts;
    const id = opts.id ?? `t${++counter}`;
    if (sessions.has(id)) close(id, true);
    const s = useStore.getState();
    const term = new Terminal({
      fontFamily: s.settings["terminal.integrated.fontFamily"],
      fontSize: s.settings["terminal.integrated.fontSize"],
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10_000,
      theme: s.theme ? themeToXterm(s.theme) : undefined,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, uri) => openUrl(uri)));
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      // Ctrl+C copies when text is selected; Ctrl+V pastes through the browser.
      if (e.ctrlKey && e.key === "c" && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection());
        term.clearSelection();
        return false;
      }
      if (e.ctrlKey && e.key === "v") return false;
      return true;
    });
    const shellName = basename(s.settings["terminal.integrated.shell"] ?? (navigator.userAgent.includes("Windows") ? "powershell" : "shell"));
    const session: Session = { id, title: opts.title ?? shellName, term, fit, exited: false };
    sessions.set(id, session);
    term.onData((data) => {
      if (session.exited) return close(id);
      api.ptyWrite(id, data).catch(() => {});
    });
    term.onResize(({ cols, rows }) => api.ptyResize(id, cols, rows).catch(() => {}));
    setIds((list) => [...list.filter((x) => x !== id), id]);
    setActive(id);
    useStore.getState().showPanel("terminal");
    // Wait for the element to mount, then size and start the shell.
    requestAnimationFrame(async () => {
      const el = document.getElementById(`term-${id}`);
      if (!el) return;
      term.open(el);
      fit.fit();
      try {
        await api.ptySpawn({
          id,
          cwd: cwd ?? useStore.getState().root ?? undefined,
          cols: term.cols,
          rows: term.rows,
          command: opts.command ?? s.settings["terminal.integrated.shell"] ?? undefined,
          args: opts.args,
          env: opts.env,
        });
      } catch (e) {
        term.write(`\x1b[31mFailed to start shell: ${e}\x1b[0m`);
      }
      term.focus();
    });
  };

  const close = (id: string, replacing = false) => {
    api.ptyKill(id).catch(() => {});
    sessions.get(id)?.term.dispose();
    sessions.delete(id);
    if (replacing) return;
    setIds((list) => {
      const next = list.filter((x) => x !== id);
      setActive((a) => (a === id ? next[next.length - 1] ?? null : a));
      if (next.length === 0 && useStore.getState().panelTab === "terminal") useStore.getState().togglePanel(false);
      return next;
    });
  };

  // Open a first terminal when the terminal tab is shown empty.
  useEffect(() => {
    if (!panelOpen || !visible) return;
    if (ids.length === 0) create();
    else if (active)
      requestAnimationFrame(() => {
        sessions.get(active)?.fit.fit();
        sessions.get(active)?.term.focus();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelOpen, visible]);

  useEffect(() => {
    const onNew = (e: Event) => create((e as CustomEvent<NewTerminal>).detail ?? {});
    const onKill = (e: Event) => {
      const id = (e as CustomEvent<{ id: string }>).detail.id;
      if (sessions.has(id)) close(id);
    };
    const onFocus = () => active && sessions.get(active)?.term.focus();
    window.addEventListener("ide:new-terminal", onNew);
    window.addEventListener("ide:kill-terminal", onKill);
    window.addEventListener("ide:focus-terminal", onFocus);
    return () => {
      window.removeEventListener("ide:new-terminal", onNew);
      window.removeEventListener("ide:kill-terminal", onKill);
      window.removeEventListener("ide:focus-terminal", onFocus);
    };
  });

  // Theme and font changes apply to all terminals.
  useEffect(() => {
    for (const s of sessions.values()) {
      if (theme) s.term.options.theme = themeToXterm(theme);
      s.term.options.fontSize = settings["terminal.integrated.fontSize"];
      s.term.options.fontFamily = settings["terminal.integrated.fontFamily"];
      s.fit.fit();
    }
  }, [theme, settings]);

  // Refit when the panel or window is resized.
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (active && el.clientHeight > 0) sessions.get(active)?.fit.fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [active]);

  // Terminals from an old folder keep running; new ones start in the new folder.
  useEffect(() => void root, [root]);

  return (
    <div className="panel" style={{ display: visible ? "flex" : "none" }}>
      <div className="panel-header">
        {tabs}
        <div className="terminal-tabs">
          {ids.map((id, i) => (
            <div key={id} className={`terminal-tab ${id === active ? "active" : ""}`} onClick={() => setActive(id)}>
              <span className="codicon codicon-terminal" />
              <span>{sessions.get(id)?.title ?? `${i + 1}`}</span>
              <button
                className="icon-button"
                title="Kill Terminal"
                onClick={(e) => {
                  e.stopPropagation();
                  close(id);
                }}
              >
                <span className="codicon codicon-trash" />
              </button>
            </div>
          ))}
        </div>
        <div className="panel-actions">
          <button className="icon-button" title="New Terminal (Ctrl+Shift+`)" onClick={() => create({})}>
            <span className="codicon codicon-add" />
          </button>
          <button className="icon-button" title="Hide Panel (Ctrl+`)" onClick={() => useStore.getState().togglePanel(false)}>
            <span className="codicon codicon-chevron-down" />
          </button>
        </div>
      </div>
      <div className="terminal-host" ref={hostRef}>
        {ids.map((id) => (
          <div key={id} id={`term-${id}`} className="terminal-instance" style={{ display: id === active ? "block" : "none" }} />
        ))}
      </div>
    </div>
  );
}
