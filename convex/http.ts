import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { auth } from "./auth";
import { Id } from "./_generated/dataModel";
import {
  parseBearer,
  hashToken,
  requireScopes,
  type Scope,
} from "./lib/serviceAuth";

const http = httpRouter();

auth.addHttpRoutes(http);

// ---------------------------------------------------------------------------
// CORS / response helpers
// ---------------------------------------------------------------------------

const apiCorsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: apiCorsHeaders,
  });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

function preflight() {
  return new Response(null, { status: 204, headers: apiCorsHeaders });
}

// ---------------------------------------------------------------------------
// /api/v1/* — service-token-authenticated public surface
//
// PUBLIC API: every change here is a wire-contract change. Update both
// mcp/ tool definitions and convex/tests/api-contract.test.ts in the same PR.
// ---------------------------------------------------------------------------

type AuthFailure = { ok: false; response: Response };
type AuthSuccess = {
  ok: true;
  tokenContext: {
    tokenId: Id<"serviceTokens">;
    projectId: Id<"projects">;
    userId: Id<"users">;
    scopes: Scope[];
    actorRole: "editor" | "evaluator";
  };
};

async function authenticate(
  ctx: Parameters<Parameters<typeof httpAction>[0]>[0],
  req: Request,
  required: Scope[],
): Promise<AuthSuccess | AuthFailure> {
  const token = parseBearer(req);
  if (!token) {
    return {
      ok: false,
      response: errorResponse("Missing or malformed Bearer token", 401),
    };
  }
  const tokenHash = await hashToken(token);
  let context;
  try {
    context = await ctx.runMutation(internal.serviceTokens.validateAndStamp, {
      tokenHash,
    });
  } catch (e) {
    return {
      ok: false,
      response: errorResponse(
        e instanceof Error ? e.message : "Invalid token",
        401,
      ),
    };
  }
  try {
    requireScopes({ scopes: context.scopes }, required);
  } catch (e) {
    return {
      ok: false,
      response: errorResponse(
        e instanceof Error ? e.message : "Insufficient scopes",
        403,
      ),
    };
  }
  return { ok: true, tokenContext: context };
}

async function safeJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    if (typeof body !== "object" || body === null) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

// --- Phase 1: Authoring ---

http.route({
  path: "/api/v1/versions",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const auth = await authenticate(ctx, req, ["runs:write"]);
    if (!auth.ok) return auth.response;

    const body = await safeJsonBody(req);
    if (!body) return errorResponse("Invalid JSON body", 400);
    if (typeof body.userMessageTemplate !== "string") {
      return errorResponse("userMessageTemplate is required (string)", 400);
    }

    try {
      const result = await ctx.runMutation(internal.api.createVersionForToken, {
        tokenContext: auth.tokenContext,
        systemMessage:
          typeof body.systemMessage === "string" ? body.systemMessage : undefined,
        userMessageTemplate: body.userMessageTemplate,
        parentVersionId: body.parentVersionId as
          | Id<"promptVersions">
          | undefined,
      });
      return jsonResponse(result, 201);
    } catch (e) {
      return errorResponse(e instanceof Error ? e.message : "Bad request", 400);
    }
  }),
});

http.route({
  path: "/api/v1/runs",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const auth = await authenticate(ctx, req, ["runs:write"]);
    if (!auth.ok) return auth.response;

    const body = await safeJsonBody(req);
    if (!body) return errorResponse("Invalid JSON body", 400);

    try {
      const result = await ctx.runMutation(internal.api.startRunForToken, {
        tokenContext: auth.tokenContext,
        versionId: body.versionId as Id<"promptVersions">,
        testCaseId: body.testCaseId as Id<"testCases"> | undefined,
        inlineVariables: body.inlineVariables as
          | Record<string, string>
          | undefined,
        model: body.model as string,
        temperature: body.temperature as number,
        maxTokens: body.maxTokens as number | undefined,
        mode: body.mode as "uniform" | "mix" | undefined,
        slotConfigs: body.slotConfigs as
          | { label: string; model: string; temperature: number }[]
          | undefined,
      });
      return jsonResponse(result, 202);
    } catch (e) {
      return errorResponse(e instanceof Error ? e.message : "Bad request", 400);
    }
  }),
});

http.route({
  path: "/api/v1/runs/get",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const auth = await authenticate(ctx, req, ["runs:read"]);
    if (!auth.ok) return auth.response;

    const url = new URL(req.url);
    const runId = url.searchParams.get("id");
    if (!runId) return errorResponse("Query param 'id' is required", 400);

    try {
      const snapshot = await ctx.runQuery(internal.api.getRunForToken, {
        tokenContext: auth.tokenContext,
        runId: runId as Id<"promptRuns">,
      });
      if (!snapshot) return errorResponse("Run not found", 404);
      return jsonResponse(snapshot);
    } catch (e) {
      return errorResponse(e instanceof Error ? e.message : "Bad request", 400);
    }
  }),
});

// --- Phase 2: Review cycles ---

