/**
 * OpenRouter streaming HTTP client.
 * Uses fetch() + ReadableStream (available in Convex default runtime).
 */

export type MessageContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    >;

export interface OpenRouterMessage {
  role: "system" | "developer" | "user" | "assistant";
  content: MessageContent;
}

export interface StreamUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface StreamCallbackArgs {
  chunk: string;
  done: boolean;
  usage?: StreamUsage;
}

interface StreamParams {
  apiKey: string;
  model: string;
  messages: OpenRouterMessage[];
  temperature: number;
  maxTokens?: number;
  onChunk: (args: StreamCallbackArgs) => Promise<void>;
}

// Caps on how long a single slot can wait on OpenRouter before we give up.
// Without these the action holds open until the Convex platform timeout
// (~10 min), leaving the run "Running" with no recovery path.
const STREAM_OVERALL_TIMEOUT_MS = 180_000;
const STREAM_INACTIVITY_TIMEOUT_MS = 30_000;

export async function streamChatCompletion(params: StreamParams): Promise<void> {
  const { apiKey, model, messages, temperature, maxTokens, onChunk } = params;

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (maxTokens !== undefined) {
    body.max_tokens = maxTokens;
  }

  const controller = new AbortController();
  let abortReason: string | null = null;
  const overallTimer = setTimeout(() => {
    abortReason = `OpenRouter request exceeded ${STREAM_OVERALL_TIMEOUT_MS / 1000}s overall timeout`;
    controller.abort();
  }, STREAM_OVERALL_TIMEOUT_MS);
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  const armInactivityTimer = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      abortReason = `OpenRouter stream silent for ${STREAM_INACTIVITY_TIMEOUT_MS / 1000}s`;
      controller.abort();
    }, STREAM_INACTIVITY_TIMEOUT_MS);
  };

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://blindbench.dev",
        "X-Title": "Blind Bench",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error("OpenRouter rejected your API key");
      }
      if (response.status === 429) {
        throw new Error("OpenRouter rate limit exceeded. Try again in a moment.");
      }
      const text = await response.text().catch(() => "");
      throw new Error(`OpenRouter error: ${response.status} ${response.statusText}${text ? ` — ${text.slice(0, 200)}` : ""}`);
    }

    if (!response.body) {
      throw new Error("OpenRouter returned no response body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let usage: StreamUsage | undefined;

    armInactivityTimer();
    try {
      while (true) {
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } catch (err) {
          if (abortReason) throw new Error(abortReason);
          throw err;
        }
        if (result.done) break;
        armInactivityTimer();

        buffer += decoder.decode(result.value, { stream: true });

        // Process complete SSE lines
        const lines = buffer.split("\n");
        // Keep the last (possibly incomplete) line in the buffer
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(":")) continue;

          if (!trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);

          if (data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data) as {
              choices?: Array<{
                delta?: { content?: string };
                finish_reason?: string | null;
              }>;
              usage?: {
                prompt_tokens?: number;
                completion_tokens?: number;
                total_tokens?: number;
              };
            };

            // Capture usage from any chunk that has it
            if (parsed.usage) {
              usage = {
                promptTokens: parsed.usage.prompt_tokens ?? 0,
                completionTokens: parsed.usage.completion_tokens ?? 0,
                totalTokens: parsed.usage.total_tokens ?? 0,
              };
            }

            const choice = parsed.choices?.[0];
            const content = choice?.delta?.content;
            if (content) {
              await onChunk({ chunk: content, done: false });
            }
          } catch {
            // Skip malformed JSON lines
          }
        }
      }
    } finally {
      try { await reader.cancel(); } catch { /* ignore */ }
    }

    // Flush any remaining buffer
    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith("data: ") && trimmed.slice(6) !== "[DONE]") {
        try {
          const parsed = JSON.parse(trimmed.slice(6)) as {
            usage?: {
              prompt_tokens?: number;
              completion_tokens?: number;
              total_tokens?: number;
            };
          };
          if (parsed.usage) {
            usage = {
              promptTokens: parsed.usage.prompt_tokens ?? 0,
              completionTokens: parsed.usage.completion_tokens ?? 0,
              totalTokens: parsed.usage.total_tokens ?? 0,
            };
          }
        } catch {
          // ignore
        }
      }
    }

    // Signal completion
    await onChunk({ chunk: "", done: true, usage });
  } catch (err) {
    if (abortReason) throw new Error(abortReason);
    throw err;
  } finally {
    clearTimeout(overallTimer);
    if (inactivityTimer) clearTimeout(inactivityTimer);
  }
}

/**
 * Non-streaming chat completion for use cases that need the full response
 * (e.g. optimizer JSON parsing). Supports response_format for JSON mode.
 */
interface ChatCompletionParams {
  apiKey: string;
  model: string;
  messages: OpenRouterMessage[];
  temperature: number;
  maxTokens?: number;
  responseFormat?: { type: "json_object" };
}

interface ChatCompletionResult {
  content: string;
  usage: StreamUsage;
}

export async function chatCompletion(
  params: ChatCompletionParams,
): Promise<ChatCompletionResult> {
  const { apiKey, model, messages, temperature, maxTokens, responseFormat } =
    params;

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature,
    stream: false,
  };
  if (maxTokens !== undefined) {
    body.max_tokens = maxTokens;
  }
  if (responseFormat) {
    body.response_format = responseFormat;
  }

  const response = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://blindbench.dev",
        "X-Title": "Blind Bench",
      },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("OpenRouter rejected your API key");
    }
    if (response.status === 429) {
      throw new Error(
        "OpenRouter rate limit exceeded. Try again in a moment.",
      );
    }
    const text = await response.text().catch(() => "");
    throw new Error(
      `OpenRouter error: ${response.status} ${response.statusText}${text ? ` — ${text.slice(0, 200)}` : ""}`,
    );
  }

  const data = (await response.json()) as {
    choices?: Array<{
      message?: { content?: string };
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenRouter returned an empty response");
  }

  return {
    content,
    usage: {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      totalTokens: data.usage?.total_tokens ?? 0,
    },
  };
}
