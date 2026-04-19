/**
 * Swiss-style pair generator for Phase 2 battle matchups.
 *
 * Invariants:
 * - Only pair players within the same "bucket" (e.g. testCaseId) so that
 *   every matchup compares outputs produced from the same input.
 * - Within a bucket, pair players with similar scores first (classic Swiss).
 * - Avoid rematches when possible.
 * - Handle odd buckets by giving one player a "bye" (no matchup) for the round.
 *
 * This is a pure function — no Convex context, no side effects. The caller
 * persists the generated pairs.
 */

export type SwissPlayer = {
  id: string;
  bucket: string;
  score: number;
};

export type SwissPair = {
  leftId: string;
  rightId: string;
  bucket: string;
};

export type PairHistory = ReadonlySet<string>;

function pairKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

/**
 * Generate the first-round pairs for a set of players. Scores are ignored
 * (all start at 0); pairs are randomized within each bucket.
 */
export function generateFirstRound(
  players: SwissPlayer[],
  rng: () => number = Math.random,
): SwissPair[] {
  const buckets = groupBy(players, (p) => p.bucket);
  const pairs: SwissPair[] = [];
  for (const [bucket, group] of buckets) {
    const shuffled = shuffleWith(group, rng);
    for (let i = 0; i + 1 < shuffled.length; i += 2) {
      pairs.push({
        leftId: shuffled[i]!.id,
        rightId: shuffled[i + 1]!.id,
        bucket,
      });
    }
    // Odd one out gets a bye this round (no pair emitted).
  }
  return pairs;
}

/**
 * Generate the next round given current standings and the set of matchups
 * that have already happened.
 */
export function generateNextRound(
  players: SwissPlayer[],
  history: PairHistory,
  rng: () => number = Math.random,
): SwissPair[] {
  const buckets = groupBy(players, (p) => p.bucket);
  const pairs: SwissPair[] = [];

  for (const [bucket, group] of buckets) {
    // Sort by score desc, random tie-break so identical scores don't always
    // pair in the same order across rounds.
    const sorted = shuffleWith(group, rng).sort((a, b) => b.score - a.score);
    const used = new Set<string>();

    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i]!;
      if (used.has(a.id)) continue;

      // Find closest-score unpaired player that hasn't faced a yet.
      let matched: SwissPlayer | undefined;
      for (let j = i + 1; j < sorted.length; j++) {
        const b = sorted[j]!;
        if (used.has(b.id)) continue;
        if (history.has(pairKey(a.id, b.id))) continue;
        matched = b;
        break;
      }
      // Fall back to any unpaired opponent if every option is a rematch.
      if (!matched) {
        for (let j = i + 1; j < sorted.length; j++) {
          const b = sorted[j]!;
          if (used.has(b.id)) continue;
          matched = b;
          break;
        }
      }
      if (!matched) continue; // a gets a bye this round
      used.add(a.id);
      used.add(matched.id);
      pairs.push({ leftId: a.id, rightId: matched.id, bucket });
    }
  }
  return pairs;
}

/**
 * Count how many additional rounds make sense for a given player set.
 * Standard Swiss: ceil(log2(N)) rounds within each bucket, max across buckets.
 */
export function suggestedRoundCount(players: SwissPlayer[]): number {
  const buckets = groupBy(players, (p) => p.bucket);
  let max = 1;
  for (const [, group] of buckets) {
    if (group.length < 2) continue;
    max = Math.max(max, Math.ceil(Math.log2(group.length)));
  }
  return max;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function groupBy<T, K>(items: T[], keyFn: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const item of items) {
    const k = keyFn(item);
    const arr = m.get(k);
    if (arr) arr.push(item);
    else m.set(k, [item]);
  }
  return m;
}

function shuffleWith<T>(arr: T[], rng: () => number): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
