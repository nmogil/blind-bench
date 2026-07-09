import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  CUSTOMER_TESTING_GATE_DEFINITIONS,
  buildCustomerTestingReadinessReport,
  formatCustomerTestingReadinessJson,
  formatCustomerTestingReadinessMarkdown,
  readApprovalsFile,
  writeCustomerTestingReadinessReport,
  type CustomerTestingApprovals,
} from "./customerTestingReadiness";

function allApprovals(): CustomerTestingApprovals {
  return Object.fromEntries(CUSTOMER_TESTING_GATE_DEFINITIONS.map((gate) => [gate.key, true]));
}

describe("customer testing readiness", () => {
  test("defaults to blocked without a local approvals file", () => {
    const report = buildCustomerTestingReadinessReport({ repoRoot: process.cwd() });
    expect(report.status).toBe("blocked_until_approved");
    expect(report.counts.docs_present).toBe(report.counts.required_docs);
    expect(report.counts.gates_approved).toBe(0);
    expect(report.caveats).toContain("no_local_approvals_file_supplied");
  });

  test("passes when required docs exist and every gate is approved", () => {
    const report = buildCustomerTestingReadinessReport({ repoRoot: process.cwd(), approvals: allApprovals() });
    expect(report.status).toBe("ready_for_customer_testing");
    expect(report.counts.gates_approved).toBe(report.counts.required_gates);
    expect(report.caveats).not.toContain("explicit_approvals_missing_or_incomplete");
  });

  test("blocks incomplete approval files", () => {
    const approvals = allApprovals();
    approvals.reviewer_scope_approved = false;
    const report = buildCustomerTestingReadinessReport({ repoRoot: process.cwd(), approvals });
    expect(report.status).toBe("blocked_until_approved");
    expect(report.caveats).toContain("explicit_approvals_missing_or_incomplete");
  });

  test("reads only boolean gates and does not leak raw approval notes", () => {
    const dir = mkdtempSync(join(tmpdir(), "customer-testing-readiness-"));
    const approvalPath = join(dir, "approvals.json");
    const rawNote = "RAW APPROVAL NOTE SHOULD NOT PRINT";
    writeFileSync(approvalPath, JSON.stringify({ ...allApprovals(), notes: rawNote }, null, 2));
    const report = buildCustomerTestingReadinessReport({
      repoRoot: process.cwd(),
      approvals: readApprovalsFile(approvalPath),
      outDir: dir,
    });
    writeCustomerTestingReadinessReport(report);
    const text = formatCustomerTestingReadinessMarkdown(report) + formatCustomerTestingReadinessJson(report);
    expect(text).not.toContain(rawNote);
    expect(readFileSync(report.artifact_paths.markdown, "utf8")).toContain("Customer-testing readiness");
    expect(JSON.parse(readFileSync(report.artifact_paths.json, "utf8")).status).toBe("ready_for_customer_testing");
  });
});
