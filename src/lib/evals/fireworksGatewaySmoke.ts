/**
 * Fireworks-behind-Cloudflare-AI-Gateway live smoke helpers (pure, no network).
 *
 * `buildSmokeRequest` assembles the exact request the live CLI
 * (`scripts/fireworks-gateway-smoke.ts`) sends through the Gateway; `verifyGatewayLog`
 * asserts the normalized Gateway log for that request proves the hop worked end-to-end.
 *
 * Route shapes (compat default / provider mode), the model field, and the metadata keys
 * are reused verbatim from `fireworksGatewayPrototype.ts` so the smoke path stays 1:1 with
 * the runbook. Secrets are never embedded: they are passed in per-request and stripped by
 * `redactSmokeRequest` before anything is printed or written to an artifact.
 */
import type { NormalizedBlindBenchTrace } from "./cloudflareAiGateway";
import {
  buildMetadata,
  gatewayUrlForMode,
  modelField,
  type PrototypeConfig,
} from "./fireworksGatewayPrototype";

/** Synthetic prompt — never production or customer data. */
export const SMOKE_PROMPT = "Synthetic smoke prompt — no production or customer data. Reply with: ok.";

/** Metadata keys the smoke request sets and expects to round-trip through the Gateway log. */
export const SMOKE_METADATA_KEYS = [
  "product",
  "module",
  "prompt_version",
  "variant",
  "release",
  "environment",
  "tenant",
  "trace_id",
  "session_id",
] as const;

export interface SmokeRequestBody {
  model: string;
  messages: { role: string; content: string }[];
  max_tokens: number;
  metadata: Record<string, string>;
}

export interface SmokeRequest {
  url: string;
  headers: Record<string, string>;
  body: SmokeRequestBody;
  traceId: string;
}

export interface SmokeRequestParams {
  /** Unique per-request trace id (the CLI generates a random one). */
  traceId: string;
  /** Unique per-request session id; defaults to `traceId`. */
  sessionId?: string;
  /** Upstream Fireworks provider key. */
  fireworksApiKey: string;
  /** Cloudflare AI Gateway edge-auth token (distinct from the upstream key). */
  gatewayToken: string;
}

/** Metadata for a live smoke request: prototype metadata with unique per-request ids. */
export function buildSmokeMetadata(
  config: PrototypeConfig,
  ids: { traceId: string; sessionId?: string },
): Record<string, string> {
  return {
    ...buildMetadata(config),
    trace_id: ids.traceId,
    session_id: ids.sessionId ?? ids.traceId,
  };
}

/**
 * Build the live Gateway request. Carries real credentials in headers so it can be sent;
 * use `redactSmokeRequest` before printing or persisting.
 * - `Authorization` — upstream Fireworks key.
 * - `cf-aig-authorization` — Gateway edge token.
 * - `cf-aig-metadata` — routing metadata (also mirrored in the body).
 */
export function buildSmokeRequest(config: PrototypeConfig, params: SmokeRequestParams): SmokeRequest {
  const metadata = buildSmokeMetadata(config, params);
  return {
    url: gatewayUrlForMode(config),
    headers: {
      Authorization: `Bearer ${params.fireworksApiKey}`,
      "cf-aig-authorization": `Bearer ${params.gatewayToken}`,
      "cf-aig-metadata": JSON.stringify(metadata),
      "Content-Type": "application/json",
    },
    body: {
      model: modelField(config),
      messages: [{ role: "user", content: SMOKE_PROMPT }],
      max_tokens: 64,
      metadata,
    },
    traceId: params.traceId,
  };
}

/** Env vars whose values must never appear in any output; replaced by `$NAME` placeholders. */
export const SECRET_ENV_VARS = ["FIREWORKS_API_KEY", "CF_AIG_TOKEN", "CF_API_TOKEN"] as const;

/**
 * Replace every occurrence of each secret env value in `text` with its `$NAME` placeholder.
 * Run this over ANY string that could carry a secret (error messages, API response bodies)
 * before it reaches stderr/stdout or an artifact. Unset/empty secrets are skipped.
 */
