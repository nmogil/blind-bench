/**
 * Live native eval-record emitter — the client-side capture ergonomics that
 * issue #285 was missing. A running agent/harness constructs one emitter, feeds
 * it normalized model interactions (or raw `EvalRecordV1` records), and the
 * emitter batches them to `POST /ingest/v1/traces` in the background.
 *
 * Design constraints (see docs/live-emitter.md):
 *  - Thin: no npm deps, uses global `fetch`. Node 18+ / browser-compatible.
 *  - Disabled by default: `emitterFromEnv` returns a no-op unless
 *    `BLINDBENCH_TRACE_ENABLED=true` plus URL + token are present.
 *  - Non-throwing on the agent path: `enqueue*` never throws; network/HTTP
 *    failures are swallowed and counted, they never surface into the agent run.
 *  - Explicit `flush()` returns a result you can inspect; `close()` drains.
 *
 * This is a reference emitter, not a packaged SDK — copy or import it.
 */
import type { EvalRecordV1, PrivacyClass } from "./agentTrace.core";

/** A normalized model interaction — the ergonomic input the emitter maps to `EvalRecordV1`. */
export interface ModelInteraction {
  id?: string;
  timestamp?: string;
  model?: string;
  provider?: string;
  /** The request messages sent to the model. Required and non-empty (ingest rejects empty). */
  messages: { role: string; content: string }[];
  /** The assistant's text answer. */
  content?: string;
  toolCalls?: { id?: string; name: string; arguments: Record<string, unknown> }[];
  toolResults?: { tool_call_id: string; name?: string; result?: unknown }[];
  usage?: EvalRecordV1["usage"];
  product?: string;
  module?: string;
  environment?: string;
  metadata?: Record<string, unknown>;
  privacyClass?: PrivacyClass;
}

export interface EmitterConfig {
  /** Full URL, e.g. `https://<deployment>.convex.site/ingest/v1/traces`. */
  endpoint: string;
  /** Per-project ingest token (sent as an Authorization bearer credential). */
  token: string;
  /** Defaults stamped onto every record unless the interaction overrides them. */
  product?: string;
  module?: string;
  environment?: string;
  harness?: { name?: string; version?: string; sdk?: string };
  /** Flush when the queue reaches this many records. Default 20. */
  maxBatchSize?: number;
  /** Flush a partial queue after this idle interval. Default 2000ms. 0 disables the timer. */
  flushIntervalMs?: number;
  /** Extra send attempts after the first on failure. Default 2. */
  maxRetries?: number;
  /** Injectable for tests / custom transports. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Observability hook for dropped batches. Must not throw. */
  onError?: (err: unknown, droppedRecords: number) => void;
}

export interface EmitterStatus {
  enabled: boolean;
  enqueued: number;
  sent: number;
  dropped: number;
  failedBatches: number;
  pending: number;
}

export interface FlushResult {
  ok: boolean;
  sent: number;
  dropped: number;
  batches: number;
  error?: unknown;
}

export interface EvalEmitter {
  readonly enabled: boolean;
  enqueueRecord(record: EvalRecordV1): void;
  enqueueInteraction(interaction: ModelInteraction): void;
  flush(): Promise<FlushResult>;
  close(): Promise<FlushResult>;
  status(): EmitterStatus;
}

/** Map the ergonomic interaction shape onto a wire `EvalRecordV1`. Exported for tests. */
export function interactionToRecord(
  i: ModelInteraction,
  defaults: Pick<EmitterConfig, "product" | "module" | "environment" | "harness"> = {},
): EvalRecordV1 {
  const hasOutput =
    i.content !== undefined ||
    (i.toolCalls && i.toolCalls.length > 0) ||
    (i.toolResults && i.toolResults.length > 0);
  return {
    version: "1",
    id: i.id,
    timestamp: i.timestamp,
    model: i.model,
    provider: i.provider,
    input: { messages: i.messages },
    output: hasOutput
      ? { content: i.content, tool_calls: i.toolCalls, tool_results: i.toolResults }
      : undefined,
    usage: i.usage,
    product: i.product ?? defaults.product,
    module: i.module ?? defaults.module,
    environment: i.environment ?? defaults.environment,
    harness: defaults.harness,
    metadata: i.metadata,
    privacy_class: i.privacyClass,
  };
}

const NOOP_FLUSH: FlushResult = { ok: true, sent: 0, dropped: 0, batches: 0 };

/** The disabled emitter: every method is a no-op. Returned when tracing is off. */
class NoopEmitter implements EvalEmitter {
  readonly enabled = false;
  enqueueRecord(): void {}
  enqueueInteraction(): void {}
  async flush(): Promise<FlushResult> {
    return NOOP_FLUSH;
  }
  async close(): Promise<FlushResult> {
    return NOOP_FLUSH;
  }
  status(): EmitterStatus {
    return { enabled: false, enqueued: 0, sent: 0, dropped: 0, failedBatches: 0, pending: 0 };
  }
}

