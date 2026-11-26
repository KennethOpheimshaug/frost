// Output channels (Build, C# language server) shown in the bottom panel.
import { create } from "zustand";

export type Channel = "Build" | "C#" | "Frost";
const MAX_LINES = 5000;

interface OutputState {
  lines: Record<Channel, string[]>;
  append(channel: Channel, ...lines: string[]): void;
  clear(channel: Channel): void;
}

export const useOutput = create<OutputState>((set) => ({
  lines: { Build: [], "C#": [], Frost: [] },
  append: (channel, ...lines) =>
    set((s) => {
      const next = [...s.lines[channel], ...lines];
      return { lines: { ...s.lines, [channel]: next.length > MAX_LINES ? next.slice(-MAX_LINES) : next } };
    }),
  clear: (channel) => set((s) => ({ lines: { ...s.lines, [channel]: [] } })),
}));
