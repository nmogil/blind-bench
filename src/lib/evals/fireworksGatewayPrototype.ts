/**
 * Fireworks custom-model + Cloudflare AI Gateway routing prototype (local, no network).
 *
 * Produces a deterministic deployment/runbook PLAN and a redacted example cURL for
 * routing a Fireworks fine-tuned/custom model through Cloudflare AI Gateway. It does
 * NOT make any live request and embeds NO secrets: every credential is referenced by
 * env-var placeholder (`$FIREWORKS_API_KEY`, `$CF_AIG_TOKEN`), never by value.
 *
 * The emitted metadata fields line up 1:1 with what `cloudflareAiGateway.ts` reads back
 * out of exported Gateway logs, so the same trace can be normalized → scored downstream.
 *
 * Run it:
 *   npm run prototype:fireworks-gateway              # writes synthetic example artifacts
 *   npm run prototype:fireworks-gateway -- --print-curl
 *   npm run prototype:fireworks-gateway -- --config ./my-route.json --strict
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod/v4";

// --- config ------------------------------------------------------------------

/**
 * Non-secret routing config. Secrets (Fireworks key, Cloudflare AI Gateway token) are
 * NEVER part of this object — they stay env-var-only and appear as `$PLACEHOLDER` in output.
 */
export const PrototypeConfig = z.object({
  cf_account_id: z.string().min(1),
  cf_gateway: z.string().min(1), // gateway id or name
  gateway_mode: z.enum(["provider", "compat"]).default("compat"),
  provider_slug: z.string().min(1).default("fireworks-ai"),
  fireworks_base_url: z.string().url().default("https://api.fireworks.ai/inference/v1"),
  fireworks_model: z.string().min(1), // e.g. accounts/<acct>/models/<custom-model>
  fireworks_deployment_id: z.string().optional(),
  tenant_label: z.string().min(1), // workspace / tenant isolation label
  product: z.string().min(1),
  module: z.string().default("prototype_smoke"),
  prompt_version: z.string().default("pv_prototype_0001"),
  variant: z.string().default("control"),
  release: z.string().default("rel_prototype"),
  environment: z.string().default("staging"),
  synthetic: z.boolean().default(false),
});
export type PrototypeConfig = z.infer<typeof PrototypeConfig>;

const REQUIRED = ["cf_account_id", "cf_gateway", "fireworks_model", "tenant_label", "product"] as const;

const ENV_MAP: Record<string, string> = {
  cf_account_id: "CF_ACCOUNT_ID",
  cf_gateway: "CF_AIG_GATEWAY",
  gateway_mode: "CF_AIG_MODE",
  provider_slug: "FIREWORKS_PROVIDER_SLUG",
  fireworks_base_url: "FIREWORKS_BASE_URL",
  fireworks_model: "FIREWORKS_MODEL",
  fireworks_deployment_id: "FIREWORKS_DEPLOYMENT_ID",
  tenant_label: "TENANT_LABEL",
  product: "PRODUCT",
  module: "MODULE",
  prompt_version: "PROMPT_VERSION",
  variant: "VARIANT",
  release: "RELEASE",
  environment: "ENVIRONMENT",
};

/** Synthetic, customer-generic sample values — clearly fake, safe to commit in artifacts. */
const SYNTHETIC: Record<string, string> = {
  cf_account_id: "SYNTHETIC_cf_account_id",
  cf_gateway: "synthetic-prototype-gateway",
  fireworks_model: "accounts/synthetic/models/migo-eval-ft-0001",
  fireworks_deployment_id: "synthetic-deployment-0001",
  tenant_label: "synthetic-tenant-a",
  product: "migo",
};

/**
 * Build config from an env-style record, optionally merged over a JSON file's contents.
 * Fails CLOSED: if any required field is missing it throws (unless `syntheticFallback`,
 * which fills required gaps with clearly-fake sample values and flags `synthetic: true`).
 */
