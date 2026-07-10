/**
 * Opaque-token boundary for blind trajectory review. Reviewer-facing clients
 * use only these functions; raw Convex trace/matchup IDs never cross the wire.
 */
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import {
  action,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireAuth } from "./lib/auth";
import { blindStepView, blindTraceView } from "./lib/blindProjection";

const LABEL = v.union(
  v.literal("suggestion"),
  v.literal("issue"),
  v.literal("praise"),
  v.literal("question"),
  v.literal("nitpick"),
  v.literal("thought"),
);
const TAG = v.union(
  v.literal("accuracy"),
  v.literal("tone"),
  v.literal("length"),
  v.literal("relevance"),
  v.literal("safety"),
  v.literal("format"),
  v.literal("clarity"),
  v.literal("other"),
);
const TARGET = v.union(
  v.object({ kind: v.literal("trace") }),
  v.object({ kind: v.literal("step"), stepIndex: v.number() }),
  v.object({ kind: v.literal("tool_call"), stepIndex: v.number() }),
);
const RATING = v.union(v.literal("best"), v.literal("acceptable"), v.literal("weak"));
const WINNER = v.union(v.literal("left"), v.literal("right"), v.literal("tie"), v.literal("skip"));
const SIDE = v.union(v.literal("left"), v.literal("right"));

type ReadCtx = QueryCtx | MutationCtx;

async function sessionForUser(
  ctx: ReadCtx,
  token: string,
): Promise<Doc<"agentTraceReviewSessions">> {
  const userId = await requireAuth(ctx);
  const session = await ctx.db
    .query("agentTraceReviewSessions")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();
  if (!session || session.reviewerUserId !== userId) {
    throw new Error("Review session not found or expired.");
  }
  const collaborator = await ctx.db
    .query("projectCollaborators")
    .withIndex("by_project_and_user", (q) =>
      q.eq("projectId", session.projectId).eq("userId", userId),
    )
    .unique();
  if (!collaborator || collaborator.role !== "evaluator" || collaborator.blindMode === false) {
    throw new Error("Review session not found or expired.");
  }
  return session;
}

async function traceSession(
  ctx: ReadCtx,
  token: string,
): Promise<{
  readonly session: Doc<"agentTraceReviewSessions">;
  readonly trace: Doc<"agentTraces">;
  readonly userId: Id<"users">;
}> {
  const session = await sessionForUser(ctx, token);
  if (session.kind !== "trace" || session.agentTraceId === undefined) {
    throw new Error("This review link is not a trajectory session.");
  }
  const trace = await ctx.db.get(session.agentTraceId);
  if (!trace || trace.projectId !== session.projectId) {
    throw new Error("Review trajectory is no longer available.");
  }
  return { session, trace, userId: session.reviewerUserId };
}

async function matchupSession(
  ctx: ReadCtx,
  token: string,
): Promise<{
  readonly session: Doc<"agentTraceReviewSessions">;
  readonly matchup: Doc<"agentTraceMatchups">;
  readonly userId: Id<"users">;
}> {
  const session = await sessionForUser(ctx, token);
  if (session.kind !== "matchup" || session.matchupId === undefined) {
    throw new Error("This review link is not a matchup session.");
  }
  const matchup = await ctx.db.get(session.matchupId);
  if (!matchup || matchup.projectId !== session.projectId) {
    throw new Error("Review matchup is no longer available.");
  }
  return { session, matchup, userId: session.reviewerUserId };
}

/** List the caller's opaque trajectory and matchup review sessions. */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireAuth(ctx);
    const sessions = await ctx.db
      .query("agentTraceReviewSessions")
      .withIndex("by_reviewer", (q) => q.eq("reviewerUserId", userId))
      .order("desc")
      .take(200);
    const allowedProjects = new Map<Id<"projects">, boolean>();
    const rows: Array<{
      readonly token: string;
      readonly kind: "trace" | "matchup";
      readonly projectName: string;
      readonly status: string;
      readonly stepCount?: number;
      readonly createdAt: number;
    }> = [];
    for (const session of sessions) {
      let allowed = allowedProjects.get(session.projectId);
      if (allowed === undefined) {
        const collaborator = await ctx.db
          .query("projectCollaborators")
          .withIndex("by_project_and_user", (q) =>
            q.eq("projectId", session.projectId).eq("userId", userId),
          )
          .unique();
        allowed = collaborator?.role === "evaluator" && collaborator.blindMode !== false;
        allowedProjects.set(session.projectId, allowed);
      }
      if (!allowed) continue;
      const project = await ctx.db.get(session.projectId);
      if (session.kind === "trace" && session.agentTraceId !== undefined) {
        const trace = await ctx.db.get(session.agentTraceId);
        if (!trace || trace.status !== "ready") continue;
        rows.push({
          token: session.token,
          kind: "trace",
          projectName: project?.name ?? "Project",
          status: trace.status,
          stepCount: trace.stepCount,
          createdAt: session._creationTime,
        });
      } else if (session.kind === "matchup" && session.matchupId !== undefined) {
        const matchup = await ctx.db.get(session.matchupId);
        if (!matchup || matchup.comparabilityStatus !== "valid") continue;
        rows.push({
          token: session.token,
          kind: "matchup",
          projectName: project?.name ?? "Project",
          status: "ready",
          createdAt: session._creationTime,
        });
      }
    }
    return rows;
  },
});

