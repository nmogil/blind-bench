import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type CustomerTestLaunchPacketStatus = "ready_to_review" | "blocked_missing_sources";

export interface LaunchPacketSourceDoc {
  path: string;
  present: boolean;
  purpose: string;
}

export interface LaunchPacketChecklistItem {
  id: string;
  label: string;
  requiredBeforeLiveLogs: boolean;
}

export interface CustomerTestLaunchPacket {
  generated_at: string;
  status: CustomerTestLaunchPacketStatus;
  customer_label: string;
  customer_label_is_approval_evidence: false;
  live_logs_approved: false;
  source_docs: LaunchPacketSourceDoc[];
  counts: {
    source_docs: number;
    source_docs_present: number;
    go_no_go_items: number;
    prerequisites: number;
  };
  launch_objective: string;
  first_session_agenda: string[];
  data_boundary_commitments: string[];
  operator_customer_prerequisites: string[];
  runbook_links: string[];
  go_no_go_checklist: LaunchPacketChecklistItem[];
  post_session_follow_up: string[];
  caveats: string[];
  artifact_paths: {
    markdown: string;
    json: string;
  };
}

const DEFAULT_OUT_DIR = join("artifacts", "customer-test-launch-packet");

export const CUSTOMER_TEST_LAUNCH_SOURCE_DOCS: Array<{ path: string; purpose: string }> = [
  { path: "docs/customer-pilot-sow.md", purpose: "Pilot scope, deliverables, and success criteria" },
  { path: "docs/customer-ai-quality-scorecard-handoff.md", purpose: "Customer-facing scorecard and payment handoff" },
  { path: "docs/tenancy-consent-data-isolation.md", purpose: "Consent, tenancy, retention, and training-use boundary" },
  { path: "docs/cloudflare-gateway-live-import.md", purpose: "Cloudflare AI Gateway customer-export import path" },
  { path: "docs/native-ingest.md", purpose: "Native eval-record ingest and redaction boundary" },
  { path: "docs/training-dataset-compiler.md", purpose: "Training export guardrails and approval gate" },
  { path: "docs/gateway-onboarding.md", purpose: "Operator onboarding checklist and metadata conventions" },
];

export function sanitizeCustomerTestLabel(input?: string): string {
  const raw = (input ?? "customer-test").toLowerCase();
  const cleaned = raw
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return cleaned || "customer-test";
}

export function buildCustomerTestLaunchPacket(options: {
  repoRoot?: string;
  outDir?: string;
  customerLabel?: string;
  generatedAt?: string;
} = {}): CustomerTestLaunchPacket {
  const repoRoot = options.repoRoot ?? process.cwd();
  const outDir = options.outDir ?? DEFAULT_OUT_DIR;
  const sourceDocs = CUSTOMER_TEST_LAUNCH_SOURCE_DOCS.map((doc) => ({
    ...doc,
    present: existsSync(join(repoRoot, doc.path)),
  }));
  const presentCount = sourceDocs.filter((doc) => doc.present).length;
  const status: CustomerTestLaunchPacketStatus =
    presentCount === sourceDocs.length ? "ready_to_review" : "blocked_missing_sources";
  const customerLabel = sanitizeCustomerTestLabel(options.customerLabel);

  const goNoGoChecklist: LaunchPacketChecklistItem[] = [
    { id: "scope-confirmed", label: "Pilot scope and success questions confirmed", requiredBeforeLiveLogs: false },
    { id: "data-boundary-approved", label: "Customer/legal data boundary and approval record confirmed", requiredBeforeLiveLogs: true },
    { id: "operator-export", label: "Operator-owned export path confirmed for logs/files", requiredBeforeLiveLogs: true },
    { id: "reviewer-scope", label: "Reviewer access scope and workspace membership approved", requiredBeforeLiveLogs: true },
    { id: "retention", label: "Retention/deletion policy accepted", requiredBeforeLiveLogs: true },
    { id: "preflight", label: "Local trace preflight planned before import", requiredBeforeLiveLogs: true },
    { id: "training-use", label: "Training/fine-tuning use explicitly approved or blocked", requiredBeforeLiveLogs: true },
    { id: "payment", label: "Manual invoice or package/payment handoff path chosen", requiredBeforeLiveLogs: false },
  ];
  const prerequisites = [
    "Customer workspace and legal data boundary identified.",
    "Customer/operator can export a small representative trace sample they are allowed to share.",
    "Reviewer list and roles are approved before any live review session.",
    "Retention/deletion and training-use posture are agreed before importing real logs.",
    "Local preflight is run before any live import/upload.",
  ];

  return {
    generated_at: options.generatedAt ?? new Date().toISOString(),
    status,
    customer_label: customerLabel,
    customer_label_is_approval_evidence: false,
    live_logs_approved: false,
    source_docs: sourceDocs,
    counts: {
      source_docs: sourceDocs.length,
      source_docs_present: presentCount,
      go_no_go_items: goNoGoChecklist.length,
      prerequisites: prerequisites.length,
    },
    launch_objective:
      "Run a controlled first customer-test session that proves Blind Bench can turn approved operator-owned traces into scoped evaluation/review/training handoff artifacts without crossing the data boundary.",
    first_session_agenda: [
      "Confirm scope, success questions, data boundary, and reviewer roles.",
      "Review metadata conventions and the selected ingest/import path.",
      "Run synthetic/demo artifacts first to calibrate the review loop.",
      "If approvals are complete, run local preflight on a small operator-owned trace export.",
      "Import only approved/redacted data into the customer workspace and create the first review/eval handoff.",
      "Close with go/no-go notes, blockers, and post-session follow-ups.",
    ],
    data_boundary_commitments: [
      "Customer data stays scoped to the customer workspace/legal boundary.",
      "No customer logs seed shared demos, marketing, reusable packs, or shared model training without separate written approval.",
      "Training/fine-tuning exports require explicit approval and classification.",
      "Credential values, raw logs, prompts, and completions are not included in this launch packet.",
      "Synthetic/demo data remains the default until approval gates are complete.",
    ],
    operator_customer_prerequisites: prerequisites,
    runbook_links: sourceDocs.map((doc) => doc.path),
    go_no_go_checklist: goNoGoChecklist,
    post_session_follow_up: [
      "Save the generated packet and any approval evidence outside committed source control.",
      "Record imported counts, dedupe counts, invalid-line counts, and redaction caveats in the customer workspace notes.",
      "List review outcomes and any scorer/config changes needed before broader rollout.",
      "Confirm whether training export remains blocked or has explicit approved next steps.",
      "Turn remaining blockers into GitHub issues or customer-specific private tasks.",
    ],
    caveats: [
      "This packet is not an approval record.",
      "A sanitized customer label is an operator convenience only; it is not evidence of consent.",
      "Do not import live customer/operator logs until approval and local preflight steps are complete.",
      ...(status === "blocked_missing_sources" ? ["One or more required source documents are missing."] : []),
    ],
    artifact_paths: {
      markdown: join(outDir, "customer-test-launch-packet.md"),
      json: join(outDir, "customer-test-launch-packet.json"),
    },
  };
}

