/**
 * Thin HTTP client around the Blind Bench /api/v1/* surface.
 *
 * Every method maps one-to-one to a route in convex/http.ts. If a route
 * changes shape, this client and the matching tool definition in tools.ts
 * must change in lockstep.
 */

export interface BlindBenchConfig {
  apiBase: string; // e.g. https://your-deployment.convex.site
  token: string; // bbst_live_… or bbst_test_…
  fetchImpl?: typeof fetch;
}

export class BlindBenchApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(
      typeof body === "object" && body && "error" in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${status}`,
    );
    this.name = "BlindBenchApiError";
  }
}

export class BlindBenchClient {
  private apiBase: string;
  private token: string;
  private fetchImpl: typeof fetch;

  constructor(config: BlindBenchConfig) {
    this.apiBase = config.apiBase.replace(/\/$/, "");
    this.token = config.token;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    options: { body?: unknown; query?: Record<string, string | undefined> } = {},
  ): Promise<T> {
    const url = new URL(`${this.apiBase}${path}`);
    if (options.query) {
      for (const [k, v] of Object.entries(options.query)) {
        if (v !== undefined) url.searchParams.set(k, v);
      }
    }
    const res = await this.fetchImpl(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { error: text };
      }
    }
    if (!res.ok) throw new BlindBenchApiError(res.status, parsed);
    return parsed as T;
  }

  // --- Phase 1: Authoring ---

  createVersion(input: {
    systemMessage?: string;
    userMessageTemplate: string;
    parentVersionId?: string;
  }): Promise<{ versionId: string }> {
    return this.request("POST", "/api/v1/versions", { body: input });
  }

  startRun(input: {
    versionId: string;
    testCaseId?: string;
    inlineVariables?: Record<string, string>;
    model: string;
    temperature: number;
    maxTokens?: number;
    mode?: "uniform" | "mix";
    slotConfigs?: { label: string; model: string; temperature: number }[];
  }): Promise<{ runId: string }> {
    return this.request("POST", "/api/v1/runs", { body: input });
  }

  getRun(runId: string): Promise<RunSnapshot> {
    return this.request("GET", "/api/v1/runs/get", { query: { id: runId } });
  }

  // --- Phase 2: Review cycles ---

  createCycle(input: {
    name: string;
    primaryVersionId: string;
    sourceRunIds: string[];
    evaluatorUserIds?: string[];
    includeSoloEval?: boolean;
    open?: boolean;
  }): Promise<{
    cycleId: string;
    outputCount: number;
    evaluatorCount: number;
    cycleEvalToken: string | null;
  }> {
    return this.request("POST", "/api/v1/cycles", { body: input });
  }

  getCycleFeedback(cycleId: string): Promise<CycleFeedbackSummary> {
    return this.request("GET", "/api/v1/cycles/feedback", {
      query: { id: cycleId },
    });
  }

  // --- Phase 3: Agent-as-evaluator ---

  getEvalTask(cycleId: string): Promise<CycleEvalTask> {
    return this.request("GET", "/api/v1/cycles/eval-task", {
      query: { id: cycleId },
    });
  }

  submitEvaluation(input: {
    cycleId: string;
    ratings: { cycleBlindLabel: string; rating: "best" | "acceptable" | "weak" }[];
    annotations?: {
      cycleBlindLabel: string;
      from: number;
      to: number;
      highlightedText: string;
      comment: string;
      tags?: string[];
    }[];
  }): Promise<{ ratingsApplied: number; annotationsApplied: number }> {
    return this.request("POST", "/api/v1/cycles/evaluations", { body: input });
  }
}

export interface RunSnapshot {
  runId: string;
  status: "pending" | "running" | "completed" | "failed";
  versionId: string;
  versionNumber: number | null;
  testCaseId: string | null;
  model: string;
  temperature: number;
  mode: "uniform" | "mix" | null;
  startedAt: number | null;
  completedAt: number | null;
  errorMessage: string | null;
  outputs: {
    outputId: string;
    blindLabel: string;
    outputContent: string;
    model: string | null;
    temperature: number | null;
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    latencyMs: number | null;
  }[];
}

export interface CycleFeedbackSummary {
  cycleId: string;
  status: "draft" | "open" | "closed";
  outputs: {
    cycleBlindLabel: string;
    sourceVersionId: string;
    versionNumber: number | null;
    bestCount: number;
    acceptableCount: number;
    weakCount: number;
    bySource: {
      evaluator: number;
      anonymous: number;
      solo: number;
      author: number;
    };
    byEvaluatorType: { human: number; agent: number };
    annotations: {
      from: number;
      to: number;
      highlightedText: string;
      comment: string;
      tags: string[];
      source: "evaluator" | "anonymous" | "solo" | "author";
      evaluatorType: "human" | "agent";
      createdAt: number;
    }[];
  }[];
}

export interface CycleEvalTask {
  cycleId: string;
  cycleName: string;
  outputs: {
    cycleBlindLabel: string;
    outputContentSnapshot: string;
  }[];
}