export function loadConfig(
  source: Record<string, string | undefined>,
  opts: { file?: Record<string, unknown>; syntheticFallback?: boolean } = {},
): PrototypeConfig {
  const raw: Record<string, unknown> = { ...(opts.file ?? {}) };
  for (const [key, env] of Object.entries(ENV_MAP)) {
    if (source[env] !== undefined && source[env] !== "") raw[key] = source[env];
  }

  const missing = REQUIRED.filter((k) => raw[k] === undefined || raw[k] === "");
  if (missing.length) {
    if (!opts.syntheticFallback) {
      throw new Error(
        `fireworks-gateway: missing required config: ${missing.map((k) => ENV_MAP[k]).join(", ")}. ` +
          `Set the env vars, pass --config <file>, or use synthetic example mode.`,
      );
    }
    let usedSynthetic = false;
    for (const k of missing) {
      if (SYNTHETIC[k] !== undefined) {
        raw[k] = SYNTHETIC[k];
        usedSynthetic = true;
      }
    }
    if (usedSynthetic) raw.synthetic = true;
    const stillMissing = REQUIRED.filter((k) => raw[k] === undefined || raw[k] === "");
    if (stillMissing.length) {
      throw new Error(`fireworks-gateway: no synthetic default for: ${stillMissing.join(", ")}`);
    }
  }
  return PrototypeConfig.parse(raw);
}

// --- URL / cURL generation ---------------------------------------------------

const GATEWAY_HOST = "https://gateway.ai.cloudflare.com/v1";

/**
 * Both Cloudflare AI Gateway routing shapes for the configured Fireworks route.
 * - compat: Gateway's OpenAI-compatible endpoint; provider chosen via the `model` field.
 *   This is the default because it is the lowest-risk OpenAI-compatible smoke path.
 * - provider: provider-specific endpoint candidate for operator verification; Cloudflare
 *   provider path details can vary by provider, so confirm with one synthetic request.
 */
export function buildGatewayUrls(c: PrototypeConfig): { provider: string; compat: string } {
  const base = `${GATEWAY_HOST}/${c.cf_account_id}/${c.cf_gateway}`;
  return {
    provider: `${base}/${c.provider_slug}/chat/completions`,
    compat: `${base}/compat/chat/completions`,
  };
}

export function gatewayUrlForMode(c: PrototypeConfig): string {
  const urls = buildGatewayUrls(c);
  return c.gateway_mode === "compat" ? urls.compat : urls.provider;
}

/** Deterministic, clearly-synthetic id derived from config — operator swaps in a real unique id per request. */
function syntheticId(prefix: string, c: PrototypeConfig): string {
  const seed = `${prefix}|${c.cf_account_id}|${c.cf_gateway}|${c.tenant_label}|${c.product}|${c.fireworks_model}`;
  return `synthetic-${prefix}-${createHash("sha256").update(seed).digest("hex").slice(0, 12)}`;
}

/** Request metadata — these keys are exactly what `cloudflareAiGateway.ts` reads back from logs. */
export function buildMetadata(c: PrototypeConfig): Record<string, string> {
  return {
    product: c.product,
    module: c.module,
    prompt_version: c.prompt_version,
    variant: c.variant,
    release: c.release,
    environment: c.environment,
    tenant: c.tenant_label,
    trace_id: syntheticId("trace", c),
    session_id: syntheticId("session", c),
  };
}

/** Model string the request body should carry (compat mode prefixes the provider slug). */
export function modelField(c: PrototypeConfig): string {
  return c.gateway_mode === "compat" ? `${c.provider_slug}/${c.fireworks_model}` : c.fireworks_model;
}

const SYNTHETIC_BODY_MESSAGE = "Synthetic smoke prompt — no production or customer data. Reply with: ok.";

/**
 * Example cURL with secrets redacted to env-var placeholders. The body uses a synthetic
 * prompt only. `cf-aig-metadata` carries the routing metadata; `cf-aig-authorization`
 * carries the Gateway token (separate from the upstream provider key).
 */