export function formatCustomerTestLaunchPacketJson(packet: CustomerTestLaunchPacket): string {
  return JSON.stringify(packet, null, 2) + "\n";
}

export function formatCustomerTestLaunchPacketMarkdown(packet: CustomerTestLaunchPacket): string {
  const lines = [
    `# Customer-test launch packet — ${packet.customer_label}`,
    "",
    `Generated at: ${packet.generated_at}`,
    `Status: \`${packet.status}\``,
    "",
    "**This packet status only means the source documents are present for review. It does not approve live-log import or prove customer consent.**",
    "",
    "## Objective",
    "",
    packet.launch_objective,
    "",
    "## Source docs checked",
    "",
    "| Document | Present | Purpose |",
    "| --- | --- | --- |",
    ...packet.source_docs.map((doc) => `| \`${doc.path}\` | ${doc.present ? "yes" : "no"} | ${doc.purpose} |`),
    "",
    "## First-session agenda",
    "",
    ...packet.first_session_agenda.map((item, index) => `${index + 1}. ${item}`),
    "",
    "## Data-boundary commitments",
    "",
    ...packet.data_boundary_commitments.map((item) => `- ${item}`),
    "",
    "## Operator/customer prerequisites",
    "",
    ...packet.operator_customer_prerequisites.map((item) => `- ${item}`),
    "",
    "## Go/no-go checklist",
    "",
    "| Item | Required before live logs |",
    "| --- | --- |",
    ...packet.go_no_go_checklist.map(
      (item) => `| ${item.label} | ${item.requiredBeforeLiveLogs ? "yes" : "no"} |`,
    ),
    "",
    "## Runbook links",
    "",
    ...packet.runbook_links.map((link) => `- \`${link}\``),
    "",
    "## Post-session follow-up",
    "",
    ...packet.post_session_follow_up.map((item) => `- ${item}`),
    "",
    "## Caveats",
    "",
    ...packet.caveats.map((item) => `- ${item}`),
    "",
  ];
  return lines.join("\n");
}

export function writeCustomerTestLaunchPacket(packet: CustomerTestLaunchPacket): void {
  mkdirSync(dirname(packet.artifact_paths.markdown), { recursive: true });
  writeFileSync(packet.artifact_paths.markdown, formatCustomerTestLaunchPacketMarkdown(packet));
  writeFileSync(packet.artifact_paths.json, formatCustomerTestLaunchPacketJson(packet));
}
