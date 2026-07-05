/**
 * Live Fireworks-behind-Cloudflare-AI-Gateway smoke + log verification (env-gated CLI).
 *
 * Sends ONE synthetic chat request through the Gateway, polls the Gateway logs API for the
 * matching trace_id, normalizes it with the existing adapter, runs `verifyGatewayLog`, and
 * writes a redacted report to `artifacts/fireworks-gateway-smoke.{json,md}` (gitignored).
 * Exits non-zero on verification failure. Fails CLOSED when required env is missing.
 *
 *   npm run smoke:fireworks-gateway -- --dry-run   # print redacted request, send nothing
 *   npm run smoke:fireworks-gateway                 # live send + poll + verify
 *
 * Secrets (FIREWORKS_API_KEY, CF_AIG_TOKEN, CF_API_TOKEN) stay env-only and never enter the
 * repo, artifacts, or logs — the request is redacted before it is printed or written.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  normalizeCloudflareAiGatewayLog,
  type CloudflareAiGatewayLog,
  type NormalizedBlindBenchTrace,
} from "../src/lib/evals/cloudflareAiGateway";
import { loadConfig } from "../src/lib/evals/fireworksGatewayPrototype";
import {
  buildSmokeRequest,
  redactSmokeRequest,
  verifyGatewayLog,
  type SmokeRequest,
  type VerifyResult,
} from "../src/lib/evals/fireworksGatewaySmoke";

/** Env vars required to build + send the smoke request. */
const REQUIRED_ENV = [
  "CF_ACCOUNT_ID",
  "CF_AIG_GATEWAY",
  "CF_AIG_TOKEN",
  "FIREWORKS_API_KEY",
  "FIREWORKS_MODEL",
] as const;

/** Additional env required only for a live run (reading the Gateway logs API). */
const LIVE_ENV = ["CF_API_TOKEN"] as const;

const OUT_DIR = "artifacts";
const POLL_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 3_000;
const CF_API_BASE = "https://api.cloudflare.com/client/v4";

type Env = Record<string, string | undefined>;

export interface CliArgs {
  dryRun: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  return { dryRun: argv.includes("--dry-run") };
}

/** Missing entries from a required-env list (unset or empty). */
function missingEnv(env: Env, keys: readonly string[]): string[] {
  return keys.filter((k) => env[k] === undefined || env[k] === "");
}