export function buildExampleCurl(c: PrototypeConfig): string {
  const body = {
    model: modelField(c),
    messages: [{ role: "user", content: SYNTHETIC_BODY_MESSAGE }],
    max_tokens: 64,
    metadata: buildMetadata(c),
  };
  const headers = [
    `-H 'Authorization: Bearer $FIREWORKS_API_KEY'`,
    `-H 'cf-aig-authorization: Bearer $CF_AIG_TOKEN'`,
    `-H 'cf-aig-metadata: ${JSON.stringify(buildMetadata(c))}'`,
    `-H 'Content-Type: application/json'`,
  ];
  return [
    `curl -sS '${gatewayUrlForMode(c)}'`,
    ...headers.map((h) => `  ${h}`),
    `  -d '${JSON.stringify(body)}'`,
  ].join(" \\\n");
}

// --- log verification checklist ---------------------------------------------

/** Normalized fields the operator must confirm appear in exported Gateway logs. */
export function buildVerificationChecklist(): { field: string; expect: string }[] {
  return [
    { field: "provider", expect: "Fireworks provider slug captured (e.g. fireworks-ai)." },
    { field: "model", expect: "Resolved custom/fine-tuned model id matches the request." },
    { field: "cost_usd", expect: "Per-request cost present where the provider reports it (may be null)." },
    { field: "duration_ms", expect: "End-to-end latency captured." },
    { field: "usage", expect: "input/output/total tokens present." },
    { field: "metadata", expect: "product, module, prompt_version, variant, release, environment, tenant, trace_id, session_id all round-trip." },
    { field: "status", expect: "Success/error status recorded." },
    { field: "redaction", expect: "If request/response bodies are stripped by log settings, normalizer flags request_missing/response_missing — expected and safe." },
  ];
}

// --- plan + runbook ----------------------------------------------------------

export interface PrototypePlan {
  synthetic: boolean;
  route: {
    gateway_mode: PrototypeConfig["gateway_mode"];
    endpoint: string;
    both_endpoints: { provider: string; compat: string };
    model_field: string;
  };
  fireworks: { base_url: string; model: string; deployment_id: string | null };
  tenant_isolation: { tenant_label: string; product: string; environment: string };
  metadata: Record<string, string>;
  auth: { upstream_key: string; gateway_token: string; notes: string[] };
  verification: { field: string; expect: string }[];
}

export function buildPlan(c: PrototypeConfig): PrototypePlan {
  return {
    synthetic: c.synthetic,
    route: {
      gateway_mode: c.gateway_mode,
      endpoint: gatewayUrlForMode(c),
      both_endpoints: buildGatewayUrls(c),
      model_field: modelField(c),
    },
    fireworks: {
      base_url: c.fireworks_base_url,
      model: c.fireworks_model,
      deployment_id: c.fireworks_deployment_id ?? null,
    },
    tenant_isolation: { tenant_label: c.tenant_label, product: c.product, environment: c.environment },
    metadata: buildMetadata(c),
    auth: {
      upstream_key: "$FIREWORKS_API_KEY (env only; never committed)",
      gateway_token: "$CF_AIG_TOKEN (env only; Gateway authenticated-gateway token)",
      notes: [
        "Upstream Fireworks key and Cloudflare AI Gateway token are distinct credentials.",
        "Scope one Fireworks key + one Gateway (and metadata.tenant) per tenant; do not share across tenants.",
        "Keys live in env / secret store only — they never appear in this plan, the cURL, or logs.",
      ],
    },
    verification: buildVerificationChecklist(),
  };
}

export function formatPlanJson(plan: PrototypePlan): string {
  return JSON.stringify(plan, null, 2);
}

