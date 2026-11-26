// Small fuzzy matcher for quick open and the command palette.
// Scores consecutive matches, word starts and matches in the file name higher.

export interface FuzzyResult {
  score: number;
  /** Indexes in the target string that matched, for highlighting. */
  positions: number[];
}

export function fuzzyMatch(query: string, target: string): FuzzyResult | null {
  if (!query) return { score: 0, positions: [] };
  const q = query.toLowerCase().replace(/\s+/g, "");
  const t = target.toLowerCase();
  const positions: number[] = [];
  let score = 0;
  let ti = 0;
  let prev = -2;
  const nameStart = Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\")) + 1;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    let s = 1;
    if (found === prev + 1) s += 5;
    const before = target[found - 1];
    if (found === 0 || "/\\._- ".includes(before ?? "") || (before && /[a-z]/.test(before) && /[A-Z]/.test(target[found]))) s += 4;
    if (found >= nameStart) s += 2;
    score += s;
    positions.push(found);
    prev = found;
    ti = found + 1;
  }
  score -= target.length * 0.01;
  return { score, positions };
}

export function fuzzyFilter<T>(items: T[], query: string, key: (t: T) => string, limit = 100) {
  const out: { item: T; result: FuzzyResult }[] = [];
  for (const item of items) {
    const result = fuzzyMatch(query, key(item));
    if (result) out.push({ item, result });
  }
  out.sort((a, b) => b.result.score - a.result.score);
  return out.slice(0, limit);
}
