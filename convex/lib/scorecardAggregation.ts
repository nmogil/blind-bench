/**
 * Pure fold from scorecard result rows -> the per-product / per-scorer rollups
 * the org scorecard view renders. Node-free and `_generated`-free so it runs in
 * the Convex runtime and in plain vitest.
 *
 * Splits failures cleanly: a hard-failed result contributes a `hardFailFindings`
 * entry (case id + product + the scorers that failed) and is excluded from
 * `softFailuresByScorer`; a soft (non-hard) failing result contributes its
 * failing scorer keys to `softFailuresByScorer`. No message/output content —
 * ids, products, scorer keys, and numbers only.
 */

export interface ScorecardResultRow {
  caseId: string;
  product: string;
  score: number;
  passed: boolean;
  hardFailed: boolean;
  failingScorers: string[];
}

export interface ProductRollup {
  product: string;
  cases: number;
  passed: number;
  hardFailed: number;
  meanScore: number;
}

export interface ScorecardFold {
  products: ProductRollup[];
  softFailuresByScorer: { scorer: string; count: number }[];
  hardFailFindings: { caseId: string; product: string; scorers: string[] }[];
  totals: {
    cases: number;
    passed: number;
    hardFailed: number;
    meanScore: number;
  };
}

const mean = (sum: number, n: number): number => (n === 0 ? 0 : sum / n);

export function foldScorecardResults(
  rows: readonly ScorecardResultRow[],
): ScorecardFold {
  const byProduct = new Map<
    string,
    { cases: number; passed: number; hardFailed: number; scoreSum: number }
  >();
  const softCounts = new Map<string, number>();
  const hardFailFindings: ScorecardFold["hardFailFindings"] = [];

  let passed = 0;
  let hardFailed = 0;
  let scoreSum = 0;

  for (const r of rows) {
    scoreSum += r.score;
    if (r.passed) passed++;
    if (r.hardFailed) hardFailed++;

    const p = byProduct.get(r.product) ?? {
      cases: 0,
      passed: 0,
      hardFailed: 0,
      scoreSum: 0,
    };
    p.cases++;
    p.scoreSum += r.score;
    if (r.passed) p.passed++;
    if (r.hardFailed) p.hardFailed++;
    byProduct.set(r.product, p);

    if (r.hardFailed) {
      hardFailFindings.push({
        caseId: r.caseId,
        product: r.product,
        scorers: [...r.failingScorers],
      });
    } else {
      for (const scorer of r.failingScorers) {
        softCounts.set(scorer, (softCounts.get(scorer) ?? 0) + 1);
      }
    }
  }

  const products: ProductRollup[] = [...byProduct.entries()]
    .map(([product, p]) => ({
      product,
      cases: p.cases,
      passed: p.passed,
      hardFailed: p.hardFailed,
      meanScore: mean(p.scoreSum, p.cases),
    }))
    .sort((a, b) => a.product.localeCompare(b.product));

  const softFailuresByScorer = [...softCounts.entries()]
    .map(([scorer, count]) => ({ scorer, count }))
    // Most frequent first; ties broken by scorer key for determinism.
    .sort((a, b) => b.count - a.count || a.scorer.localeCompare(b.scorer));

  // Stable, deterministic ordering for findings (product, then case id).
  hardFailFindings.sort(
    (a, b) =>
      a.product.localeCompare(b.product) || a.caseId.localeCompare(b.caseId),
  );

  return {
    products,
    softFailuresByScorer,
    hardFailFindings,
    totals: {
      cases: rows.length,
      passed,
      hardFailed,
      meanScore: mean(scoreSum, rows.length),
    },
  };
}
