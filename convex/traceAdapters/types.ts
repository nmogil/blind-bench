/**
 * M22 — Trace Import: common intermediate shape produced by every provider
 * adapter (Langfuse, PostHog, PromptLayer, manual_paste). The importer
 * consumes ParsedTrace and decides how to materialize it (new prompt version,
 * completed run output, or both).
 *
 * Shape rules:
 * - Messages follow the M18+ canonical role/content discriminated union, with
 *   user content broadened to support multimodal blocks (text + image_url) for
 *   M21 image-variable parity.
 * - rawPayload is preserved verbatim so adapter improvements can re-parse
 *   without re-fetching from the upstream provider.
 */

export type TraceMessageContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    >;

export type TraceMessage =
  | {
      role: "system" | "developer";
      content: string;
    }
  | {
      role: "user";
      content: TraceMessageContent;
    }
  | {
      role: "assistant";
      content?: TraceMessageContent;
      // Tool call payload from the provider, if present. Adapters pass this
      // through opaquely; the importer doesn't yet round-trip tool calls into
      // the prompt version representation.
      toolCalls?: unknown;
    }
  | {
      role: "tool";
      content: string;
      toolCallId?: string;
      name?: string;
    };

export interface ToolDef {
  name: string;
  description?: string;
  // JSON Schema as supplied by the provider — pass-through, not validated.
  parameters?: unknown;
}

export interface GenerationParams {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
}

export type TraceSource =
  | "langfuse"
  | "posthog"
  | "promptlayer"
  | "manual_paste"
  | "cloudflare_ai_gateway";

export interface ParsedTrace {
  source: TraceSource;
  // Provider's stable trace identifier. Combined with `source` it forms the
  // dedup key for the traceImports table. Absent for manual_paste.
  sourceTraceId?: string;
  // Input messages — the prompt as sent to the model.
  messages: TraceMessage[];
  tools?: ToolDef[];
  generationParams?: GenerationParams;
  model: string;
  // Assistant output. Empty when the trace is an in-flight or input-only
  // capture; populated once the run completed.
  outputMessages?: TraceMessage[];
  reasoning?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
  };
  // Original provider payload — persist via the importer so adapter rewrites
  // don't need a network round-trip.
  rawPayload: unknown;
}

export interface TraceAdapter {
  source: TraceSource;
  /**
   * Lightweight check used during paste detection. Should not throw — return
   * false on any structural mismatch and let the next adapter try.
   */
  detect(raw: unknown): boolean;
  /**
   * Strict parse. Throws on malformed input; the importer surfaces the
   * message to the user.
   */
  parse(raw: unknown): ParsedTrace;
}
