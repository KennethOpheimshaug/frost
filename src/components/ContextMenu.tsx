import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type MenuItem =
  | { separator: true }
  | { label: string; hint?: string; action: () => void; disabled?: boolean; separator?: false };

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.min(x, window.innerWidth - r.width - 4),
      y: Math.min(y, window.innerHeight - r.height - 4),
    });
  }, [x, y]);

  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e.type === "mousedown" && ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener("mousedown", close, true);
    window.addEventListener("keydown", close, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("keydown", close, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return (
    <div className="context-menu" ref={ref} style={{ left: pos.x, top: pos.y }}>
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="menu-separator" />
        ) : (
          <div
            key={i}
            className={`menu-item ${item.disabled ? "disabled" : ""}`}
            onClick={() => {
              if (item.disabled) return;
              onClose();
              item.action();
            }}
          >
            <span>{item.label}</span>
            {item.hint && <span className="menu-hint">{item.hint}</span>}
          </div>
        ),
      )}
    </div>
  );
}
