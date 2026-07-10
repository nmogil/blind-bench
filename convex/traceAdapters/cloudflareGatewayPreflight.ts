import {
  DEFAULT_LIMITS,
  MAX_REPORTED_INVALID_LINES,
  parseGatewayJsonl,
  parseSidecar,
  summarizeTraces,
  type SidecarMap,
} from "./cloudflareAiGateway";

export type GatewayPreflightStatus = "ready" | "blocked";

export interface GatewayPreflightSummary {
  status: GatewayPreflightStatus;
  parsed: number;
  invalid: number;
  invalid_lines: number[];
  truncated: boolean;
  over_size: boolean;
  input_bytes: number;
  redacted_request: number;
  redacted_response: number;
  models: string[];
  providers: string[];
  earliest?: string;
  latest?: string;
  sidecar?: {
    supplied: boolean;
    entries: number;
    matched: number;
  };
  caveats: string[];
}

export const DEFAULT_MAX_BYTES = DEFAULT_LIMITS.maxBytes;

export interface GatewayPreflightOptions {
  sidecarJson?: string;
}

function caveatsFor(summary: Omit<GatewayPreflightSummary, "caveats">): string[] {
  const caveats: string[] = [];
  if (summary.parsed === 0) caveats.push("No valid Gateway log records were parsed; choose a different export file.");
  if (summary.invalid > 0) caveats.push("Malformed or unsupported JSONL lines were skipped; line numbers are reported without echoing content.");
  if (summary.truncated) caveats.push(`Input exceeded ${DEFAULT_LIMITS.maxLines} non-blank lines; split the export into smaller batches.`);
  if (summary.redacted_request > 0) caveats.push("Some records have redacted or missing request messages.");
  if (summary.redacted_response > 0) caveats.push("Some records have redacted or missing responses.");
  if (summary.sidecar?.supplied && summary.sidecar.entries === 0) caveats.push("Sidecar was supplied but no valid primitive metadata entries were parsed.");
  if (summary.sidecar?.supplied && summary.sidecar.entries > 0 && summary.sidecar.matched === 0) caveats.push("Sidecar entries parsed, but none matched the parsed Gateway records.");
  return caveats;
}

export function summarizeGatewayPreflight(
  jsonl: string,
  options: GatewayPreflightOptions = {},
): GatewayPreflightSummary {
  const inputBytes = new TextEncoder().encode(jsonl).byteLength;
  if (inputBytes > DEFAULT_MAX_BYTES) {
    return {
      status: "blocked",
      parsed: 0,
      invalid: 0,
      invalid_lines: [],
      truncated: false,
      over_size: true,
      input_bytes: inputBytes,
      redacted_request: 0,
      redacted_response: 0,
      models: [],
      providers: [],
      caveats: ["Input exceeds the authenticated importer's 8 MiB file limit; split the export before import."],
    };
  }
  let sidecar: SidecarMap | undefined;
  let sidecarEntries = 0;
  const sidecarSupplied = options.sidecarJson !== undefined;
  if (sidecarSupplied) {
    const parsed = parseSidecar(options.sidecarJson ?? "");
    sidecar = parsed.sidecar;
    sidecarEntries = parsed.entries;
  }

  const parsed = parseGatewayJsonl(jsonl, DEFAULT_LIMITS, sidecar);
  const aggregate = summarizeTraces(parsed.traces);
  const matched = parsed.sidecarMerged.filter(Boolean).length;
  const status: GatewayPreflightStatus = parsed.traces.length > 0 && !parsed.truncated ? "ready" : "blocked";
  const withoutCaveats: Omit<GatewayPreflightSummary, "caveats"> = {
    status,
    parsed: parsed.traces.length,
    invalid: parsed.invalidLines.length,
    invalid_lines: parsed.invalidLines.slice(0, MAX_REPORTED_INVALID_LINES),
    truncated: parsed.truncated,
    over_size: false,
    input_bytes: inputBytes,
    redacted_request: aggregate.redactedRequest,
    redacted_response: aggregate.redactedResponse,
    models: aggregate.models,
    providers: aggregate.providers,
    ...(aggregate.earliest ? { earliest: aggregate.earliest } : {}),
    ...(aggregate.latest ? { latest: aggregate.latest } : {}),
    ...(sidecarSupplied ? { sidecar: { supplied: true, entries: sidecarEntries, matched } } : {}),
  };

  return { ...withoutCaveats, caveats: caveatsFor(withoutCaveats) };
}

export function formatGatewayPreflightText(summary: GatewayPreflightSummary): string {
  const lines: string[] = [];
  lines.push("Cloudflare Gateway export preflight");
  lines.push(`status: ${summary.status}`);
  lines.push(`parsed: ${summary.parsed}`);
  lines.push(`invalid_lines: ${summary.invalid}${summary.invalid_lines.length ? ` (${summary.invalid_lines.join(", ")})` : ""}`);
  lines.push(`truncated: ${summary.truncated}`);
  lines.push(`over_size: ${summary.over_size}`);
  lines.push(`input_bytes: ${summary.input_bytes}`);
  lines.push(`models: ${summary.models.length ? summary.models.join(", ") : "unknown"}`);
  lines.push(`providers: ${summary.providers.length ? summary.providers.join(", ") : "unknown"}`);
  lines.push(`time_bounds: ${summary.earliest ?? "unknown"} → ${summary.latest ?? "unknown"}`);
  lines.push(`redacted_or_missing_requests: ${summary.redacted_request}`);
  lines.push(`redacted_or_missing_responses: ${summary.redacted_response}`);
  if (summary.sidecar?.supplied) {
    lines.push(`sidecar_entries: ${summary.sidecar.entries}`);
    lines.push(`sidecar_matched_records: ${summary.sidecar.matched}`);
  }
  if (summary.caveats.length) {
    lines.push("caveats:");
    for (const caveat of summary.caveats) lines.push(`- ${caveat}`);
  }
  lines.push(summary.status === "ready"
    ? "safe_to_import: use the authenticated Gateway Import app surface next; this preflight did not send data anywhere."
    : "no_data_sent: preflight is blocked; resolve the caveats before authenticated import.");
  return lines.join("\n") + "\n";
}

export function formatGatewayPreflightJson(summary: GatewayPreflightSummary): string {
  return JSON.stringify(summary, null, 2) + "\n";
}
