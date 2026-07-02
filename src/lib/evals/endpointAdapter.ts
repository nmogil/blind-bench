/**
 * Live endpoint capture for baseline-vs-candidate model comparison (issue #229).
 *
 * Calls an OpenAI-compatible chat-completions endpoint for every case in a pack
 * and normalizes responses into the `Record<caseId, AgentOutput>` fixture shape
 * consumed unchanged by `runPack()` / `compareModels()`. Failed requests are
 * reported as capture errors and the case is simply absent from `outputs` — the
 * existing runner counts it as a missing fixture and the comparison's coverage
 * gate blocks promotion (fail-closed).
 *
 * Secrets never live in config objects or files: header values carry `$ENV_VAR`
 * placeholders resolved from the environment at request time (same convention
 * as `fireworksGatewayPrototype.ts`).
 */
import { z } from "zod/v4";
import { AgentOutput, EvalCase, type EvalCaseInput } from "./evalCase";
import {
  buildMetadata,
  gatewayUrlForMode,
  loadConfig,
  modelField,
} from "./fireworksGatewayPrototype";

// --- endpoint config -----------------------------------------------------------

export const EndpointConfig = z.object({
  /** Human label for reports, e.g. "baseline (gpt-4o via openrouter)". */
  label: z.string().min(1),
  /** OpenAI-compatible chat-completions URL. */
  url: z.string().url(),
  /** Model string sent in the request body. */
  model: z.string().min(1),
  /** Header values may contain `$ENV_VAR` placeholders resolved at request time. */
  headers: z.record(z.string(), z.string()).default({}),
  max_tokens: z.number().int().positive().default(512),
  temperature: z.number().min(0).max(2).default(0),
});
export type EndpointConfig = z.infer<typeof EndpointConfig>;

/** Resolve `$ENV_VAR` placeholders in header values. Fails closed on missing vars. */
export function resolveHeaders(
  headers: Record<string, string>,
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = value.replace(/\$([A-Z][A-Z0-9_]*)/g, (_, varName: string) => {
      const resolved = env[varName];
      if (resolved === undefined || resolved === "") {
        throw new Error(`endpoint header "${name}": env var ${varName} is not set`);
      }
      return resolved;
    });
  }
  return out;
}

/**
 * Candidate endpoint for a Fireworks custom model routed through Cloudflare AI
 * Gateway, built from the same env vars as the routing prototype. Fails closed
 * when required config is missing (no synthetic fallback — this is a live call).
 */
export function fireworksCandidateEndpoint(
  env: Record<string, string | undefined> = process.env,
): EndpointConfig {
  const c = loadConfig(env);
  return EndpointConfig.parse({
    label: `candidate (${c.fireworks_model})`,
    url: gatewayUrlForMode(c),
    model: modelField(c),
    headers: {
      Authorization: "Bearer $FIREWORKS_API_KEY",
      "cf-aig-authorization": "Bearer $CF_AIG_TOKEN",
      "cf-aig-metadata": JSON.stringify(buildMetadata(c)),
    },
  });
}

// --- response normalization ------------------------------------------------------

interface ChatMessage {
  role: string;
  content: string;
}

/** Prior transcript turns first, then the scenario messages. */
function caseMessages(evalCase: EvalCase): ChatMessage[] {
  return [...(evalCase.input.transcript ?? []), ...(evalCase.input.messages ?? [])];
}

function safeParseArgs(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

interface CompletionPayload {
  id?: unknown;
  model?: unknown;
  choices?: {
    message?: {
      content?: unknown;
      tool_calls?: { function?: { name?: unknown; arguments?: unknown } }[];
    };
  }[];
  usage?: { total_tokens?: unknown; cost?: unknown };
}

/**
 * Normalize one OpenAI-compatible completion payload into `AgentOutput`.
 * `raw` carries only the metric/identity fields the runner reads — never the
 * full provider payload, so captured fixture files stay lean and privacy-safe.
 */
export function parseCompletion(payload: unknown, latencyMs: number): AgentOutput {
  const p = payload as CompletionPayload;
  const message = p.choices?.[0]?.message;
  const tool_calls = (message?.tool_calls ?? []).flatMap((tc) => {
    const name = tc?.function?.name;
    if (typeof name !== "string" || name === "") return [];
    const args = safeParseArgs(tc.function?.arguments);
    return [{ name, ...(args ? { args } : {}) }];
  });
  const usage = p.usage;
  const raw = {
    latency_ms: latencyMs,
    ...(typeof usage?.total_tokens === "number" ? { tokens: usage.total_tokens } : {}),
    ...(typeof usage?.cost === "number" ? { cost_usd: usage.cost } : {}),
    ...(typeof p.model === "string" ? { model: p.model } : {}),
    ...(typeof p.id === "string" ? { id: p.id } : {}),
  };
  return AgentOutput.parse({
    ...(typeof message?.content === "string" ? { text: message.content } : {}),
    tool_calls,
    raw,
  });
}

// --- capture ---------------------------------------------------------------------

export interface CaptureError {
  case_id: string;
  error: string;
}

export interface Capture {
  outputs: Record<string, AgentOutput>;
  errors: CaptureError[];
}

export interface CaptureOptions {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

/**
 * Run every case in `cases` against `endpoint`, returning captured outputs keyed
 * by case id plus per-case errors. Latency is measured client-side around the
 * request; tokens/cost come from the provider's `usage` block when present.
 */
export async function captureOutputs(
  cases: EvalCaseInput[],
  endpoint: EndpointConfig,
  opts: CaptureOptions = {},
): Promise<Capture> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const headers = {
    "Content-Type": "application/json",
    ...resolveHeaders(endpoint.headers, env),
  };

  const outputs: Record<string, AgentOutput> = {};
  const errors: CaptureError[] = [];
  // ponytail: sequential requests; add bounded concurrency if 50-case packs get slow.
  for (const raw of cases) {
    const evalCase = EvalCase.parse(raw);
    const messages = caseMessages(evalCase);
    if (messages.length === 0) {
      errors.push({
        case_id: evalCase.id,
        error: "case has no messages or transcript to send",
      });
      continue;
    }
    const body = JSON.stringify({
      model: endpoint.model,
      messages,
      max_tokens: endpoint.max_tokens,
      temperature: endpoint.temperature,
    });
    const started = now();
    try {
      const res = await fetchImpl(endpoint.url, { method: "POST", headers, body });
      const latency = now() - started;
      if (!res.ok) {
        errors.push({ case_id: evalCase.id, error: `HTTP ${res.status}` });
        continue;
      }
      outputs[evalCase.id] = parseCompletion(await res.json(), latency);
    } catch (e) {
      errors.push({ case_id: evalCase.id, error: (e as Error).message });
    }
  }
  return { outputs, errors };
}
