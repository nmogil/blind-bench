/**
 * #298: management-safe preflight summary for an OTLP/Gen-AI JSON payload.
 *
 * Takes the output of `mapOtlpToTraces` (the ONE mapper — no second parser) and
 * projects it down to counts + non-sensitive labels, so an operator can sanity
 * check a captured/exported payload before pointing a live exporter at the
 * `/otlp/v1/traces` endpoint. Deliberately narrow: it reads ONLY counts, model
 * names, harness/provider names, and capped trace-id suffixes. It never touches
 * step contents (prompts/completions/tool args), so raw bodies, credentials, and
 * account-like sentinels in the payload cannot reach the summary. Pure + node-free
 * so it bundles in the Convex/edge context alongside the mapper.
 */
import type { OtelMapResult } from "./otelGenAI";

export interface PreflightSummary {
  traces: number;
  spans: number;
  steps: number;
  requestMissing: number;
  responseMissing: number;
  /** Distinct gen_ai model names seen (already label-only, never body text). */
  models: string[];
  /** Distinct harness/provider names (gen_ai.system|provider), label-only. */
  harnesses: string[];
  /** Capped, suffix-only trace references — never a full raw id or payload. */
  traceRefs: string[];
  readiness: "ready" | "not_ready";
  caveats: string[];
}

export interface PreflightOptions {
  /** Max trace references to surface (rest are noted as capped). */
  maxRefs?: number;
  /** Trailing characters of each trace id to show. */
  suffixLen?: number;
}

/** Trailing-suffix reference for one trace id (prefix elided when truncated). */
function traceRef(id: string, suffixLen: number): string {
  return id.length > suffixLen ? `…${id.slice(-suffixLen)}` : id;
}

export function buildPreflightSummary(
  result: OtelMapResult,
  opts: PreflightOptions = {},
): PreflightSummary {
  const maxRefs = opts.maxRefs ?? 5;
  const suffixLen = opts.suffixLen ?? 8;
  const { traces, summary } = result;

  const harnesses = [...new Set(traces.map((t) => t.harness.name).filter(Boolean))];
  // run_id is the raw OTel trace id; show only a capped suffix, never the full set.
  const refs = traces.map((t) => traceRef(t.run_id ?? t.trace_id, suffixLen));
  const traceRefs = refs.slice(0, maxRefs);

  const caveats: string[] = [];
  if (summary.traces === 0) {
    caveats.push(
      "No traces mapped — payload has no resourceSpans[].scopeSpans[].spans with gen_ai.* attributes.",
    );
  }
  if (summary.models.length === 0 && summary.traces > 0) {
    caveats.push("No gen_ai.request.model / gen_ai.response.model found on any span.");
  }
  if (summary.requestMissing > 0) {
    caveats.push(`${summary.requestMissing} span(s) had no request/prompt body.`);
  }
  if (summary.responseMissing > 0) {
    caveats.push(`${summary.responseMissing} span(s) had no response/completion body.`);
  }
  if (refs.length > maxRefs) {
    caveats.push(`Showing first ${maxRefs} of ${refs.length} trace references.`);
  }

  return {
    traces: summary.traces,
    spans: summary.spans,
    steps: summary.steps,
    requestMissing: summary.requestMissing,
    responseMissing: summary.responseMissing,
    models: summary.models,
    harnesses,
    traceRefs,
    readiness: summary.traces > 0 ? "ready" : "not_ready",
    caveats,
  };
}

/** Human-readable summary — same fields as the JSON form, no raw payload. */
export function renderPreflightText(s: PreflightSummary): string {
  const list = (xs: string[]) => (xs.length ? xs.join(", ") : "—");
  return [
    `OTLP trace preflight — ${s.readiness === "ready" ? "READY" : "NOT READY"}`,
    ``,
    `  traces:          ${s.traces}`,
    `  spans:           ${s.spans}`,
    `  steps:           ${s.steps}`,
    `  requestMissing:  ${s.requestMissing}`,
    `  responseMissing: ${s.responseMissing}`,
    `  models:          ${list(s.models)}`,
    `  harnesses:       ${list(s.harnesses)}`,
    `  trace refs:      ${list(s.traceRefs)}`,
    ``,
    s.caveats.length ? `Caveats:` : `Caveats: none`,
    ...s.caveats.map((c) => `  - ${c}`),
  ].join("\n");
}
