/** Stored opaque review-session creation for trace and matchup reviewer routes. */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { generateToken } from "./crypto";

const isBlindEvaluator = (collaborator: Doc<"projectCollaborators">): boolean =>
  collaborator.role === "evaluator" && collaborator.blindMode !== false;

/** Ensure one opaque trace-review session exists for one blind reviewer. */
export async function ensureTraceReviewSession(
  ctx: MutationCtx,
  agentTraceId: Id<"agentTraces">,
  projectId: Id<"projects">,
  reviewerUserId: Id<"users">,
): Promise<Id<"agentTraceReviewSessions">> {
  const existing = await ctx.db
    .query("agentTraceReviewSessions")
    .withIndex("by_trace_and_reviewer", (q) =>
      q.eq("agentTraceId", agentTraceId).eq("reviewerUserId", reviewerUserId),
    )
    .unique();
  if (existing) return existing._id;
  return await ctx.db.insert("agentTraceReviewSessions", {
    projectId,
    reviewerUserId,
    token: generateToken(),
    kind: "trace",
    agentTraceId,
  });
}

/** Ensure one opaque matchup-review session exists for one blind reviewer. */
export async function ensureMatchupReviewSession(
  ctx: MutationCtx,
  matchupId: Id<"agentTraceMatchups">,
  projectId: Id<"projects">,
  reviewerUserId: Id<"users">,
): Promise<Id<"agentTraceReviewSessions">> {
  const existing = await ctx.db
    .query("agentTraceReviewSessions")
    .withIndex("by_matchup_and_reviewer", (q) =>
      q.eq("matchupId", matchupId).eq("reviewerUserId", reviewerUserId),
    )
    .unique();
  if (existing) return existing._id;
  const token = generateToken();
  return await ctx.db.insert("agentTraceReviewSessions", {
    projectId,
    reviewerUserId,
    token,
    kind: "matchup",
    leftFirst: token.charCodeAt(token.length - 1) % 2 === 0,
    matchupId,
  });
}

/** Create sessions for every current blind reviewer when a trace becomes ready. */
export async function ensureTraceSessionsForProjectReviewers(
  ctx: MutationCtx,
  agentTraceId: Id<"agentTraces">,
  projectId: Id<"projects">,
): Promise<void> {
  const collaborators = await ctx.db
    .query("projectCollaborators")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .collect();
  for (const collaborator of collaborators) {
    if (!isBlindEvaluator(collaborator)) continue;
    await ensureTraceReviewSession(ctx, agentTraceId, projectId, collaborator.userId);
  }
}

/** Create sessions for every current blind reviewer when a valid matchup is created. */
export async function ensureMatchupSessionsForProjectReviewers(
  ctx: MutationCtx,
  matchupId: Id<"agentTraceMatchups">,
  projectId: Id<"projects">,
): Promise<void> {
  const collaborators = await ctx.db
    .query("projectCollaborators")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .collect();
  for (const collaborator of collaborators) {
    if (!isBlindEvaluator(collaborator)) continue;
    await ensureMatchupReviewSession(ctx, matchupId, projectId, collaborator.userId);
  }
}

/** Backfill sessions for existing ready artifacts when a new blind reviewer joins. */
export async function ensureReviewSessionsForReviewer(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  reviewerUserId: Id<"users">,
): Promise<void> {
  const traces = await ctx.db
    .query("agentTraces")
    .withIndex("by_project_and_status", (q) =>
      q.eq("projectId", projectId).eq("status", "ready"),
    )
    .collect();
  for (const trace of traces) {
    await ensureTraceReviewSession(ctx, trace._id, projectId, reviewerUserId);
  }
  const matchups = await ctx.db
    .query("agentTraceMatchups")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .collect();
  for (const matchup of matchups) {
    if (matchup.comparabilityStatus !== "valid") continue;
    await ensureMatchupReviewSession(ctx, matchup._id, projectId, reviewerUserId);
  }
}
