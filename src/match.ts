/**
 * Exercise-name matching used to prioritise existing exercises over creating
 * new custom ones. Pure functions, no I/O, so they're easy to unit-test.
 */

export interface CatalogEntry {
  exercise_template_id: string;
  title: string;
  muscle_group?: string;
  equipment_category?: string;
  is_custom?: boolean;
}

/** Lowercase, drop punctuation, collapse whitespace. */
export function normalizeExerciseName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[()[\]{}]/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(s: string): Set<string> {
  // Treat a handful of synonyms as equivalent so "barbell bench press" matches
  // "Bench Press (Barbell)" etc.
  const synonyms: Record<string, string> = { bb: "barbell", db: "dumbbell", ohp: "overhead" };
  return new Set(
    normalizeExerciseName(s)
      .split(" ")
      .filter(Boolean)
      .map((t) => synonyms[t] ?? t),
  );
}

export interface MatchResult {
  entry: CatalogEntry;
  score: number;
  /** true when every token of the query is present in the candidate. */
  querySubset: boolean;
}

/**
 * Find the best catalog match for a requested exercise name. Scores by Jaccard
 * overlap of token sets, boosted when one name's tokens fully contain the
 * other's. Returns null when nothing clears `threshold`.
 */
export function findBestMatch(
  name: string,
  catalog: CatalogEntry[],
  threshold = 0.5,
): MatchResult | null {
  const q = tokenSet(name);
  if (q.size === 0) return null;

  let best: MatchResult | null = null;
  for (const entry of catalog) {
    const c = tokenSet(entry.title);
    if (c.size === 0) continue;

    let inter = 0;
    for (const t of q) if (c.has(t)) inter++;
    const union = q.size + c.size - inter;
    let score = inter / union;

    const querySubset = inter === q.size;
    const candidateSubset = inter === c.size;
    // A full containment is a strong signal even if the other name adds words.
    if (querySubset || candidateSubset) score = Math.max(score, 0.75 + 0.25 * score);

    if (score >= threshold && (!best || score > best.score ||
        // tie-break: prefer the more generic (shorter) title
        (score === best.score && c.size < tokenSet(best.entry.title).size))) {
      best = { entry, score, querySubset };
    }
  }
  return best;
}
