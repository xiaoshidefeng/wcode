// Zero-dependency fuzzy matching for the command palette and pickers
// (opencode uses fuzzysort; this is the minimal subsequence variant).

/**
 * Score how well `query` fuzzy-matches `target` (case-insensitive subsequence).
 * Returns null when not all query chars match in order; higher is better.
 * Bonuses: consecutive chars, prefix position, word boundaries.
 */
export function fuzzyScore(query: string, target: string): number | null {
  if (query === "") return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let score = 0;
  let searchFrom = 0;
  let prev = -2;
  for (const ch of q) {
    const idx = t.indexOf(ch, searchFrom);
    if (idx === -1) return null;
    score += 1;
    if (idx === prev + 1) score += 2; // consecutive run
    if (idx === 0) score += 2; // exact prefix
    else if (t[idx - 1] === " " || t[idx - 1] === "/" || t[idx - 1] === "_") score += 1; // word start
    prev = idx;
    searchFrom = idx + 1;
  }
  // Shorter targets rank higher on equal matches.
  return score + Math.max(0, 8 - Math.floor(t.length / 8));
}

/** Filter + rank items by their searchable text; unmatched items drop out. */
export function fuzzyFilter<T>(items: T[], query: string, text: (item: T) => string): T[] {
  if (query.trim() === "") return items;
  const q = query.trim();
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const score = fuzzyScore(q, text(item));
    if (score !== null) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}
