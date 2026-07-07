import { describe, expect, it } from "vitest";
import {
  foldScorecardResults,
  type ScorecardResultRow,
} from "./scorecardAggregation";

// Pure fold tests — no `_generated`, no convex runtime.

const rows: ScorecardResultRow[] = [
  {
    caseId: "c1",
    product: "support",
    score: 1,
    passed: true,
    hardFailed: false,
    failingScorers: [],
  },
  {
    caseId: "c2",
    product: "support",
    score: 0.5,
    passed: false,
    hardFailed: false,
    failingScorers: ["tone_customer_fit"],
  },
  {
    caseId: "c3",
    product: "voice",
    score: 0,
    passed: false,
    hardFailed: true,
    failingScorers: ["no_hallucinated_data", "tone_customer_fit"],
  },
  {
    caseId: "c4",
    product: "voice",
    score: 0.5,
    passed: false,
    hardFailed: false,
    failingScorers: ["tone_customer_fit"],
  },
];

describe("foldScorecardResults", () => {
  it("rolls up per-product cases/passed/hardFailed/meanScore", () => {
    const { products } = foldScorecardResults(rows);
    expect(products).toEqual([
      { product: "support", cases: 2, passed: 1, hardFailed: 0, meanScore: 0.75 },
      { product: "voice", cases: 2, passed: 0, hardFailed: 1, meanScore: 0.25 },
    ]);
  });

  it("counts soft failures by scorer, excluding hard-failed results", () => {
    const { softFailuresByScorer } = foldScorecardResults(rows);
    // c3 is hard-failed so its tone failure is NOT counted here; only c2 + c4.
    expect(softFailuresByScorer).toEqual([
      { scorer: "tone_customer_fit", count: 2 },
    ]);
  });

  it("lists hard-fail findings with case id, product, and scorers", () => {
    const { hardFailFindings } = foldScorecardResults(rows);
    expect(hardFailFindings).toEqual([
      {
        caseId: "c3",
        product: "voice",
        scorers: ["no_hallucinated_data", "tone_customer_fit"],
      },
    ]);
  });

  it("computes totals matching the summary shape", () => {
    const { totals } = foldScorecardResults(rows);
    expect(totals).toEqual({
      cases: 4,
      passed: 1,
      hardFailed: 1,
      meanScore: 0.5,
    });
  });

  it("sorts soft failures by count desc then scorer key", () => {
    const many: ScorecardResultRow[] = [
      { caseId: "a", product: "p", score: 0, passed: false, hardFailed: false, failingScorers: ["b_scorer"] },
      { caseId: "b", product: "p", score: 0, passed: false, hardFailed: false, failingScorers: ["a_scorer", "z_scorer"] },
      { caseId: "c", product: "p", score: 0, passed: false, hardFailed: false, failingScorers: ["z_scorer"] },
    ];
    const { softFailuresByScorer } = foldScorecardResults(many);
    expect(softFailuresByScorer).toEqual([
      { scorer: "z_scorer", count: 2 },
      { scorer: "a_scorer", count: 1 },
      { scorer: "b_scorer", count: 1 },
    ]);
  });

  it("returns empty rollups for no results", () => {
    expect(foldScorecardResults([])).toEqual({
      products: [],
      softFailuresByScorer: [],
      hardFailFindings: [],
      totals: { cases: 0, passed: 0, hardFailed: 0, meanScore: 0 },
    });
  });
});