/** Return blind-projected parent metadata for one opaque trajectory session. */
export const getTrace = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const { session, trace } = await traceSession(ctx, args.token);
    const project = await ctx.db.get(session.projectId);
    const projected = blindTraceView({
      _id: "",
      projectName: project?.name ?? "Project",
      traceId: trace.traceId,
      product: trace.product,
      module: trace.module,
      environment: trace.environment,
      status: trace.status,
      stepCount: trace.stepCount,
      privacyClass: trace.privacyClass,
      model: trace.model,
      harnessName: trace.harnessName,
      harnessVersion: trace.harnessVersion,
      usage: {
        costUsd: trace.costUsd,
        durationMs: trace.durationMs,
        totalTokens: trace.totalTokens,
      },
      hasFinalAnswer: trace.finalAnswerBlindStorageId !== undefined,
    });
    return {
      projectName: projected.projectName,
      status: projected.status,
      stepCount: projected.stepCount,
      privacyClass: projected.privacyClass,
      usage: projected.usage,
      hasFinalAnswer: projected.hasFinalAnswer,
    };
  },
});

/** Page blind-projected steps by opaque trajectory session token. */
export const listSteps = query({
  args: { token: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const { trace } = await traceSession(ctx, args.token);
    const result = await ctx.db
      .query("agentTraceSteps")
      .withIndex("by_trace_and_index", (q) => q.eq("agentTraceId", trace._id))
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.map((row) =>
        blindStepView({
          stepIndex: row.stepIndex,
          kind: row.kind,
          role: row.role,
          toolName: row.toolName,
          toolCallId: row.toolCallId,
          label: row.label,
          policy: row.policy,
          action: row.action,
          reason: row.reason,
          timestamp: row.timestamp,
          privacyClass: row.privacyClass,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          durationMs: row.durationMs,
          hasBody: row.blindBodyStorageId !== undefined,
        }),
      ),
    };
  },
});

/** Resolve only a blind-body storage pointer after token authorization. */
export const resolveBody = internalQuery({
  args: {
    token: v.string(),
    stepIndex: v.optional(v.number()),
    matchupSide: v.optional(SIDE),
  },
  handler: async (ctx, args): Promise<{ storageId: Id<"_storage"> | null }> => {
    let trace: Doc<"agentTraces">;
    if (args.matchupSide !== undefined) {
      const { matchup } = await matchupSession(ctx, args.token);
      const traceId = args.matchupSide === "left" ? matchup.leftTraceId : matchup.rightTraceId;
      const row = await ctx.db.get(traceId);
      if (!row) return { storageId: null };
      trace = row;
    } else {
      trace = (await traceSession(ctx, args.token)).trace;
    }
    if (args.stepIndex === undefined) {
      return { storageId: trace.finalAnswerBlindStorageId ?? null };
    }
    const step = await ctx.db
      .query("agentTraceSteps")
      .withIndex("by_trace_and_index", (q) =>
        q.eq("agentTraceId", trace._id).eq("stepIndex", args.stepIndex ?? -1),
      )
      .unique();
    return { storageId: step?.blindBodyStorageId ?? null };
  },
});

/** Lazy-load one blind-projected step/final body through an opaque token. */
export const getStepBody = action({
  args: {
    token: v.string(),
    stepIndex: v.optional(v.number()),
    matchupSide: v.optional(SIDE),
  },
  handler: async (ctx, args): Promise<unknown> => {
    const { storageId } = await ctx.runQuery(internal.agentTraceReviewSessions.resolveBody, args);
    if (!storageId) return null;
    const blob = await ctx.storage.get(storageId);
    if (!blob) return null;
    try {
      return JSON.parse(await blob.text());
    } catch {
      return null;
    }
  },
});

/** List comments for one opaque trajectory session. */
export const listComments = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const { trace, userId } = await traceSession(ctx, args.token);
    const rows = await ctx.db
      .query("agentTraceComments")
      .withIndex("by_trace", (q) => q.eq("agentTraceId", trace._id))
      .collect();
    return rows.filter((row) => row.userId === userId).map((row) => ({
      _id: row._id,
      target: row.target,
      comment: row.comment,
      label: row.label,
      tags: row.tags ?? [],
      mine: row.userId === userId,
      createdAt: row._creationTime,
    }));
  },
});

