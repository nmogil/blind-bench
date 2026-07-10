import { describe, expect, test } from "vitest";

import { parsePairedComparisonCsv } from "./pairedComparisonCsv";

const csv = [
  "case_id,context,candidate_a,candidate_b,candidate_a_model,candidate_b_model,segment,privacy_class",
  'sms-1,"Customer: Can I move my appointment?","Absolutely — what day works?","Sure. Pick another date.",gpt-4o,luna,scheduling,internal',
  'sms-2,"Customer: Stop texting me","I’ll opt you out now.","Okay, goodbye.",gpt-4o,luna,opt-out,confidential',
].join("\n");

describe("paired comparison CSV", () => {
  test("normalizes each row into two traces with an identical context prefix", () => {
    const batch = parsePairedComparisonCsv(csv);

    expect(batch.summary).toEqual({
      rows: 2,
      valid: 2,
      invalid: 0,
      missingContext: 0,
      missingCandidateA: 0,
      missingCandidateB: 0,
      invalidRows: [],
      segments: ["opt-out", "scheduling"],
    });
    expect(batch.cases).toHaveLength(2);

    const first = batch.cases[0];
    expect(first?.caseKey).toBe("sms-1");
    expect(first?.segment).toBe("scheduling");
    expect(first?.candidateA.model).toBe("gpt-4o");
    expect(first?.candidateB.model).toBe("luna");
    expect(first?.candidateA.privacy.class).toBe("internal");
    expect(first?.candidateA.steps[0]).toEqual(first?.candidateB.steps[0]);
    expect(first?.candidateA.final_answer).toBe("Absolutely — what day works?");
    expect(first?.candidateB.final_answer).toBe("Sure. Pick another date.");
    expect(first?.candidateA.trace_id).not.toBe(first?.candidateB.trace_id);

    expect(JSON.stringify(batch.summary)).not.toContain("move my appointment");
    expect(JSON.stringify(batch.summary)).not.toContain("opt you out");
  });

  test("reports incomplete rows without echoing content", () => {
    const result = parsePairedComparisonCsv([
      "case_id,context,candidate_a,candidate_b",
      "missing-context,,left,right",
      "missing-a,context,,right",
      "missing-b,context,left,",
      "valid,context,left,right",
    ].join("\n"));

    expect(result.summary).toMatchObject({
      rows: 4,
      valid: 1,
      invalid: 3,
      missingContext: 1,
      missingCandidateA: 1,
      missingCandidateB: 1,
      invalidRows: [2, 3, 4],
    });
    expect(result.cases).toHaveLength(1);
  });

  test("rejects duplicate case ids, unknown privacy classes, and missing headers", () => {
    expect(() => parsePairedComparisonCsv([
      "case_id,context,candidate_a,candidate_b",
      "same,context,left,right",
      "same,context,left,right",
    ].join("\n"))).toThrow(/case_id.*unique/i);

    const invalidPrivacy = parsePairedComparisonCsv([
      "case_id,context,candidate_a,candidate_b,privacy_class",
      "row,context,left,right,secret",
    ].join("\n"));
    expect(invalidPrivacy.summary).toMatchObject({ valid: 0, invalid: 1, invalidRows: [2] });

    expect(() => parsePairedComparisonCsv("case_id,context,candidate_a\nrow,context,left"))
      .toThrow(/candidate_b/i);
  });
});
