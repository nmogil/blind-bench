import { describe, expect, it } from "vitest";
import {
  buildCanonicalDemoReadinessReport,
  formatCanonicalDemoReadinessMarkdown,
  type ReadinessCheck,
} from "./canonicalReadiness";

const passCheck: ReadinessCheck = {
  id: "scorecard_demo",
  label: "Scorecard demo",
  status: "pass",
  artifacts: ["artifacts/scorecard.json"],
  summary: { cases_evaluated: 50, hard_failed_cases: 1 },
};

describe("canonical demo readiness report", () => {
  it("passes when every check passes and deduplicates artifact paths", () => {
    const report = buildCanonicalDemoReadinessReport({
      generated_at: "2026-01-01T00:00:00Z",
      checks: [
        passCheck,
        { ...passCheck, id: "dataset", label: "Dataset", artifacts: ["artifacts/scorecard.json", "artifacts/train.jsonl"] },
      ],
    });

    expect(report.status).toBe("pass");
    expect(report.artifact_paths).toEqual([
      "artifacts/scorecard.json",
      "artifacts/train.jsonl",
    ]);
    expect(report.guardrails.join("\n")).toContain("no live Cloudflare");
  });

  it("fails when any check fails and keeps management-safe error text", () => {
    const report = buildCanonicalDemoReadinessReport({
      generated_at: "2026-01-01T00:00:00Z",
      checks: [
        passCheck,
        {
          id: "training_dataset_demo",
          label: "Training dataset",
          status: "fail",
          artifacts: ["artifacts/training-dataset.manifest.json"],
          summary: { train_rows: 0 },
          errors: ["Missing artifact: artifacts/training-dataset.manifest.json"],
        },
      ],
    });

    expect(report.status).toBe("fail");
    const md = formatCanonicalDemoReadinessMarkdown(report);
    expect(md).toContain("❌ Training dataset");
    expect(md).toContain("Missing artifact");
    expect(md).not.toMatch(/password|api[_ -]?key|Bearer/i);
  });

  it("formats the canonical loop and operator steps without raw transcript fields", () => {
    const report = buildCanonicalDemoReadinessReport({
      generated_at: "2026-01-01T00:00:00Z",
      checks: [passCheck],
    });

    const md = formatCanonicalDemoReadinessMarkdown(report);
    expect(md).toContain("## Canonical loop");
    expect(md).toContain("## Next operator steps");
    expect(md).not.toMatch(/TEST-ACCOUNT|555-01|sk-[A-Za-z0-9]/i);
  });
});
