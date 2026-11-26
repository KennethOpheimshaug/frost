// Context menus and one-line input prompts that any module can open.
import { create } from "zustand";
import type { MenuItem } from "../components/ContextMenu";

interface InputRequest {
  title: string;
  value: string;
  placeholder?: string;
  resolve: (v: string | null) => void;
}

interface OverlayState {
  menu: { x: number; y: number; items: MenuItem[] } | null;
  input: InputRequest | null;
}

export const useOverlay = create<OverlayState>(() => ({ menu: null, input: null }));

export const showMenu = (x: number, y: number, items: MenuItem[]) => useOverlay.setState({ menu: { x, y, items } });
export const closeMenu = () => useOverlay.setState({ menu: null });

/** Asks for a line of text. Resolves null when cancelled. */
export function promptInput(title: string, value = "", placeholder?: string): Promise<string | null> {
  return new Promise((resolve) => {
    useOverlay.getState().input?.resolve(null);
    useOverlay.setState({ input: { title, value, placeholder, resolve } });
  });
}