http.route({
  path: "/api/v1/cycles",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const auth = await authenticate(ctx, req, ["cycles:write"]);
    if (!auth.ok) return auth.response;

    const body = await safeJsonBody(req);
    if (!body) return errorResponse("Invalid JSON body", 400);
    if (typeof body.name !== "string") {
      return errorResponse("name is required (string)", 400);
    }
    if (!Array.isArray(body.sourceRunIds)) {
      return errorResponse("sourceRunIds must be an array", 400);
    }

    try {
      const result = await ctx.runMutation(internal.api.createCycleForToken, {
        tokenContext: auth.tokenContext,
        name: body.name,
        primaryVersionId: body.primaryVersionId as Id<"promptVersions">,
        sourceRunIds: body.sourceRunIds as Id<"promptRuns">[],
        evaluatorUserIds: body.evaluatorUserIds as Id<"users">[] | undefined,
        includeSoloEval: body.includeSoloEval as boolean | undefined,
        open: body.open as boolean | undefined,
      });
      return jsonResponse(result, 201);
    } catch (e) {
      return errorResponse(e instanceof Error ? e.message : "Bad request", 400);
    }
  }),
});

http.route({
  path: "/api/v1/cycles/feedback",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const auth = await authenticate(ctx, req, ["cycles:read"]);
    if (!auth.ok) return auth.response;

    const url = new URL(req.url);
    const cycleId = url.searchParams.get("id");
    if (!cycleId) return errorResponse("Query param 'id' is required", 400);

    try {
      const summary = await ctx.runQuery(internal.api.getCycleFeedbackForToken, {
        tokenContext: auth.tokenContext,
        cycleId: cycleId as Id<"reviewCycles">,
      });
      if (!summary) return errorResponse("Cycle not found", 404);
      return jsonResponse(summary);
    } catch (e) {
      return errorResponse(e instanceof Error ? e.message : "Bad request", 400);
    }
  }),
});

// --- Phase 3: Agent-as-evaluator ---

http.route({
  path: "/api/v1/cycles/eval-task",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const auth = await authenticate(ctx, req, ["evaluator:read"]);
    if (!auth.ok) return auth.response;

    const url = new URL(req.url);
    const cycleId = url.searchParams.get("id");
    if (!cycleId) return errorResponse("Query param 'id' is required", 400);

    try {
      const task = await ctx.runQuery(internal.api.getEvalTaskForToken, {
        tokenContext: auth.tokenContext,
        cycleId: cycleId as Id<"reviewCycles">,
      });
      return jsonResponse(task);
    } catch (e) {
      return errorResponse(e instanceof Error ? e.message : "Bad request", 400);
    }
  }),
});

http.route({
  path: "/api/v1/cycles/evaluations",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const auth = await authenticate(ctx, req, ["evaluator:write"]);
    if (!auth.ok) return auth.response;

    const body = await safeJsonBody(req);
    if (!body) return errorResponse("Invalid JSON body", 400);
    if (!Array.isArray(body.ratings)) {
      return errorResponse("ratings must be an array", 400);
    }

    try {
      const result = await ctx.runMutation(internal.api.submitEvalForToken, {
        tokenContext: auth.tokenContext,
        cycleId: body.cycleId as Id<"reviewCycles">,
        ratings: body.ratings as {
          cycleBlindLabel: string;
          rating: "best" | "acceptable" | "weak";
        }[],
        annotations: body.annotations as
          | {
              cycleBlindLabel: string;
              from: number;
              to: number;
              highlightedText: string;
              comment: string;
              tags?: string[];
            }[]
          | undefined,
      });
      return jsonResponse(result, 201);
    } catch (e) {
      return errorResponse(e instanceof Error ? e.message : "Bad request", 400);
    }
  }),
});

// --- CORS preflight (one OPTIONS handler per path) ---

const PREFLIGHT_PATHS = [
  "/api/v1/versions",
  "/api/v1/runs",
  "/api/v1/runs/get",
  "/api/v1/cycles",
  "/api/v1/cycles/feedback",
  "/api/v1/cycles/eval-task",
  "/api/v1/cycles/evaluations",
];
for (const path of PREFLIGHT_PATHS) {
  http.route({
    path,
    method: "OPTIONS",
    handler: httpAction(async () => preflight()),
  });
}

// ---------------------------------------------------------------------------
// Landing page demo vote endpoints (kept from before)
// ---------------------------------------------------------------------------

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

http.route({
  path: "/api/demo-vote",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const body = await req.json();
    const choice = body.choice;
    if (choice !== "A" && choice !== "B") {
      return new Response(JSON.stringify({ error: "Invalid choice" }), {
        status: 400,
        headers: corsHeaders,
      });
    }
    await ctx.runMutation(internal.demoVotes.castVote, { choice });
    const stats = await ctx.runQuery(internal.demoVotes.getStats);
    return new Response(JSON.stringify(stats), {
      status: 200,
      headers: corsHeaders,
    });
  }),
});

http.route({
  path: "/api/demo-stats",
  method: "GET",
  handler: httpAction(async (ctx) => {
    const stats = await ctx.runQuery(internal.demoVotes.getStats);
    return new Response(JSON.stringify(stats), {
      status: 200,
      headers: corsHeaders,
    });
  }),
});

http.route({
  path: "/api/demo-vote",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, { status: 204, headers: corsHeaders });
  }),
});

http.route({
  path: "/api/demo-stats",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, { status: 204, headers: corsHeaders });
  }),
});

export default http;
