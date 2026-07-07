import { describe, expect, it } from "vitest";
import { EvalCase } from "../evalCase";
import { demoSmokeCases, demoSmokeFixtures } from "./demoPack";

describe("demo smoke pack", () => {
  it("has 50 cases: 25 doc-summarizer + 25 support-assistant", () => {
    expect(demoSmokeCases).toHaveLength(50);
    const byProduct = demoSmokeCases.reduce<Record<string, number>>((m, c) => {
      m[c.product] = (m[c.product] ?? 0) + 1;
      return m;
    }, {});
    expect(byProduct).toEqual({ "doc-summarizer": 25, "support-assistant": 25 });
  });

  it("every case validates as EvalCase", () => {
    for (const c of demoSmokeCases) {
      expect(() => EvalCase.parse(c)).not.toThrow();
    }
  });

  it("case ids are unique and every case has a fixture", () => {
    const ids = demoSmokeCases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(demoSmokeFixtures[id]).toBeDefined();
  });

  it("every case is synthetic and assigns scorers", () => {
    for (const raw of demoSmokeCases) {
      const c = EvalCase.parse(raw);
      expect(c.source).toBe("synthetic");
      expect(c.metadata?.customer_scope).toBe("demo");
      expect(c.metadata?.synthetic).toBe(true);
      expect(c.scorer_assignments.length).toBeGreaterThan(0);
    }
  });

  // Data-boundary guard: scan the FULL serialized pack (cases + fixtures) so no
  // real-looking identifier slips in. Synthetic ids must be tagged TEST/SYNTHETIC.
  it("contains only synthetic TEST identifiers — no real-looking PII", () => {
    const blob = JSON.stringify({ demoSmokeCases, demoSmokeFixtures });

    // Every account/customer id must carry the TEST sentinel.
    for (const id of blob.match(/\b(?:ACCT|CUST)-[A-Z0-9-]+/g) ?? []) {
      expect(id, `${id} must be a TEST fixture id`).toMatch(/TEST/);
    }

    // No real SSNs (forbidden-data sentinels for scanners are the only digit runs
    // that look like one, and they live in scorer config, never in agent output).
    const ssnInOutputs = JSON.stringify(demoSmokeFixtures).match(/\b\d{3}-\d{2}-\d{4}\b/g);
    expect(ssnInOutputs).toBeNull();
  });
});