class LiveEmitter implements EvalEmitter {
  readonly enabled = true;
  private queue: EvalRecordV1[] = [];
  private inFlight: Promise<FlushResult> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private counts = { enqueued: 0, sent: 0, dropped: 0, failedBatches: 0 };
  private readonly maxBatchSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: EmitterConfig) {
    this.maxBatchSize = Math.max(1, cfg.maxBatchSize ?? 20);
    this.flushIntervalMs = cfg.flushIntervalMs ?? 2000;
    this.maxRetries = Math.max(0, cfg.maxRetries ?? 2);
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  enqueueRecord(record: EvalRecordV1): void {
    this.queue.push(record);
    this.counts.enqueued++;
    if (this.queue.length >= this.maxBatchSize) {
      // Fire-and-forget: flush() is internally non-throwing, but attach a catch
      // so a rejected promise can never bubble as an unhandledRejection.
      void this.flush().catch(() => {});
    } else {
      this.scheduleTimer();
    }
  }

  enqueueInteraction(interaction: ModelInteraction): void {
    this.enqueueRecord(interactionToRecord(interaction, this.cfg));
  }

  async flush(): Promise<FlushResult> {
    this.clearTimer();
    // Serialize behind any in-flight flush so records send in order and a
    // fire-and-forget auto-flush can never be orphaned by close().
    const prev = this.inFlight ?? Promise.resolve(NOOP_FLUSH);
    const run = prev.then(() => this.drainAndSend());
    this.inFlight = run;
    try {
      return await run;
    } finally {
      if (this.inFlight === run) this.inFlight = null;
    }
  }

  private async drainAndSend(): Promise<FlushResult> {
    const drained = this.queue.splice(0, this.queue.length);
    if (drained.length === 0) return { ...NOOP_FLUSH };

    let sent = 0;
    let dropped = 0;
    let batches = 0;
    let firstError: unknown;
    for (let i = 0; i < drained.length; i += this.maxBatchSize) {
      const batch = drained.slice(i, i + this.maxBatchSize);
      batches++;
      const err = await this.sendBatch(batch);
      if (err === undefined) {
        sent += batch.length;
        this.counts.sent += batch.length;
      } else {
        dropped += batch.length;
        this.counts.dropped += batch.length;
        this.counts.failedBatches++;
        if (firstError === undefined) firstError = err;
        this.cfg.onError?.(err, batch.length);
      }
    }
    return { ok: dropped === 0, sent, dropped, batches, error: firstError };
  }

  async close(): Promise<FlushResult> {
    this.clearTimer();
    // Fold the in-flight flush into the result so a caller checking `ok`
    // sees failures from the auto-flush close() had to wait for.
    const prev = this.inFlight ? await this.inFlight : { ...NOOP_FLUSH };
    const rest = await this.flush();
    return {
      ok: prev.ok && rest.ok,
      sent: prev.sent + rest.sent,
      dropped: prev.dropped + rest.dropped,
      batches: prev.batches + rest.batches,
      error: prev.error ?? rest.error,
    };
  }

  status(): EmitterStatus {
    return { enabled: true, ...this.counts, pending: this.queue.length };
  }

  /** POST one batch with retries. Returns `undefined` on success, else the last error. */
  private async sendBatch(batch: EvalRecordV1[]): Promise<unknown> {
    let lastError: unknown;
    // ponytail: immediate retries, no backoff. Add exponential delay if a real
    // backend starts rate-limiting the emitter under load.
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await this.fetchImpl(this.cfg.endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.cfg.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ records: batch }),
        });
        if (res.ok) return undefined;
        // 4xx (bad token, bad request) won't fix on retry — fail fast.
        if (res.status < 500) return new Error(`ingest rejected: HTTP ${res.status}`);
        lastError = new Error(`ingest error: HTTP ${res.status}`);
      } catch (err) {
        lastError = err;
      }
    }
    return lastError ?? new Error("ingest failed");
  }

  private scheduleTimer(): void {
    if (this.timer !== null || this.flushIntervalMs <= 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch(() => {});
    }, this.flushIntervalMs);
    // Don't keep a Node process alive just for a pending flush.
    (this.timer as { unref?: () => void }).unref?.();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/** Construct a live emitter directly (config already resolved). */
export function createEmitter(cfg: EmitterConfig): EvalEmitter {
  return new LiveEmitter(cfg);
}

type Env = Record<string, string | undefined>;

function processEnv(): Env {
  return typeof process !== "undefined" && process.env ? process.env : {};
}

/**
 * The default entry point. Returns a live emitter ONLY when tracing is explicitly
 * enabled and an endpoint + token are configured; otherwise a no-op. Disabled by
 * default so importing this never sends anything until the operator opts in.
 *
 * Env vars (all overridable via `overrides`):
 *  - BLINDBENCH_TRACE_ENABLED   must equal "true"
 *  - BLINDBENCH_INGEST_URL      full /ingest/v1/traces URL
 *  - BLINDBENCH_INGEST_TOKEN    per-project ingest token
 *  - BLINDBENCH_PRODUCT / BLINDBENCH_MODULE / BLINDBENCH_ENVIRONMENT  (optional grouping)
 */
export function emitterFromEnv(
  overrides: Partial<EmitterConfig> = {},
  env: Env = processEnv(),
): EvalEmitter {
  const enabled = (env.BLINDBENCH_TRACE_ENABLED ?? "").toLowerCase() === "true";
  const endpoint = overrides.endpoint ?? env.BLINDBENCH_INGEST_URL;
  const token = overrides.token ?? env.BLINDBENCH_INGEST_TOKEN;
  if (!enabled || !endpoint || !token) return new NoopEmitter();
  // Spread overrides first (maxBatchSize, harness, fetchImpl, onError…), then the
  // env-resolved fields so a missing override key never clobbers an env value.
  return new LiveEmitter({
    ...overrides,
    endpoint,
    token,
    product: overrides.product ?? env.BLINDBENCH_PRODUCT,
    module: overrides.module ?? env.BLINDBENCH_MODULE,
    environment: overrides.environment ?? env.BLINDBENCH_ENVIRONMENT,
  });
}
