import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeEvalRecordV1 } from "./agentTrace";
import {
  createEmitter,
  emitterFromEnv,
  interactionToRecord,
  type EmitterConfig,
  type FlushResult,
  type ModelInteraction,
} from "./liveEmitter";

/** A `fetch` stub that always 200s and records the JSON bodies it received. */
function okFetch() {
  const bodies: Array<{ records: unknown[] }> = [];
  const fetchImpl = vi.fn(async (_url: string, init?: { body?: string }) => {
    bodies.push(JSON.parse(init?.body ?? "{}"));
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies };
}

const baseCfg = (over: Partial<EmitterConfig> = {}): EmitterConfig => ({
  endpoint: "https://x.invalid/ingest/v1/traces",
  token: "tok",
  flushIntervalMs: 0, // tests drive flushing explicitly unless they opt into timers
  ...over,
});

const interaction: ModelInteraction = {
  id: "t1",
  model: "gpt-4",
  provider: "openai",
  messages: [{ role: "user", content: "hi" }],
  content: "hello",
  toolCalls: [{ id: "c1", name: "calc", arguments: { a: 1 } }],
  toolResults: [{ tool_call_id: "c1", name: "calc", result: 2 }],
  usage: { input_tokens: 3, output_tokens: 1 },
};

afterEach(() => vi.useRealTimers());

describe("interactionToRecord mapping", () => {
  it("produces an EvalRecordV1 the real normalizer accepts", () => {
    const rec = interactionToRecord(interaction, {
      product: "svc",
      harness: { name: "h", sdk: "blindbench-live-emitter" },
    });
    expect(rec.version).toBe("1");
    expect(rec.product).toBe("svc");
    // Round-trip through the wire normalizer — proves field mapping is correct.
    const trace = normalizeEvalRecordV1(rec);
    expect(trace.run_id).toBe("t1");
    expect(trace.final_answer).toBe("hello");
    expect(trace.steps.map((s) => s.type)).toEqual([
      "message",
      "message",
      "tool_call",
      "tool_result",
    ]);
    expect(trace.usage.total_tokens).toBe(4);
  });

  it("omits output when there is no content, tool call, or result", () => {
    const rec = interactionToRecord({ messages: [{ role: "user", content: "q" }] });
    expect(rec.output).toBeUndefined();
    expect(() => normalizeEvalRecordV1(rec)).not.toThrow();
  });

  it("interaction fields override emitter defaults", () => {
    const rec = interactionToRecord({ ...interaction, product: "own" }, { product: "default" });
    expect(rec.product).toBe("own");
  });
});

describe("batching", () => {
  it("flushes automatically when maxBatchSize is reached", async () => {
    const { fetchImpl, bodies } = okFetch();
    const e = createEmitter(baseCfg({ maxBatchSize: 2, fetchImpl }));
    e.enqueueInteraction(interaction);
    expect(bodies.length).toBe(0); // under the threshold, nothing sent yet
    e.enqueueInteraction(interaction);
    await vi.waitFor(() => expect(bodies.length).toBe(1));
    await vi.waitFor(() => expect(e.status().sent).toBe(2));
    expect(bodies[0]?.records).toHaveLength(2);
    expect(e.status().pending).toBe(0);
  });

  it("never sends a batch larger than maxBatchSize", async () => {
    const { fetchImpl, bodies } = okFetch();
    const e = createEmitter(baseCfg({ maxBatchSize: 2, fetchImpl }));
    for (let i = 0; i < 3; i++) e.enqueueInteraction(interaction);
    await e.close();
    // 3 records with cap 2 → an auto-flush of 2 then a drain of 1; no batch > 2.
    expect(bodies.every((b) => b.records.length <= 2)).toBe(true);
    expect(bodies.reduce((n, b) => n + b.records.length, 0)).toBe(3);
    expect(e.status().sent).toBe(3);
  });

  it("flushes a partial queue on the timer", async () => {
    vi.useFakeTimers();
    const { fetchImpl, bodies } = okFetch();
    const e = createEmitter(baseCfg({ maxBatchSize: 10, flushIntervalMs: 1000, fetchImpl }));
    e.enqueueInteraction(interaction);
    expect(bodies.length).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(bodies.length).toBe(1);
    expect(e.status().sent).toBe(1);
  });
});

describe("disabled / no-op", () => {
  it("emitterFromEnv returns a no-op when tracing is not enabled", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const e = emitterFromEnv(
      { fetchImpl },
      { BLINDBENCH_INGEST_URL: "https://x.invalid/i", BLINDBENCH_INGEST_TOKEN: "t" },
    );
    expect(e.enabled).toBe(false);
    e.enqueueInteraction(interaction);
    expect(await e.flush()).toMatchObject({ ok: true, sent: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(e.status().enqueued).toBe(0);
  });

  it("emitterFromEnv returns a no-op when enabled but URL/token missing", () => {
    expect(emitterFromEnv({}, { BLINDBENCH_TRACE_ENABLED: "true" }).enabled).toBe(false);
  });

  it("emitterFromEnv returns a live emitter when enabled + configured", () => {
    const e = emitterFromEnv(
      {},
      {
        BLINDBENCH_TRACE_ENABLED: "true",
        BLINDBENCH_INGEST_URL: "https://x.invalid/i",
        BLINDBENCH_INGEST_TOKEN: "t",
      },
    );
    expect(e.enabled).toBe(true);
  });
});

describe("graceful degradation", () => {
  it("swallows a network rejection: enqueue never throws, drop is counted", async () => {
    const onError = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const e = createEmitter(baseCfg({ maxRetries: 1, fetchImpl, onError }));
    expect(() => e.enqueueInteraction(interaction)).not.toThrow();
    const res = await e.flush();
    expect(res.ok).toBe(false);
    expect(res.dropped).toBe(1);
    expect(e.status().dropped).toBe(1);
    expect(e.status().failedBatches).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
    // maxRetries:1 → 2 total attempts.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 4xx (bad token) — fails fast, one attempt", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401 }) as unknown as Response) as unknown as typeof fetch;
    const e = createEmitter(baseCfg({ maxRetries: 3, fetchImpl }));
    e.enqueueInteraction(interaction);
    const res = await e.flush();
    expect(res.dropped).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a 5xx up to maxRetries then drops", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 }) as unknown as Response) as unknown as typeof fetch;
    const e = createEmitter(baseCfg({ maxRetries: 2, fetchImpl }));
    e.enqueueInteraction(interaction);
    await e.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(3); // 1 + 2 retries
  });

  it("close() waits for an in-flight auto-flush before resolving", async () => {
    // Exactly maxBatchSize records: the auto-flush drains the whole queue, so a
    // close() that only re-flushed would see nothing pending and resolve early.
    const bodies: Array<{ records: unknown[] }> = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchImpl = vi.fn(async (_url: string, init?: { body?: string }) => {
      await gate; // hold the POST open like a slow network
      bodies.push(JSON.parse(init?.body ?? "{}"));
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const e = createEmitter(baseCfg({ maxBatchSize: 2, fetchImpl }));
    e.enqueueInteraction(interaction);
    e.enqueueInteraction(interaction); // triggers fire-and-forget auto-flush

    let closed: FlushResult | null = null;
    const closing = e.close().then((res) => (closed = res));
    await Promise.resolve(); // give close() a chance to (wrongly) resolve early
    expect(closed).toBeNull(); // must still be waiting on the in-flight POST

    release();
    await closing;
    expect(bodies.reduce((n, b) => n + b.records.length, 0)).toBe(2);
    expect(closed).toMatchObject({ ok: true, sent: 2 });
    expect(e.status().sent).toBe(2);
  });

  it("close() reports a failed in-flight auto-flush in its result", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const e = createEmitter(baseCfg({ maxBatchSize: 1, maxRetries: 0, fetchImpl }));
    e.enqueueInteraction(interaction); // auto-flush fires and will fail
    const res = await e.close();
    expect(res.ok).toBe(false);
    expect(res.dropped).toBe(1);
  });

  it("close() drains remaining records", async () => {
    const { fetchImpl, bodies } = okFetch();
    const e = createEmitter(baseCfg({ maxBatchSize: 100, fetchImpl }));
    e.enqueueInteraction(interaction);
    e.enqueueInteraction(interaction);
    const res = await e.close();
    expect(res.sent).toBe(2);
    expect(bodies).toHaveLength(1);
    expect(e.status().pending).toBe(0);
  });
});
