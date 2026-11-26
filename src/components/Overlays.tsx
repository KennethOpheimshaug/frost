import { useEffect, useRef } from "react";
import { closeMenu, useOverlay } from "../lib/overlay";
import { ContextMenu } from "./ContextMenu";

/** Shared context menu and input prompt (opened through lib/overlay). */
export function Overlays() {
  const { menu, input } = useOverlay();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input) requestAnimationFrame(() => ref.current?.select());
  }, [input]);
  const done = (v: string | null) => {
    input?.resolve(v);
    useOverlay.setState({ input: null });
  };
  return (
    <>
      {menu && <ContextMenu {...menu} onClose={closeMenu} />}
      {input && (
        <div className="palette-backdrop" onMouseDown={() => done(null)}>
          <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
            <div className="input-title">{input.title}</div>
            <input
              ref={ref}
              className="palette-input"
              defaultValue={input.value}
              placeholder={input.placeholder}
              spellCheck={false}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") done(e.currentTarget.value);
                if (e.key === "Escape") done(null);
              }}
            />
            <div className="input-hint">Press Enter to confirm or Escape to cancel</div>
          </div>
        </div>
      )}
    </>
  );
}
