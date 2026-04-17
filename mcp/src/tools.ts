/**
 * MCP tool definitions — one tool per public /api/v1/* endpoint.
 *
 * Keep tool names stable. Adding new fields to a tool input is safe;
 * removing or renaming requires bumping the API version note in CLAUDE.md.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BlindBenchClient } from "./client.js";

const slotConfigSchema = z.object({
  label: z.string().describe("A | B | C | D | E (in order)"),
  model: z.string().describe("OpenRouter model id, e.g. openai/gpt-4o"),
  temperature: z.number().min(0).max(2),
});

const ratingSchema = z.object({
  cycleBlindLabel: z.string().describe("A | B | C | … (cycle-scoped label)"),
  rating: z.enum(["best", "acceptable", "weak"]),
});

const annotationSchema = z.object({
  cycleBlindLabel: z.string(),
  from: z.number().int().min(0),
  to: z.number().int().min(0),
  highlightedText: z.string(),
  comment: z.string(),
  tags: z
    .array(
      z.enum([
        "accuracy",
        "tone",
        "length",
        "relevance",
        "safety",
        "format",
        "clarity",
        "other",
      ]),
    )
    .optional(),
});

function ok(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

export function registerTools(
  server: McpServer,
  client: BlindBenchClient,
): void {
  // --- Authoring ---

  server.tool(
    "blindbench_create_version",
    "Create a new draft prompt version in the project this token is scoped to. Returns { versionId } that you can pass to blindbench_start_run.",
    {
      systemMessage: z.string().optional(),
      userMessageTemplate: z
        .string()
        .describe("Use {{variableName}} to interpolate. Unknown variables are auto-created."),
      parentVersionId: z.string().optional(),
    },
    async (args) => ok(await client.createVersion(args)),
  );

  server.tool(
    "blindbench_start_run",
    "Kick off a prompt run (3 outputs in uniform mode, or per-slot in mix mode). Returns { runId }; poll blindbench_get_run for results.",
    {
      versionId: z.string(),
      testCaseId: z.string().optional(),
      inlineVariables: z.record(z.string()).optional(),
      model: z.string().describe("OpenRouter model id"),
      temperature: z.number().min(0).max(2),
      maxTokens: z.number().int().positive().optional(),
      mode: z.enum(["uniform", "mix"]).optional(),
      slotConfigs: z.array(slotConfigSchema).optional(),
    },
    async (args) => ok(await client.startRun(args)),
  );

  server.tool(
    "blindbench_get_run",
    "Fetch a run's current status + streaming outputs. Poll this until status is 'completed' or 'failed'.",
    { runId: z.string() },
    async ({ runId }) => ok(await client.getRun(runId)),
  );

  // --- Review cycles ---

  server.tool(
    "blindbench_create_review_cycle",
    "Create a review cycle from one or more completed runs and (optionally) open it for evaluation. If `evaluatorUserIds` is set, those project evaluators are notified. Returns { cycleId, outputCount, evaluatorCount, cycleEvalToken }.",
    {
      name: z.string(),
      primaryVersionId: z.string(),
      sourceRunIds: z.array(z.string()).min(1),
      evaluatorUserIds: z.array(z.string()).optional(),
      includeSoloEval: z.boolean().optional(),
      open: z
        .boolean()
        .optional()
        .describe("Default true. Set false to leave the cycle in draft."),
    },
    async (args) => ok(await client.createCycle(args)),
  );

  server.tool(
    "blindbench_get_cycle_feedback",
    "Aggregated feedback for a cycle: per-output preference counts split by source (evaluator/anonymous/solo/author) and evaluator type (human/agent), plus all annotations. Use this after evaluators have submitted.",
    { cycleId: z.string() },
    async ({ cycleId }) => ok(await client.getCycleFeedback(cycleId)),
  );

  // --- Agent as evaluator ---

  server.tool(
    "blindbench_get_eval_task",
    "Fetch the BLIND outputs for a cycle so an agent can evaluate them. Returns only cycleBlindLabel + outputContentSnapshot — never source IDs, models, or version numbers. Submit ratings via blindbench_submit_evaluation.",
    { cycleId: z.string() },
    async ({ cycleId }) => ok(await client.getEvalTask(cycleId)),
  );

  server.tool(
    "blindbench_submit_evaluation",
    "Submit ratings (best | acceptable | weak) and optional annotations for a cycle. Submissions made via this tool are tagged evaluatorType=agent so authors can distinguish them from human reviews.",
    {
      cycleId: z.string(),
      ratings: z.array(ratingSchema).min(1),
      annotations: z.array(annotationSchema).optional(),
    },
    async (args) => ok(await client.submitEvaluation(args)),
  );
}
