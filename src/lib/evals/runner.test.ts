import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareSummaries,
  formatJson,
  formatMarkdown,
  runPack,
} from "./runner";
import { demoSmokeFixturesAllPass } from "./packs/demoPack";

const tmp = () => mkdtempSync(join(tmpdir(), "bb-eval-"));

describe("runPack", () => {
  it("default demo/smoke pack hard-fails on the planted leakage fixture", async () => {
    const s = await runPack("demo/smoke");
    expect(s.total).toBe(50);
    expect(s.hard_failed).toBe(1);
    expect(s.passed).toBe(49);
    expect(s.results.find((r) => r.case_id === "demo-support-balance-00")?.hard_failed).toBe(true);
  });

  it("all-pass fixture set clears every case with no hard-fails", async () => {
    const s = await runPack("demo/smoke", demoSmokeFixturesAllPass);
    expect(s.passed).toBe(50);
    expect(s.hard_failed).toBe(0);
  });

  it("reports cases with no fixture instead of crashing", async () => {
    const s = await runPack("demo/smoke", { "demo-docs-renewal-00": demoSmokeFixturesAllPass["demo-docs-renewal-00"]! });
    expect(s.total).toBe(1);
    expect(s.missing_fixtures.length).toBe(49);
  });
});

describe("JSON + Markdown output", () => {
  it("writes both summaries to temp files", async () => {
    const dir = tmp();
    const s = await runPack("demo/smoke");
    const jsonPath = join(dir, "report.json");
    const mdPath = join(dir, "report.md");
    writeFileSync(jsonPath, formatJson(s));
    writeFileSync(mdPath, formatMarkdown(s));

    const parsed = JSON.parse(readFileSync(jsonPath, "utf8"));
    expect(parsed.total).toBe(50);
    expect(parsed.hard_failed).toBe(1);

    const md = readFileSync(mdPath, "utf8");
    expect(md).toContain("Blind Bench eval summary");
    expect(md).toContain("🛑 hard-fail");
  });
});

describe("baseline vs candidate comparison", () => {
  it("flags the planted hard-fail as a regression vs the all-pass baseline", async () => {
    const baseline = await runPack("demo/smoke", demoSmokeFixturesAllPass);
    const candidate = await runPack("demo/smoke");
    const cmp = compareSummaries(baseline, candidate);
    expect(cmp.regressions).toContain("demo-support-balance-00");
    expect(cmp.fixes).toEqual([]);
  });
});