/** Poll dependencies, injectable so the pure control flow stays testable without network. */
export interface PollDeps {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

interface CfLogsResponse {
  success?: boolean;
  result?: unknown[];
  errors?: unknown[];
}

/** Poll the Gateway logs API until a log carrying `traceId` in its metadata appears, or timeout. */
export async function pollForTraceLog(
  deps: PollDeps,
  opts: { accountId: string; gateway: string; apiToken: string; traceId: string; timeoutMs?: number },
): Promise<CloudflareAiGatewayLog | undefined> {
  const url = `${CF_API_BASE}/accounts/${opts.accountId}/ai-gateway/gateways/${opts.gateway}/logs?per_page=50`;
  const deadline = deps.now() + (opts.timeoutMs ?? POLL_TIMEOUT_MS);
  do {
    const res = await deps.fetch(url, { headers: { Authorization: `Bearer ${opts.apiToken}` } });
    if (res.ok) {
      const payload = (await res.json()) as CfLogsResponse;
      for (const entry of payload.result ?? []) {
        const record = entry as CloudflareAiGatewayLog;
        if (normalizeCloudflareAiGatewayLog(record).metadata.trace_id === opts.traceId) return record;
      }
    }
    if (deps.now() >= deadline) break;
    await deps.sleep(POLL_INTERVAL_MS);
  } while (deps.now() < deadline);
  return undefined;
}

/** Send the smoke request through the Gateway. */
async function sendSmokeRequest(
  fetchImpl: typeof fetch,
  req: SmokeRequest,
): Promise<{ status: number; ok: boolean }> {
  const res = await fetchImpl(req.url, {
    method: "POST",
    headers: req.headers,
    body: JSON.stringify(req.body),
  });
  return { status: res.status, ok: res.ok };
}

function reportMarkdown(
  trace: NormalizedBlindBenchTrace,
  result: VerifyResult,
  redacted: SmokeRequest,
): string {
  const L: string[] = [];
  L.push("# Fireworks → Cloudflare AI Gateway live smoke");
  L.push("");
  L.push(`- Result: **${result.ok ? "PASS" : "FAIL"}**`);
  L.push(`- trace_id: \`${trace.metadata.trace_id ?? "<none>"}\``);
  L.push(`- provider: \`${trace.provider ?? "<none>"}\` · model: \`${trace.model ?? "<none>"}\``);
  L.push(`- status: \`${trace.status ?? "<none>"}\` · duration_ms: \`${trace.duration_ms ?? "<none>"}\``);
  L.push("");
  L.push("## Failures");
  L.push("");
  L.push(result.failures.length ? result.failures.map((f) => `- ${f}`).join("\n") : "_none_");
  L.push("");
  L.push("## Notes");
  L.push("");
  L.push(result.notes.length ? result.notes.map((n) => `- ${n}`).join("\n") : "_none_");
  L.push("");
  L.push("## Redacted request");
  L.push("");
  L.push("```json");
  L.push(JSON.stringify(redacted, null, 2));
  L.push("```");
  L.push("");
  return L.join("\n");
}

function writeArtifacts(
  trace: NormalizedBlindBenchTrace,
  result: VerifyResult,
  redacted: SmokeRequest,
): void {
  mkdirSync(OUT_DIR, { recursive: true });
  // Only redacted request + normalized trace (no headers/secrets) are persisted.
  writeFileSync(
    `${OUT_DIR}/fireworks-gateway-smoke.json`,
    JSON.stringify({ ok: result.ok, failures: result.failures, notes: result.notes, request: redacted, trace }, null, 2),
  );
  writeFileSync(`${OUT_DIR}/fireworks-gateway-smoke.md`, reportMarkdown(trace, result, redacted));
}

export async function main(
  argv: string[],
  env: Env = process.env,
  deps: PollDeps = { fetch, now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
): Promise<number> {
  const { dryRun } = parseArgs(argv);

  const missing = missingEnv(env, REQUIRED_ENV);
  if (missing.length) {
    process.stderr.write(
      `fireworks-gateway-smoke: missing required env: ${missing.join(", ")}. ` +
        `Set all of ${REQUIRED_ENV.join(", ")} (secrets stay env-only, never committed).\n`,
    );
    return 1;
  }

  // tenant_label / product are metadata-only; default them so the smoke needs just the
  // required credential + routing vars above.
  const config = loadConfig({
    ...env,
    TENANT_LABEL: env.TENANT_LABEL ?? "smoke-synthetic-tenant",
    PRODUCT: env.PRODUCT ?? "migo",
  });

  const traceId = `smoke-${randomUUID()}`;
  const request = buildSmokeRequest(config, {
    traceId,
    sessionId: `smoke-session-${randomUUID()}`,
    fireworksApiKey: env.FIREWORKS_API_KEY!,
    gatewayToken: env.CF_AIG_TOKEN!,
  });
  const redacted = redactSmokeRequest(request);

  if (dryRun) {
    process.stdout.write(`Dry run — no request sent. Redacted request:\n`);
    process.stdout.write(JSON.stringify(redacted, null, 2) + "\n");
    return 0;
  }

  const liveMissing = missingEnv(env, LIVE_ENV);
  if (liveMissing.length) {
    process.stderr.write(
      `fireworks-gateway-smoke: live run needs ${liveMissing.join(", ")} to read the Gateway logs API. ` +
        `Use --dry-run to skip sending.\n`,
    );
    return 1;
  }

  process.stdout.write(`Sending synthetic smoke request (trace_id=${traceId})…\n`);
  const send = await sendSmokeRequest(deps.fetch, request);
  process.stdout.write(`Gateway responded HTTP ${send.status}.\n`);

  process.stdout.write(`Polling Gateway logs for trace_id (timeout ${POLL_TIMEOUT_MS / 1000}s)…\n`);
  const record = await pollForTraceLog(deps, {
    accountId: config.cf_account_id,
    gateway: config.cf_gateway,
    apiToken: env.CF_API_TOKEN!,
    traceId,
  });
  if (!record) {
    process.stderr.write(`No Gateway log found for trace_id=${traceId} within the timeout.\n`);
    return 1;
  }

  const trace = normalizeCloudflareAiGatewayLog(record);
  const result = verifyGatewayLog(trace, {
    provider: config.provider_slug,
    model: config.fireworks_model,
    traceId,
  });
  writeArtifacts(trace, result, redacted);

  process.stdout.write(`Verification: ${result.ok ? "PASS" : "FAIL"}\n`);
  for (const n of result.notes) process.stdout.write(`  note: ${n}\n`);
  for (const f of result.failures) process.stderr.write(`  fail: ${f}\n`);
  process.stdout.write(`Wrote ${OUT_DIR}/fireworks-gateway-smoke.{json,md}.\n`);
  return result.ok ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e: unknown) => {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    });
}