export function redactSecrets(text: string, env: Record<string, string | undefined>): string {
  let out = text;
  for (const name of SECRET_ENV_VARS) {
    const value = env[name];
    if (value !== undefined && value !== "") out = out.split(value).join(`$${name}`);
  }
  return out;
}

/** Copy of a smoke request with both secret header values replaced by env-var placeholders. */
export function redactSmokeRequest(req: SmokeRequest): SmokeRequest {
  return {
    ...req,
    headers: {
      ...req.headers,
      Authorization: "Bearer $FIREWORKS_API_KEY",
      "cf-aig-authorization": "Bearer $CF_AIG_TOKEN",
    },
  };
}

// --- log verification --------------------------------------------------------

export interface VerifyExpectations {
  /** Expected provider slug, e.g. `fireworks-ai`. */
  provider: string;
  /** Expected resolved Fireworks model id. */
  model: string;
  /** The unique trace_id the request carried; must round-trip in log metadata. */
  traceId: string;
  /** Metadata keys expected to round-trip; defaults to `SMOKE_METADATA_KEYS`. */
  metadataKeys?: readonly string[];
}

export interface VerifyResult {
  ok: boolean;
  /** Hard failures — any entry means the smoke did not prove the hop. */
  failures: string[];
  /** Informational observations (cost presence, redaction) — never fatal. */
  notes: string[];
}

/** Tolerant slug/id comparison: present and equal or a substring either direction (case-insensitive). */
function looselyMatches(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const a = actual.toLowerCase();
  const e = expected.toLowerCase();
  return a === e || a.includes(e) || e.includes(a);
}

/**
 * Verify a normalized Gateway log proves the Fireworks-behind-Gateway hop for one request.
 * Returns `{ ok, failures, notes }`. `cost_usd` may legitimately be null and body redaction
 * is expected under strict log settings — both are reported as notes, never failures.
 */
export function verifyGatewayLog(
  trace: NormalizedBlindBenchTrace,
  expected: VerifyExpectations,
): VerifyResult {
  const failures: string[] = [];
  const notes: string[] = [];

  if (!looselyMatches(trace.provider, expected.provider)) {
    failures.push(`provider mismatch: expected ~"${expected.provider}", got "${trace.provider ?? "<none>"}"`);
  }
  if (!looselyMatches(trace.model, expected.model)) {
    failures.push(`resolved model mismatch: expected ~"${expected.model}", got "${trace.model ?? "<none>"}"`);
  }

  const { input_tokens, output_tokens, total_tokens } = trace.usage;
  if (input_tokens === undefined && output_tokens === undefined && total_tokens === undefined) {
    failures.push("usage tokens missing: no input/output/total token counts in log");
  }

  if (trace.duration_ms === undefined) {
    failures.push("duration_ms missing: end-to-end latency not captured");
  }

  if (trace.status === undefined) {
    failures.push("status missing: no request status recorded");
  } else if (trace.status.toLowerCase() !== "success") {
    failures.push(`status not success: "${trace.status}"`);
  }

  const metadataKeys = expected.metadataKeys ?? SMOKE_METADATA_KEYS;
  const missingMeta = metadataKeys.filter((k) => trace.metadata[k] === undefined || trace.metadata[k] === "");
  if (missingMeta.length) {
    failures.push(`metadata keys did not round-trip: ${missingMeta.join(", ")}`);
  }
  if (trace.metadata.trace_id !== expected.traceId) {
    failures.push(
      `trace_id did not round-trip: expected "${expected.traceId}", got "${String(trace.metadata.trace_id ?? "<none>")}"`,
    );
  }

  notes.push(
    trace.cost_usd === undefined
      ? "cost_usd absent (provider did not report it — not fatal)"
      : `cost_usd present: ${trace.cost_usd}`,
  );
  if (trace.redaction.request_missing || trace.redaction.response_missing) {
    notes.push(
      `body redaction observed (request_missing=${trace.redaction.request_missing}, ` +
        `response_missing=${trace.redaction.response_missing}) — expected under strict log settings, not fatal`,
    );
  }

  return { ok: failures.length === 0, failures, notes };
}
