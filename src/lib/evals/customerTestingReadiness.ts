import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type CustomerTestingReadinessStatus = "ready_for_customer_testing" | "blocked_until_approved";

export interface ApprovalGate {
  key: string;
  label: string;
  required: boolean;
  approved: boolean;
}

export interface RequiredDocumentCheck {
  path: string;
  present: boolean;
}

export interface CustomerTestingApprovals {
  customer_data_boundary_identified?: boolean;
  operator_owns_or_exports_logs?: boolean;
  reviewer_scope_approved?: boolean;
  retention_deletion_policy_accepted?: boolean;
  redaction_classification_path_accepted?: boolean;
  training_use_explicitly_approved_or_blocked?: boolean;
  shared_demos_marketing_reuse_blocked?: boolean;
  credential_handling_confirmed?: boolean;
  local_preflight_before_live_import?: boolean;
}

export interface CustomerTestingReadinessReport {
  generated_at: string;
  status: CustomerTestingReadinessStatus;
  required_docs: RequiredDocumentCheck[];
  gates: ApprovalGate[];
  counts: {
    required_docs: number;
    docs_present: number;
    required_gates: number;
    gates_approved: number;
  };
  caveats: string[];
  artifact_paths: {
    markdown: string;
    json: string;
  };
}

export const REQUIRED_CUSTOMER_TESTING_DOCS = [
  "docs/tenancy-consent-data-isolation.md",
  "docs/cloudflare-gateway-live-import.md",
  "docs/native-ingest.md",
  "docs/training-dataset-compiler.md",
  "docs/customer-pilot-sow.md",
] as const;

export const CUSTOMER_TESTING_GATE_DEFINITIONS: Array<{ key: keyof CustomerTestingApprovals; label: string }> = [
  { key: "customer_data_boundary_identified", label: "Customer/legal data boundary identified" },
  { key: "operator_owns_or_exports_logs", label: "Operator owns or exports the logs" },
  { key: "reviewer_scope_approved", label: "Reviewer scope approved" },
  { key: "retention_deletion_policy_accepted", label: "Retention/deletion policy accepted" },
  { key: "redaction_classification_path_accepted", label: "Redaction/classification path accepted" },
  { key: "training_use_explicitly_approved_or_blocked", label: "Training/fine-tuning use explicitly approved or blocked" },
  { key: "shared_demos_marketing_reuse_blocked", label: "Shared demos/marketing/reusable datasets blocked unless separately approved" },
  { key: "credential_handling_confirmed", label: "Credential handling path confirmed" },
  { key: "local_preflight_before_live_import", label: "Local preflight required before live import" },
];

export function readApprovalsFile(path: string): CustomerTestingApprovals {
  const text = readFileSync(path, "utf8");
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const approvals: CustomerTestingApprovals = {};
  for (const { key } of CUSTOMER_TESTING_GATE_DEFINITIONS) {
    approvals[key] = parsed[key] === true;
  }
  return approvals;
}

export function buildCustomerTestingReadinessReport(options: {
  repoRoot?: string;
  approvals?: CustomerTestingApprovals;
  outDir?: string;
  generatedAt?: string;
} = {}): CustomerTestingReadinessReport {
  const repoRoot = options.repoRoot ?? process.cwd();
  const outDir = options.outDir ?? join("artifacts", "customer-testing-readiness");
  const requiredDocs = REQUIRED_CUSTOMER_TESTING_DOCS.map((path) => ({
    path,
    present: existsSync(join(repoRoot, path)),
  }));
  const gates = CUSTOMER_TESTING_GATE_DEFINITIONS.map(({ key, label }) => ({
    key,
    label,
    required: true,
    approved: options.approvals?.[key] === true,
  }));
  const docsPresent = requiredDocs.filter((doc) => doc.present).length;
  const gatesApproved = gates.filter((gate) => gate.approved).length;
  const caveats: string[] = [];
  if (docsPresent !== requiredDocs.length) caveats.push("required_docs_missing");
  if (gatesApproved !== gates.length) caveats.push("explicit_approvals_missing_or_incomplete");
  if (options.approvals === undefined) caveats.push("no_local_approvals_file_supplied");
  caveats.push("do_not_import_customer_or_operator_logs_until_status_is_ready");
  caveats.push("ready_status_is_not_evidence_of_customer_consent");

  const status: CustomerTestingReadinessStatus =
    docsPresent === requiredDocs.length && gatesApproved === gates.length
      ? "ready_for_customer_testing"
      : "blocked_until_approved";

  return {
    generated_at: options.generatedAt ?? new Date().toISOString(),
    status,
    required_docs: requiredDocs,
    gates,
    counts: {
      required_docs: requiredDocs.length,
      docs_present: docsPresent,
      required_gates: gates.length,
      gates_approved: gatesApproved,
    },
    caveats,
    artifact_paths: {
      markdown: join(outDir, "customer-testing-readiness.md"),
      json: join(outDir, "customer-testing-readiness.json"),
    },
  };
}

export function formatCustomerTestingReadinessJson(report: CustomerTestingReadinessReport): string {
  return JSON.stringify(report, null, 2) + "\n";
}

export function formatCustomerTestingReadinessMarkdown(report: CustomerTestingReadinessReport): string {
  const lines = [
    `# Customer-testing readiness — ${report.status === "ready_for_customer_testing" ? "READY" : "BLOCKED"}`,
    "",
    `Generated at: ${report.generated_at}`,
    "",
    "## Summary",
    "",
    `- Status: \`${report.status}\``,
    `- Required docs present: ${report.counts.docs_present}/${report.counts.required_docs}`,
    `- Approval gates complete: ${report.counts.gates_approved}/${report.counts.required_gates}`,
    "",
    "## Required documents",
    "",
    "| Document | Present |",
    "| --- | --- |",
    ...report.required_docs.map((doc) => `| \`${doc.path}\` | ${doc.present ? "yes" : "no"} |`),
    "",
    "## Approval gates",
    "",
    "| Gate | Approved |",
    "| --- | --- |",
    ...report.gates.map((gate) => `| ${gate.label} | ${gate.approved ? "yes" : "no"} |`),
    "",
    "## Caveats",
    "",
    ...report.caveats.map((caveat) => `- \`${caveat}\``),
    "",
    "This report intentionally omits customer trace content, approval notes, credential values, and raw logs.",
    "A ready status records only the supplied repo-side checklist; it is not evidence that a customer granted consent.",
    "",
  ];
  return lines.join("\n");
}

export function writeCustomerTestingReadinessReport(report: CustomerTestingReadinessReport): void {
  const outDir = dirname(report.artifact_paths.markdown);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(report.artifact_paths.markdown, formatCustomerTestingReadinessMarkdown(report));
  writeFileSync(report.artifact_paths.json, formatCustomerTestingReadinessJson(report));
}
