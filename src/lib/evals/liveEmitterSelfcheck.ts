/**
 * Reference harness example + deterministic selfcheck for the live emitter.
 *
 *   npm run selfcheck:emitter        # mock fetch, no network, asserts, exits 0
 *
 * Shows how a Node/agent harness records a model request, a tool call + result,
 * and the final answer through the emitter, then drains on shutdown. By default
 * it uses a local mock fetch and sends NOTHING over the network. Only if
 * BLINDBENCH_TRACE_ENABLED=true plus a URL + token are present does it emit live
 * (still off unless explicitly configured).
 */
import {
  createEmitter,
  emitterFromEnv,
  type EvalEmitter,
} from "./liveEmitter";

/** Minimal fake `fetch` that records payloads and returns a counts-only 200. */
function mockFetch() {
  const calls: unknown[] = [];
  const fetchImpl = (async (_url: string, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    calls.push(body);
    const records = Array.isArray(body.records) ? body.records.length : 0;
    return {
      ok: true,
      status: 200,
      json: async () => ({ traces: records, imported: records, deduped: 0 }),
    };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** One round-trip of a support-style agent turn through the emitter. */
async function runHarness(emitter: EvalEmitter): Promise<void> {
  // 1. The agent asks the model something (the request messages).
  emitter.enqueueInteraction({
    id: "selfcheck-turn-1",
    model: "anthropic/claude-4.7-opus",
    provider: "anthropic",
    messages: [
      { role: "system", content: "You are a support agent." },
      { role: "user", content: "Where is my order?" },
    ],
    // 2. The model's response: a tool call, its result, and the final answer.
    content: "Your order shipped yesterday and arrives Thursday.",
    toolCalls: [{ id: "call-1", name: "lookup_order", arguments: { order_id: "O-42" } }],
    toolResults: [{ tool_call_id: "call-1", name: "lookup_order", result: { status: "shipped" } }],
    usage: { input_tokens: 210, output_tokens: 34, cost_usd: 0.004, duration_ms: 1180 },
    metadata: { prompt_version: "v7" },
  });

  // 3. Drain on shutdown so nothing is lost.
  const result = await emitter.close();
  if (!result.ok) throw new Error(`emit failed: ${String(result.error)}`);
}

export async function main(): Promise<number> {
  // Live only when explicitly enabled + configured; otherwise a local mock.
  const live = emitterFromEnv();
  if (live.enabled) {
    process.stdout.write("Live tracing enabled — emitting to the configured endpoint.\n");
    await runHarness(live);
    process.stdout.write(`Status: ${JSON.stringify(live.status())}\n`);
    return 0;
  }

  const { fetchImpl, calls } = mockFetch();
  const emitter = createEmitter({
    endpoint: "https://mock.invalid/ingest/v1/traces",
    token: "selfcheck-token",
    product: "selfcheck",
    harness: { name: "selfcheck-harness", version: "1", sdk: "blindbench-live-emitter" },
    fetchImpl,
  });
  await runHarness(emitter);

  const status = emitter.status();
  // Deterministic assertions — the selfcheck fails loudly if the contract breaks.
  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`selfcheck failed: ${msg}`);
  };
  assert(calls.length === 1, "exactly one batch POSTed");
  const batch = calls[0] as { records: unknown[] };
  assert(batch.records.length === 1, "one record in the batch");
  assert(status.sent === 1, "one record marked sent");
  assert(status.dropped === 0, "nothing dropped");
  assert(status.pending === 0, "queue drained");

  process.stdout.write("liveEmitter selfcheck OK (mock fetch, no network).\n");
  process.stdout.write(`Status: ${JSON.stringify(status)}\n`);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`${String(err)}\n`);
      process.exit(1);
    });
}
