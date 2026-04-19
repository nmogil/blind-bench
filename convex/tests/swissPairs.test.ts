import { describe, expect, it } from "vitest";
import {
  generateFirstRound,
  generateNextRound,
  suggestedRoundCount,
  type SwissPlayer,
} from "../lib/swissPairs";

function deterministicRng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function players(ids: string[], bucket = "t1", scores: number[] = []): SwissPlayer[] {
  return ids.map((id, i) => ({ id, bucket, score: scores[i] ?? 0 }));
}

describe("swissPairs", () => {
  it("first round pairs every player in an even bucket", () => {
    const pairs = generateFirstRound(players(["a", "b", "c", "d"]), deterministicRng(1));
    expect(pairs.length).toBe(2);
    const used = new Set(pairs.flatMap((p) => [p.leftId, p.rightId]));
    expect(used.size).toBe(4);
  });

  it("first round leaves one player with a bye in an odd bucket", () => {
    const pairs = generateFirstRound(players(["a", "b", "c"]), deterministicRng(1));
    expect(pairs.length).toBe(1);
  });

  it("never pairs across buckets", () => {
    const roster: SwissPlayer[] = [
      ...players(["a", "b"], "t1"),
      ...players(["c", "d"], "t2"),
    ];
    const pairs = generateFirstRound(roster, deterministicRng(1));
    for (const p of pairs) {
      const left = roster.find((r) => r.id === p.leftId)!;
      const right = roster.find((r) => r.id === p.rightId)!;
      expect(left.bucket).toBe(right.bucket);
    }
  });

  it("next round avoids rematches when possible", () => {
    const round1 = generateFirstRound(
      players(["a", "b", "c", "d"]),
      deterministicRng(1),
    );
    const history = new Set(
      round1.map((p) =>
        p.leftId < p.rightId
          ? `${p.leftId}::${p.rightId}`
          : `${p.rightId}::${p.leftId}`,
      ),
    );
    const round2 = generateNextRound(
      players(["a", "b", "c", "d"], "t1", [1, 0, 1, 0]),
      history,
      deterministicRng(2),
    );
    for (const p of round2) {
      const key =
        p.leftId < p.rightId
          ? `${p.leftId}::${p.rightId}`
          : `${p.rightId}::${p.leftId}`;
      expect(history.has(key)).toBe(false);
    }
  });

  it("suggestedRoundCount returns ceil(log2) of largest bucket", () => {
    const roster = [
      ...players(["a", "b", "c", "d"], "t1"),
      ...players(["e", "f"], "t2"),
    ];
    expect(suggestedRoundCount(roster)).toBe(2);
  });

  it("handles single-player bucket gracefully", () => {
    const pairs = generateFirstRound(players(["a"], "t1"), deterministicRng(1));
    expect(pairs.length).toBe(0);
  });
});
