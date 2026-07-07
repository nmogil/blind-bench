import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AgentOutput,
  EvalCase,
  EvalResult,
  ScorerResult,
  aggregateScores,
  evalCaseJsonSchema,
  evalResultJsonSchema,
  type ScorerResult as ScorerResultT,
} from "./evalCase";
import { exampleCases } from "./examples";

const schemaPath = (name: string) =>
  fileURLToPath(new URL(`../../../schemas/${name}`, import.meta.url));

const result = (over: Partial<ScorerResultT>): ScorerResultT =>
  ScorerResult.parse({
    scorer: "s",
    kind: "deterministic",
    score: 1,
    passed: true,
    reason: "ok",
    ...over,
  });

describe("eval case schema", () => {
  it("accepts the synthetic doc-summarizer and support-assistant examples", () => {
    const products = exampleCases.map((c) => EvalCase.parse(c).product).sort();
    expect(products).toEqual(["doc-summarizer", "support-assistant"]);
  });

  it("examples are synthetic and use obviously fake TEST fixture identifiers", () => {
    for (const c of exampleCases) {
      expect(c.source).toBe("synthetic");
      const blob = JSON.stringify(c.input);
      expect(blob).toMatch(/TEST/); // fake identifiers are tagged TEST
    }
  });

  it("rejects a case missing required expected fields", () => {
    const bad = { ...exampleCases[0], expected: { must: ["x"] } };
    expect(EvalCase.safeParse(bad).success).toBe(false); // privacy_class required
  });

  it("applies defaults for omitted optional arrays", () => {
    const parsed = EvalCase.parse({
      id: "x",
      product: "p",
      title: "t",
      source: "synthetic",
      input: {},
      expected: { privacy_class: "public" },
    });
    expect(parsed.expected.must).toEqual([]);
    expect(parsed.expected.must_not).toEqual([]);
    expect(parsed.expected.expected_escalation).toBeNull();
    expect(parsed.tags).toEqual([]);
  });
});

describe("scorer contract", () => {
  it("validates a full scorer result with evidence spans", () => {
    const r = ScorerResult.parse({
      scorer: "must_not_disclose",
      kind: "llm_judge",
      score: 0,
      passed: false,
      reason: "Disclosed another borrower's balance.",
      evidence: [{ source: "output.text", snippet: "their balance is $900" }],
      hard_fail: true,
    });
    expect(r.hard_fail).toBe(true);
    expect(r.evidence[0]?.source).toBe("output.text");
  });

  it("rejects out-of-range scores", () => {
    expect(
      ScorerResult.safeParse({
        scorer: "s",
        kind: "deterministic",
        score: 1.5,
        passed: true,
        reason: "ok",
      }).success,
    ).toBe(false);
  });

  it("AgentOutput defaults tool_calls to empty", () => {
    expect(AgentOutput.parse({ text: "hi" }).tool_calls).toEqual([]);
  });
});

describe("aggregateScores (hard-fail semantics)", () => {
  it("passes only when every scorer passes", () => {
    expect(aggregateScores([result({}), result({})]).passed).toBe(true);
    expect(
      aggregateScores([result({}), result({ passed: false, score: 0 })]).passed,
    ).toBe(false);
  });

  it("hard-fail forces the case to fail and is reported", () => {
    const agg = aggregateScores([
      result({ score: 1, passed: true }),
      result({ score: 0, passed: false, hard_fail: true }),
    ]);
    expect(agg.hard_failed).toBe(true);
    expect(agg.passed).toBe(false);
  });

  it("empty scores never passes", () => {
    expect(aggregateScores([])).toEqual({ score: 0, passed: false, hard_failed: false });
  });

  it("score is the mean of scorer scores", () => {
    expect(aggregateScores([result({ score: 1 }), result({ score: 0 })]).score).toBe(0.5);
  });

  it("produces a portable EvalResult row", () => {
    const scores = [result({ score: 1 }), result({ score: 0.5 })];
    const row = EvalResult.parse({
      case_id: exampleCases[0]!.id,
      output: { text: "Your renewal quote is $4,210.00.", escalated: true },
      scores,
      ...aggregateScores(scores),
      timestamp: "2026-06-23T00:00:00Z",
    });
    expect(row.score).toBe(0.75);
  });
});

describe("JSON Schema export", () => {
  it("exports JSON-Schema-shaped objects", () => {
    for (const s of [evalCaseJsonSchema, evalResultJsonSchema]) {
      expect((s as { type?: string }).type).toBe("object");
      expect((s as { properties?: object }).properties).toBeDefined();
    }
  });

  it("checked-in artifacts match the zod source (run npx tsx schemas/generate.ts to refresh)", () => {
    const onDisk = (name: string) =>
      JSON.parse(readFileSync(schemaPath(name), "utf8"));
    expect(onDisk("eval-case.schema.json")).toEqual(evalCaseJsonSchema);
    expect(onDisk("eval-result.schema.json")).toEqual(evalResultJsonSchema);
  });
});
