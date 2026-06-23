import { describe, expect, it } from "vitest";
import { EvalCase } from "../evalCase";
import { customerPilotSmokeCases, customerPilotSmokeFixtures } from "./customerPilot";

describe("customer-pilot smoke pack", () => {
  it("has 50 cases: 25 eavesly + 25 migo", () => {
    expect(customerPilotSmokeCases).toHaveLength(50);
    const byProduct = customerPilotSmokeCases.reduce<Record<string, number>>((m, c) => {
      m[c.product] = (m[c.product] ?? 0) + 1;
      return m;
    }, {});
    expect(byProduct).toEqual({ eavesly: 25, migo: 25 });
  });

  it("every case validates as EvalCase", () => {
    for (const c of customerPilotSmokeCases) {
      expect(() => EvalCase.parse(c)).not.toThrow();
    }
  });

  it("case ids are unique and every case has a fixture", () => {
    const ids = customerPilotSmokeCases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(customerPilotSmokeFixtures[id]).toBeDefined();
  });

  it("every case is synthetic and assigns scorers", () => {
    for (const raw of customerPilotSmokeCases) {
      const c = EvalCase.parse(raw);
      expect(c.source).toBe("synthetic");
      expect(c.metadata?.customer_scope).toBe("customer-pilot");
      expect(c.metadata?.synthetic).toBe(true);
      expect(c.scorer_assignments.length).toBeGreaterThan(0);
    }
  });

  // Data-boundary guard: scan the FULL serialized pack (cases + fixtures) so no
  // real-looking identifier slips in. Synthetic ids must be tagged TEST/SYNTHETIC.
  it("contains only synthetic TEST identifiers — no real-looking PII", () => {
    const blob = JSON.stringify({ customerPilotSmokeCases, customerPilotSmokeFixtures });

    // Every account/customer id must carry the TEST sentinel.
    for (const id of blob.match(/\b(?:ACCT|CUST)-[A-Z0-9-]+/g) ?? []) {
      expect(id, `${id} must be a TEST fixture id`).toMatch(/TEST/);
    }

    // No real SSNs (forbidden-data sentinels for scanners are the only digit runs
    // that look like one, and they live in scorer config, never in agent output).
    const ssnInOutputs = JSON.stringify(customerPilotSmokeFixtures).match(/\b\d{3}-\d{2}-\d{4}\b/g);
    expect(ssnInOutputs).toBeNull();
  });
});
