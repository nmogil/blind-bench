import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  CUSTOMER_TEST_LAUNCH_SOURCE_DOCS,
  buildCustomerTestLaunchPacket,
  formatCustomerTestLaunchPacketJson,
  formatCustomerTestLaunchPacketMarkdown,
  sanitizeCustomerTestLabel,
  writeCustomerTestLaunchPacket,
} from "./customerTestLaunchPacket";

describe("customer test launch packet", () => {
  test("builds a review-ready packet from existing source docs", () => {
    const packet = buildCustomerTestLaunchPacket({ repoRoot: process.cwd(), customerLabel: "Customer Test 01" });
    expect(packet.status).toBe("ready_to_review");
    expect(packet.customer_label).toBe("customer-test-01");
    expect(packet.customer_label_is_approval_evidence).toBe(false);
    expect(packet.live_logs_approved).toBe(false);
    expect(packet.generated_at).not.toBe("2026-01-01T00:00:00Z");
    expect(formatCustomerTestLaunchPacketMarkdown(packet)).toContain("does not approve live-log import");
    expect(packet.counts.source_docs_present).toBe(CUSTOMER_TEST_LAUNCH_SOURCE_DOCS.length);
    expect(packet.go_no_go_checklist.some((item) => item.requiredBeforeLiveLogs)).toBe(true);
  });

  test("detects missing source docs", () => {
    const dir = mkdtempSync(join(tmpdir(), "launch-packet-empty-"));
    mkdirSync(join(dir, "docs"));
    const packet = buildCustomerTestLaunchPacket({ repoRoot: dir });
    expect(packet.status).toBe("blocked_missing_sources");
    expect(packet.counts.source_docs_present).toBe(0);
    expect(packet.caveats).toContain("One or more required source documents are missing.");
  });

  test("sanitizes and caps the customer label", () => {
    expect(sanitizeCustomerTestLabel("  ACME Pilot!! East Region  ")).toBe("acme-pilot-east-region");
    expect(sanitizeCustomerTestLabel("!!!")).toBe("customer-test");
    expect(sanitizeCustomerTestLabel("a".repeat(80))).toHaveLength(48);
  });

  test("writes safe artifacts without leaking unsafe raw label text", () => {
    const dir = mkdtempSync(join(tmpdir(), "launch-packet-"));
    const unsafe = "Raw Secret Customer Name<script>alert(1)</script>";
    const packet = buildCustomerTestLaunchPacket({ repoRoot: process.cwd(), outDir: dir, customerLabel: unsafe });
    writeCustomerTestLaunchPacket(packet);
    const markdown = readFileSync(packet.artifact_paths.markdown, "utf8");
    const json = readFileSync(packet.artifact_paths.json, "utf8");
    const formatted = formatCustomerTestLaunchPacketMarkdown(packet) + formatCustomerTestLaunchPacketJson(packet);
    expect(markdown).toContain("Customer-test launch packet");
    expect(JSON.parse(json).customer_label).toBe("raw-secret-customer-name-script-alert-1-script");
    expect(formatted).not.toContain(unsafe);
    expect(formatted).not.toContain("<script>");
  });
});
