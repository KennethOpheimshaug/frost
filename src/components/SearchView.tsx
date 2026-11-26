import { useEffect, useMemo, useRef, useState } from "react";
import { api, basename, dirname, relative, type SearchMatch } from "../lib/api";
import { fileIcon } from "../lib/icons";
import { useStore } from "../store";

export function SearchView() {
  const root = useStore((s) => s.root);
  const openFile = useStore((s) => s.openFile);
  const [query, setQuery] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [results, setResults] = useState<SearchMatch[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const runId = useRef(0);

  useEffect(() => {
    const focus = () => inputRef.current?.select();
    window.addEventListener("ide:focus-search", focus);
    focus();
    return () => window.removeEventListener("ide:focus-search", focus);
  }, []);

  // Search as you type, debounced.
  useEffect(() => {
    if (!root || !query) {
      setResults([]);
      setError(null);
      return;
    }
    const id = ++runId.current;
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await api.searchText(root, query, regex, caseSensitive);
        if (id === runId.current) {
          setResults(r);
          setError(null);
        }
      } catch (e) {
        if (id === runId.current) setError(String(e));
      } finally {
        if (id === runId.current) setBusy(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query, regex, caseSensitive, root]);

  const byFile = useMemo(() => {
    const map = new Map<string, SearchMatch[]>();
    for (const r of results) {
      const list = map.get(r.path) ?? [];
      list.push(r);
      map.set(r.path, list);
    }
    return [...map.entries()];
  }, [results]);

  return (
    <div className="sidebar-view">
      <div className="sidebar-title">Search</div>
      <div className="search-box">
        <div className="search-input-wrap">
          <input
            ref={inputRef}
            className="text-input"
            placeholder="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
          <button className={`toggle ${caseSensitive ? "on" : ""}`} title="Match Case" onClick={() => setCaseSensitive((v) => !v)}>
            <span className="codicon codicon-case-sensitive" />
          </button>
          <button className={`toggle ${regex ? "on" : ""}`} title="Use Regular Expression" onClick={() => setRegex((v) => !v)}>
            <span className="codicon codicon-regex" />
          </button>
        </div>
        <div className="search-summary">
          {!root
            ? "Open a folder to search."
            : error
              ? <span className="error-text">{error}</span>
              : busy
                ? "Searching…"
                : query
                  ? `${results.length}${results.length >= 2000 ? "+" : ""} results in ${byFile.length} files`
                  : ""}
        </div>
      </div>
      <div className="search-results">
        {byFile.map(([path, matches]) => {
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
                <span className="badge">{matches.length}</span>
              </div>
              {!isCollapsed &&
                matches.map((m, i) => {
                  const start = Math.max(0, m.column - 1 - 30);
                  const text = m.text.slice(start);
                  const hl = m.column - 1 - start;
                  return (
                    <div key={i} className="result-line" onClick={() => openFile(path, { line: m.line, column: m.column })} title={`Line ${m.line}`}>
                      {start > 0 && "…"}
                      {text.slice(0, hl)}
                      <mark>{text.slice(hl, hl + m.length)}</mark>
                      {text.slice(hl + m.length)}
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