export function formatRunbookMarkdown(c: PrototypeConfig, plan: PrototypePlan): string {
  const L: string[] = [];
  L.push("# Fireworks → Cloudflare AI Gateway routing prototype");
  L.push("");
  L.push(
    plan.synthetic
      ? "_Generated with **synthetic** example config (fake account/model/tenant). No secrets, no production data._"
      : "_Generated from operator-supplied config. No secrets are embedded; credentials stay env-var-only._",
  );
  L.push("");

  L.push("## Route");
  L.push("");
  L.push(`- Mode: \`${plan.route.gateway_mode}\``);
  L.push(`- Endpoint: \`${plan.route.endpoint}\``);
  L.push(`- Model field in body: \`${plan.route.model_field}\``);
  L.push(`- Provider-path endpoint: \`${plan.route.both_endpoints.provider}\``);
  L.push(`- OpenAI-compat endpoint: \`${plan.route.both_endpoints.compat}\``);
  L.push("");

  L.push("## Fireworks model");
  L.push("");
  L.push(`- Base URL: \`${plan.fireworks.base_url}\``);
  L.push(`- Model: \`${plan.fireworks.model}\``);
  L.push(`- Deployment id: ${plan.fireworks.deployment_id ? `\`${plan.fireworks.deployment_id}\`` : "n/a"}`);
  L.push("");

  L.push("## Tenant isolation");
  L.push("");
  L.push(`- Tenant label: \`${plan.tenant_isolation.tenant_label}\``);
  L.push(`- Product: \`${plan.tenant_isolation.product}\``);
  L.push(`- Environment: \`${plan.tenant_isolation.environment}\``);
  L.push("");

  L.push("## Auth & key handling");
  L.push("");
  L.push(`- Upstream provider key: ${plan.auth.upstream_key}`);
  L.push(`- Gateway token: ${plan.auth.gateway_token}`);
  for (const n of plan.auth.notes) L.push(`- ${n}`);
  L.push("");

  L.push("## Example request (synthetic prompt, redacted credentials)");
  L.push("");
  L.push("```bash");
  L.push(buildExampleCurl(c));
  L.push("```");
  L.push("");

  L.push("## Gateway log verification checklist");
  L.push("");
  L.push("Export logs (Logpush / Gateway API) and confirm each normalized field is present:");
  L.push("");
  L.push("| Field | Expect |");
  L.push("| --- | --- |");
  for (const v of plan.verification) L.push(`| \`${v.field}\` | ${v.expect} |`);
  L.push("");
  L.push(
    "Feed the exported JSONL into `parseCloudflareAiGatewayJsonl()` (`cloudflareAiGateway.ts`) to normalize, " +
      "then into the scorecard/comparison pipeline.",
  );
  L.push("");
  return L.join("\n");
}

// --- CLI ---------------------------------------------------------------------

const OUT_DIR = "artifacts";

export function parseArgs(argv: string[]): { configFile?: string; printCurl: boolean; strict: boolean } {
  let configFile: string | undefined;
  let printCurl = false;
  let strict = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config") configFile = argv[++i];
    else if (argv[i] === "--print-curl") printCurl = true;
    else if (argv[i] === "--strict") strict = true;
  }
  return { configFile, printCurl, strict };
}

export function main(argv: string[], env: Record<string, string | undefined> = process.env): number {
  const { configFile, printCurl, strict } = parseArgs(argv);
  const file = configFile ? JSON.parse(readFileSync(configFile, "utf8")) : undefined;
  // Synthetic fallback by default so the runbook always generates; --strict (or
  // PROTOTYPE_STRICT=1) demands real config and fails closed. No live request is ever made.
  const syntheticFallback = !strict && env.PROTOTYPE_STRICT !== "1";
  const config = loadConfig(env, { file, syntheticFallback });
  const plan = buildPlan(config);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}/fireworks-cloudflare-routing-prototype.json`, formatPlanJson(plan));
  const md = formatRunbookMarkdown(config, plan);
  writeFileSync(`${OUT_DIR}/fireworks-cloudflare-routing-prototype.md`, md);

  if (printCurl) process.stdout.write(buildExampleCurl(config) + "\n\n");
  process.stdout.write(
    `Wrote ${OUT_DIR}/fireworks-cloudflare-routing-prototype.{json,md}` +
      `${config.synthetic ? " (synthetic example config)" : ""}. No live request made.\n`,
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  }
}