/** Add a step/trace comment through an opaque trajectory session. */
export const addComment = mutation({
  args: {
    token: v.string(),
    target: TARGET,
    comment: v.string(),
    label: LABEL,
    tags: v.optional(v.array(TAG)),
  },
  handler: async (ctx, args): Promise<Id<"agentTraceComments">> => {
    const { trace, userId } = await traceSession(ctx, args.token);
    const body = args.comment.trim();
    if (!body) throw new Error("Add a comment before saving.");
    if (
      args.target.kind !== "trace" &&
      (args.target.stepIndex < 0 || args.target.stepIndex >= trace.stepCount)
    ) {
      throw new Error("That step is not part of this trace.");
    }
    return await ctx.db.insert("agentTraceComments", {
      agentTraceId: trace._id,
      projectId: trace.projectId,
      userId,
      target: args.target,
      comment: body,
      label: args.label,
      tags: args.tags,
    });
  },
});

/** Return the caller's verdict for one opaque trajectory session. */
export const myVerdict = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const { trace, userId } = await traceSession(ctx, args.token);
    const verdict = await ctx.db
      .query("agentTraceVerdicts")
      .withIndex("by_trace_and_user", (q) =>
        q.eq("agentTraceId", trace._id).eq("userId", userId),
      )
      .unique();
    return verdict ? { rating: verdict.rating, note: verdict.note } : null;
  },
});

/** Upsert the caller's verdict through an opaque trajectory session. */
export const setVerdict = mutation({
  args: { token: v.string(), rating: RATING, note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { trace, userId } = await traceSession(ctx, args.token);
    const existing = await ctx.db
      .query("agentTraceVerdicts")
      .withIndex("by_trace_and_user", (q) =>
        q.eq("agentTraceId", trace._id).eq("userId", userId),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { rating: args.rating, note: args.note });
      return existing._id;
    }
    return await ctx.db.insert("agentTraceVerdicts", {
      agentTraceId: trace._id,
      projectId: trace.projectId,
      userId,
      rating: args.rating,
      note: args.note,
    });
  },
});

/** Return blind matchup metadata without exposing either trace ID. */
export const getMatchup = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const { session, matchup, userId } = await matchupSession(ctx, args.token);
    const project = await ctx.db.get(matchup.projectId);
    const decision = await ctx.db
      .query("agentTraceMatchupDecisions")
      .withIndex("by_matchup_and_user", (q) =>
        q.eq("matchupId", matchup._id).eq("userId", userId),
      )
      .unique();
    const leftFirst = session.leftFirst ?? true;
    return {
      projectName: project?.name ?? "Project",
      divergenceStepIndex: matchup.divergenceStepIndex,
      firstSide: leftFirst ? "left" as const : "right" as const,
      leftBlindLabel: leftFirst ? "A" : "B",
      rightBlindLabel: leftFirst ? "B" : "A",
      comparable: matchup.comparabilityStatus === "valid",
      invalidReason: matchup.invalidReason,
      winner: decision?.winner ?? null,
      reasonTags: decision?.reasonTags ?? [],
    };
  },
});

/** Page one side of an opaque matchup without exposing the underlying trace ID. */
export const listMatchupSteps = query({
  args: { token: v.string(), side: SIDE, paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const { matchup } = await matchupSession(ctx, args.token);
    const traceId = args.side === "left" ? matchup.leftTraceId : matchup.rightTraceId;
    const result = await ctx.db
      .query("agentTraceSteps")
      .withIndex("by_trace_and_index", (q) => q.eq("agentTraceId", traceId))
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.map((row) =>
        blindStepView({
          stepIndex: row.stepIndex,
          kind: row.kind,
          role: row.role,
          toolName: row.toolName,
          toolCallId: row.toolCallId,
          label: row.label,
          policy: row.policy,
          action: row.action,
          reason: row.reason,
          timestamp: row.timestamp,
          privacyClass: row.privacyClass,
          hasBody: row.blindBodyStorageId !== undefined,
        }),
      ),
    };
  },
});

/** Record one independent matchup decision through an opaque session. */
export const decideMatchup = mutation({
  args: { token: v.string(), winner: WINNER, reasonTags: v.array(TAG) },
  handler: async (ctx, args) => {
    const { matchup, userId } = await matchupSession(ctx, args.token);
    if (matchup.comparabilityStatus !== "valid") {
      throw new Error("This matchup is not comparable because its prefixes differ.");
    }
    const existing = await ctx.db
      .query("agentTraceMatchupDecisions")
      .withIndex("by_matchup_and_user", (q) =>
        q.eq("matchupId", matchup._id).eq("userId", userId),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        winner: args.winner,
        reasonTags: args.reasonTags,
        decidedAt: Date.now(),
      });
      return existing._id;
    }
    return await ctx.db.insert("agentTraceMatchupDecisions", {
      matchupId: matchup._id,
      projectId: matchup.projectId,
      userId,
      winner: args.winner,
      reasonTags: args.reasonTags,
      decidedAt: Date.now(),
    });
  },
});
