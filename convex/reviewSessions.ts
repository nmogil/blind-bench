import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireAuth, requireProjectRole } from "./lib/auth";
import { fisherYatesShuffle } from "./lib/shuffle";
import {
  generateFirstRound,
  generateNextRound,
  suggestedRoundCount,
  type PairHistory,
  type SwissPlayer,
} from "./lib/swissPairs";
import type { Doc, Id } from "./_generated/dataModel";

// ---------------------------------------------------------------------------
// Validators shared across mutations
// ---------------------------------------------------------------------------

const ratingValidator = v.union(
  v.literal("best"),
  v.literal("acceptable"),
  v.literal("weak"),
);

const reasonTagValidator = v.union(
  v.literal("tone"),
  v.literal("accuracy"),
  v.literal("clarity"),
  v.literal("length"),
  v.literal("format"),
  v.literal("relevance"),
  v.literal("safety"),
  v.literal("other"),
);

const annotationTagValidator = v.union(
  v.literal("accuracy"),
  v.literal("tone"),
  v.literal("length"),
  v.literal("relevance"),
  v.literal("safety"),
  v.literal("format"),
  v.literal("clarity"),
  v.literal("other"),
);

const winnerValidator = v.union(
  v.literal("left"),
  v.literal("right"),
  v.literal("tie"),
  v.literal("skip"),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SessionScope =
  | { kind: "run"; runId: Id<"promptRuns"> }
  | { kind: "cycle"; cycleId: Id<"reviewCycles"> };

function sessionScope(session: Doc<"reviewSessions">): SessionScope {
  if (session.runId) return { kind: "run", runId: session.runId };
  if (session.cycleId) return { kind: "cycle", cycleId: session.cycleId };
  throw new Error("Session has no scope");
}

/** A-F...AA, AB... labels. Stable across the session. */
function sessionBlindLabels(n: number): string[] {
  const labels: string[] = [];
  for (let i = 0; i < n; i++) {
    let idx = i;
    let label = "";
    do {
      label = String.fromCharCode(65 + (idx % 26)) + label;
      idx = Math.floor(idx / 26) - 1;
    } while (idx >= 0);
    labels.push(label);
  }
  return labels;
}

async function loadSessionOrThrow(
  ctx: QueryCtx,
  sessionId: Id<"reviewSessions">,
  userId: Id<"users">,
): Promise<Doc<"reviewSessions">> {
  const session = await ctx.db.get(sessionId);
  if (!session) throw new Error("Review session not found");
  if (session.userId !== userId) throw new Error("Permission denied");
  return session;
}

function outputKey(entry: {
  runOutputId?: Id<"runOutputs">;
  cycleOutputId?: Id<"cycleOutputs">;
}): string {
  if (entry.runOutputId) return `r:${entry.runOutputId}`;
  if (entry.cycleOutputId) return `c:${entry.cycleOutputId}`;
  throw new Error("Output entry has no id");
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const get = query({
  args: { sessionId: v.id("reviewSessions") },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const session = await loadSessionOrThrow(ctx, args.sessionId, userId);
    await requireProjectRole(ctx, session.projectId, [
      "owner",
      "editor",
      "evaluator",
    ]);

    const outputs = await loadOutputsForSession(ctx, session);
    const ratings = await loadRatings(ctx, session);
    const annotations = await loadAnnotations(ctx, session);
    const matchups = await ctx.db
      .query("reviewMatchups")
      .withIndex("by_session", (q) => q.eq("sessionId", session._id))
      .collect();

    return {
      session: {
        id: session._id,
        projectId: session.projectId,
        phase: session.phase,
        role: session.role,
        currentIndex: session.currentIndex,
        requirePhase1: session.requirePhase1,
        requirePhase2: session.requirePhase2,
        startedAt: session.startedAt,
        phase1CompletedAt: session.phase1CompletedAt,
        completedAt: session.completedAt,
      },
      outputs,
      ratings,
      annotations,
      matchups: matchups
        .sort((a, b) =>
          a.round === b.round ? a.pairIndex - b.pairIndex : a.round - b.round,
        )
        .map((m) => ({
          id: m._id,
          round: m.round,
          pairIndex: m.pairIndex,
          leftKey: outputKey({
            runOutputId: m.leftRunOutputId,
            cycleOutputId: m.leftCycleOutputId,
          }),
          rightKey: outputKey({
            runOutputId: m.rightRunOutputId,
            cycleOutputId: m.rightCycleOutputId,
          }),
          leftBlindLabel: m.leftBlindLabel,
          rightBlindLabel: m.rightBlindLabel,
          winner: m.winner ?? null,
          reasonTags: m.reasonTags,
        })),
    };
  },
});

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export const start = mutation({
  args: {
    runId: v.optional(v.id("promptRuns")),
    cycleId: v.optional(v.id("reviewCycles")),
    requirePhase1: v.optional(v.boolean()),
    requirePhase2: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    if (!args.runId && !args.cycleId) {
      throw new Error("Must provide runId or cycleId");
    }
    if (args.runId && args.cycleId) {
      throw new Error("Session can only target one scope");
    }

    const { projectId, entries, role } = await resolveScopeOrThrow(ctx, args);
    const userId = await requireAuth(ctx);

    // Reuse an in-flight session if one exists for this user + scope.
    const existing = await findExistingActiveSession(ctx, userId, args);
    if (existing) return existing._id;

    const shuffled = fisherYatesShuffle(entries);
    const labels = sessionBlindLabels(shuffled.length);
    const outputOrder = shuffled.map((e, i) => ({
      runOutputId: e.runOutputId,
      cycleOutputId: e.cycleOutputId,
      testCaseId: e.testCaseId,
      sessionBlindLabel: labels[i]!,
    }));

    return await ctx.db.insert("reviewSessions", {
      projectId,
      runId: args.runId,
      cycleId: args.cycleId,
      userId,
      role,
      phase: "phase1",
      requirePhase1: args.requirePhase1 ?? true,
      requirePhase2: args.requirePhase2 ?? true,
      currentIndex: 0,
      outputOrder,
      startedAt: Date.now(),
    });
  },
});

export const setCursor = mutation({
  args: {
    sessionId: v.id("reviewSessions"),
    index: v.number(),
  },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const session = await loadSessionOrThrow(ctx, args.sessionId, userId);
    if (session.phase !== "phase1") return;
    const clamped = Math.max(
      0,
      Math.min(args.index, session.outputOrder.length - 1),
    );
    await ctx.db.patch(args.sessionId, { currentIndex: clamped });
  },
});

export const saveRating = mutation({
  args: {
    sessionId: v.id("reviewSessions"),
    runOutputId: v.optional(v.id("runOutputs")),
    cycleOutputId: v.optional(v.id("cycleOutputs")),
    rating: ratingValidator,
  },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const session = await loadSessionOrThrow(ctx, args.sessionId, userId);
    assertOutputBelongsToSession(session, args);

    const scope = sessionScope(session);
    if (scope.kind === "run" && args.runOutputId) {
      const existing = await ctx.db
        .query("outputPreferences")
        .withIndex("by_run_user", (q) =>
          q.eq("runId", scope.runId).eq("userId", userId),
        )
        .filter((q) => q.eq(q.field("outputId"), args.runOutputId))
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, { rating: args.rating });
      } else {
        await ctx.db.insert("outputPreferences", {
          runId: scope.runId,
          outputId: args.runOutputId,
          userId,
          rating: args.rating,
          reviewSessionId: session._id,
        });
      }
    } else if (scope.kind === "cycle" && args.cycleOutputId) {
      const existing = await ctx.db
        .query("cyclePreferences")
        .withIndex("by_cycle_user", (q) =>
          q.eq("cycleId", scope.cycleId).eq("userId", userId),
        )
        .filter((q) => q.eq(q.field("cycleOutputId"), args.cycleOutputId))
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, { rating: args.rating });
      } else {
        await ctx.db.insert("cyclePreferences", {
          cycleId: scope.cycleId,
          cycleOutputId: args.cycleOutputId,
          userId,
          rating: args.rating,
          source: session.role === "author" ? "author" : "evaluator",
          reviewSessionId: session._id,
        });
      }
    } else {
      throw new Error("Output id does not match session scope");
    }
  },
});

export const saveOverallNote = mutation({
  args: {
    sessionId: v.id("reviewSessions"),
    runOutputId: v.optional(v.id("runOutputs")),
    cycleOutputId: v.optional(v.id("cycleOutputs")),
    note: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const session = await loadSessionOrThrow(ctx, args.sessionId, userId);
    assertOutputBelongsToSession(session, args);

    const scope = sessionScope(session);
    if (scope.kind === "run" && args.runOutputId) {
      const existing = await ctx.db
        .query("outputFeedback")
        .withIndex("by_review_session", (q) =>
          q.eq("reviewSessionId", session._id),
        )
        .filter((q) =>
          q.and(
            q.eq(q.field("outputId"), args.runOutputId),
            q.eq(q.field("targetKind"), "overall"),
          ),
        )
        .unique();
      await upsertOverallNote(ctx, existing, {
        run: {
          outputId: args.runOutputId,
          userId,
          sessionId: session._id,
        },
        note: args.note,
      });
    } else if (scope.kind === "cycle" && args.cycleOutputId) {
      const existing = await ctx.db
        .query("cycleFeedback")
        .withIndex("by_review_session", (q) =>
          q.eq("reviewSessionId", session._id),
        )
        .filter((q) =>
          q.and(
            q.eq(q.field("cycleOutputId"), args.cycleOutputId),
            q.eq(q.field("targetKind"), "overall"),
          ),
        )
        .unique();
      await upsertOverallNote(ctx, existing, {
        cycle: {
          cycleId: scope.cycleId,
          cycleOutputId: args.cycleOutputId,
          userId,
          sessionId: session._id,
          source: session.role === "author" ? "author" : "evaluator",
        },
        note: args.note,
      });
    }
  },
});

export const addAnnotation = mutation({
  args: {
    sessionId: v.id("reviewSessions"),
    runOutputId: v.optional(v.id("runOutputs")),
    cycleOutputId: v.optional(v.id("cycleOutputs")),
    annotationData: v.object({
      from: v.number(),
      to: v.number(),
      highlightedText: v.string(),
      comment: v.string(),
    }),
    tags: v.optional(v.array(annotationTagValidator)),
  },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const session = await loadSessionOrThrow(ctx, args.sessionId, userId);
    assertOutputBelongsToSession(session, args);

    const scope = sessionScope(session);
    if (scope.kind === "run" && args.runOutputId) {
      return await ctx.db.insert("outputFeedback", {
        outputId: args.runOutputId,
        userId,
        annotationData: args.annotationData,
        tags: args.tags,
        reviewSessionId: session._id,
        targetKind: "inline",
      });
    } else if (scope.kind === "cycle" && args.cycleOutputId) {
      return await ctx.db.insert("cycleFeedback", {
        cycleId: scope.cycleId,
        cycleOutputId: args.cycleOutputId,
        userId,
        annotationData: args.annotationData,
        tags: args.tags,
        source: session.role === "author" ? "author" : "evaluator",
        reviewSessionId: session._id,
        targetKind: "inline",
      });
    }
    throw new Error("Output id does not match session scope");
  },
});

export const removeAnnotation = mutation({
  args: {
    sessionId: v.id("reviewSessions"),
    annotationId: v.union(
      v.id("outputFeedback"),
      v.id("cycleFeedback"),
    ),
  },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const session = await loadSessionOrThrow(ctx, args.sessionId, userId);
    const doc = await ctx.db.get(args.annotationId);
    if (!doc) return;
    if (doc.userId !== userId) throw new Error("Permission denied");
    if (doc.reviewSessionId !== session._id) {
      throw new Error("Annotation belongs to a different session");
    }
    await ctx.db.delete(args.annotationId);
  },
});

export const submitPhase1 = mutation({
  args: { sessionId: v.id("reviewSessions") },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const session = await loadSessionOrThrow(ctx, args.sessionId, userId);
    if (session.phase !== "phase1") {
      throw new Error("Session is not in phase1");
    }

    const now = Date.now();

    if (!session.requirePhase2) {
      await ctx.db.patch(session._id, {
        phase: "complete",
        phase1CompletedAt: now,
        completedAt: now,
      });
      return { phase: "complete" as const, matchups: 0 };
    }

    const ratings = await loadRatings(ctx, session);
    const ratingByKey = new Map(ratings.map((r) => [r.outputKey, r.rating]));
    const players: SwissPlayer[] = session.outputOrder
      .filter((entry) => {
        const key = outputKey(entry);
        return ratingByKey.get(key) !== "weak";
      })
      .map((entry) => ({
        id: outputKey(entry),
        bucket: entry.testCaseId ?? "default",
        score: 0,
      }));

    if (players.length < 2) {
      // Not enough outputs to battle — finish here.
      await ctx.db.patch(session._id, {
        phase: "complete",
        phase1CompletedAt: now,
        completedAt: now,
      });
      return { phase: "complete" as const, matchups: 0 };
    }

    const pairs = generateFirstRound(players);
    await persistPairs(ctx, session, pairs, 1);

    await ctx.db.patch(session._id, {
      phase: "phase2",
      phase1CompletedAt: now,
    });
    return {
      phase: "phase2" as const,
      matchups: pairs.length,
      suggestedRounds: suggestedRoundCount(players),
    };
  },
});

export const recordMatchup = mutation({
  args: {
    sessionId: v.id("reviewSessions"),
    matchupId: v.id("reviewMatchups"),
    winner: winnerValidator,
    reasonTags: v.array(reasonTagValidator),
  },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const session = await loadSessionOrThrow(ctx, args.sessionId, userId);
    if (session.phase !== "phase2") {
      throw new Error("Session is not in phase2");
    }
    const matchup = await ctx.db.get(args.matchupId);
    if (!matchup || matchup.sessionId !== session._id) {
      throw new Error("Matchup not in this session");
    }
    await ctx.db.patch(args.matchupId, {
      winner: args.winner,
      reasonTags: args.reasonTags,
      decidedAt: Date.now(),
    });
  },
});

export const generateNextPhase2Round = mutation({
  args: { sessionId: v.id("reviewSessions") },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const session = await loadSessionOrThrow(ctx, args.sessionId, userId);
    if (session.phase !== "phase2") {
      throw new Error("Session is not in phase2");
    }

    const matchups = await ctx.db
      .query("reviewMatchups")
      .withIndex("by_session", (q) => q.eq("sessionId", session._id))
      .collect();

    const scoresByKey = new Map<string, number>();
    const history = new Set<string>();
    let currentRound = 0;

    for (const m of matchups) {
      currentRound = Math.max(currentRound, m.round);
      const leftKey = outputKey({
        runOutputId: m.leftRunOutputId,
        cycleOutputId: m.leftCycleOutputId,
      });
      const rightKey = outputKey({
        runOutputId: m.rightRunOutputId,
        cycleOutputId: m.rightCycleOutputId,
      });
      history.add(leftKey < rightKey ? `${leftKey}::${rightKey}` : `${rightKey}::${leftKey}`);
      if (m.winner === "left") {
        scoresByKey.set(leftKey, (scoresByKey.get(leftKey) ?? 0) + 1);
      } else if (m.winner === "right") {
        scoresByKey.set(rightKey, (scoresByKey.get(rightKey) ?? 0) + 1);
      } else if (m.winner === "tie") {
        scoresByKey.set(leftKey, (scoresByKey.get(leftKey) ?? 0) + 0.5);
        scoresByKey.set(rightKey, (scoresByKey.get(rightKey) ?? 0) + 0.5);
      }
    }

    const ratings = await loadRatings(ctx, session);
    const ratingByKey = new Map(ratings.map((r) => [r.outputKey, r.rating]));
    const players: SwissPlayer[] = session.outputOrder
      .filter((entry) => ratingByKey.get(outputKey(entry)) !== "weak")
      .map((entry) => {
        const key = outputKey(entry);
        return {
          id: key,
          bucket: entry.testCaseId ?? "default",
          score: scoresByKey.get(key) ?? 0,
        };
      });

    const pairs = generateNextRound(players, history as PairHistory);
    if (pairs.length === 0) return { round: currentRound, added: 0 };

    await persistPairs(ctx, session, pairs, currentRound + 1);
    return { round: currentRound + 1, added: pairs.length };
  },
});

export const complete = mutation({
  args: { sessionId: v.id("reviewSessions") },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const session = await loadSessionOrThrow(ctx, args.sessionId, userId);
    if (session.phase === "complete") return;
    await ctx.db.patch(args.sessionId, {
      phase: "complete",
      completedAt: Date.now(),
    });
  },
});

export const abandon = mutation({
  args: { sessionId: v.id("reviewSessions") },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const session = await loadSessionOrThrow(ctx, args.sessionId, userId);
    await ctx.db.patch(args.sessionId, { phase: "abandoned" });
  },
});

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

type ResolvedEntry = {
  runOutputId?: Id<"runOutputs">;
  cycleOutputId?: Id<"cycleOutputs">;
  testCaseId?: Id<"testCases">;
};

async function resolveScopeOrThrow(
  ctx: MutationCtx,
  args: { runId?: Id<"promptRuns">; cycleId?: Id<"reviewCycles"> },
): Promise<{
  projectId: Id<"projects">;
  entries: ResolvedEntry[];
  role: Doc<"reviewSessions">["role"];
}> {
  if (args.runId) {
    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("Run not found");
    const { userId, collaborator } = await requireProjectRole(
      ctx,
      run.projectId,
      ["owner", "editor", "evaluator"],
    );
    const role: Doc<"reviewSessions">["role"] =
      run.triggeredById === userId
        ? "author"
        : collaborator.role === "evaluator"
          ? "evaluator"
          : "collaborator";

    const outputs = await ctx.db
      .query("runOutputs")
      .withIndex("by_run", (q) => q.eq("runId", run._id))
      .collect();

    const entries: ResolvedEntry[] = outputs.map((o) => ({
      runOutputId: o._id,
      testCaseId: run.testCaseId ?? undefined,
    }));
    return { projectId: run.projectId, entries, role };
  }

  if (args.cycleId) {
    const cycle = await ctx.db.get(args.cycleId);
    if (!cycle) throw new Error("Cycle not found");
    const { collaborator } = await requireProjectRole(
      ctx,
      cycle.projectId,
      ["owner", "editor", "evaluator"],
    );
    const role: Doc<"reviewSessions">["role"] =
      collaborator.role === "evaluator" ? "evaluator" : "collaborator";

    const cycleOutputs = await ctx.db
      .query("cycleOutputs")
      .withIndex("by_cycle", (q) => q.eq("cycleId", cycle._id))
      .collect();

    // cycleOutputs don't store testCaseId directly — derive from source run.
    const testCaseByRun = new Map<Id<"promptRuns">, Id<"testCases"> | undefined>();
    const entries: ResolvedEntry[] = [];
    for (const co of cycleOutputs) {
      let tc = testCaseByRun.get(co.sourceRunId);
      if (tc === undefined) {
        const run = await ctx.db.get(co.sourceRunId);
        tc = run?.testCaseId ?? undefined;
        testCaseByRun.set(co.sourceRunId, tc);
      }
      entries.push({ cycleOutputId: co._id, testCaseId: tc });
    }
    return { projectId: cycle.projectId, entries, role };
  }

  throw new Error("No scope provided");
}

async function findExistingActiveSession(
  ctx: MutationCtx,
  userId: Id<"users">,
  args: { runId?: Id<"promptRuns">; cycleId?: Id<"reviewCycles"> },
): Promise<Doc<"reviewSessions"> | null> {
  const sessions = await ctx.db
    .query("reviewSessions")
    .withIndex("by_user_status", (q) =>
      q.eq("userId", userId).eq("phase", "phase1"),
    )
    .collect();
  for (const s of sessions) {
    if (args.runId && s.runId === args.runId) return s;
    if (args.cycleId && s.cycleId === args.cycleId) return s;
  }
  const phase2Sessions = await ctx.db
    .query("reviewSessions")
    .withIndex("by_user_status", (q) =>
      q.eq("userId", userId).eq("phase", "phase2"),
    )
    .collect();
  for (const s of phase2Sessions) {
    if (args.runId && s.runId === args.runId) return s;
    if (args.cycleId && s.cycleId === args.cycleId) return s;
  }
  return null;
}

function assertOutputBelongsToSession(
  session: Doc<"reviewSessions">,
  args: {
    runOutputId?: Id<"runOutputs">;
    cycleOutputId?: Id<"cycleOutputs">;
  },
) {
  const match = session.outputOrder.some(
    (e) =>
      (args.runOutputId && e.runOutputId === args.runOutputId) ||
      (args.cycleOutputId && e.cycleOutputId === args.cycleOutputId),
  );
  if (!match) throw new Error("Output is not part of this session");
}

// ---------------------------------------------------------------------------
// Reading helpers
// ---------------------------------------------------------------------------

async function loadOutputsForSession(
  ctx: QueryCtx,
  session: Doc<"reviewSessions">,
): Promise<
  {
    key: string;
    blindLabel: string;
    content: string;
    testCaseId?: Id<"testCases">;
  }[]
> {
  const out: {
    key: string;
    blindLabel: string;
    content: string;
    testCaseId?: Id<"testCases">;
  }[] = [];
  for (const entry of session.outputOrder) {
    let content = "";
    if (entry.runOutputId) {
      const doc = await ctx.db.get(entry.runOutputId);
      content = doc?.outputContent ?? "";
    } else if (entry.cycleOutputId) {
      const doc = await ctx.db.get(entry.cycleOutputId);
      content = doc?.outputContentSnapshot ?? "";
    }
    out.push({
      key: outputKey(entry),
      blindLabel: entry.sessionBlindLabel,
      content,
      testCaseId: entry.testCaseId,
    });
  }
  return out;
}

async function loadRatings(
  ctx: QueryCtx,
  session: Doc<"reviewSessions">,
): Promise<{ outputKey: string; rating: "best" | "acceptable" | "weak" }[]> {
  const scope = sessionScope(session);
  if (scope.kind === "run") {
    const prefs = await ctx.db
      .query("outputPreferences")
      .withIndex("by_review_session", (q) =>
        q.eq("reviewSessionId", session._id),
      )
      .collect();
    return prefs.map((p) => ({
      outputKey: `r:${p.outputId}`,
      rating: p.rating,
    }));
  }
  const prefs = await ctx.db
    .query("cyclePreferences")
    .withIndex("by_review_session", (q) =>
      q.eq("reviewSessionId", session._id),
    )
    .collect();
  return prefs.map((p) => ({
    outputKey: `c:${p.cycleOutputId}`,
    rating: p.rating,
  }));
}

async function loadAnnotations(
  ctx: QueryCtx,
  session: Doc<"reviewSessions">,
) {
  const scope = sessionScope(session);
  if (scope.kind === "run") {
    const docs = await ctx.db
      .query("outputFeedback")
      .withIndex("by_review_session", (q) =>
        q.eq("reviewSessionId", session._id),
      )
      .collect();
    return docs.map((d) => ({
      id: d._id,
      outputKey: `r:${d.outputId}`,
      targetKind: d.targetKind ?? "inline",
      annotationData: d.annotationData,
      tags: d.tags ?? [],
    }));
  }
  const docs = await ctx.db
    .query("cycleFeedback")
    .withIndex("by_review_session", (q) =>
      q.eq("reviewSessionId", session._id),
    )
    .collect();
  return docs.map((d) => ({
    id: d._id,
    outputKey: `c:${d.cycleOutputId}`,
    targetKind: d.targetKind ?? "inline",
    annotationData: d.annotationData,
    tags: d.tags ?? [],
  }));
}

// ---------------------------------------------------------------------------
// Matchup persistence
// ---------------------------------------------------------------------------

async function persistPairs(
  ctx: MutationCtx,
  session: Doc<"reviewSessions">,
  pairs: { leftId: string; rightId: string; bucket: string }[],
  round: number,
): Promise<void> {
  const keyToEntry = new Map(
    session.outputOrder.map((e) => [outputKey(e), e]),
  );
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i]!;
    const left = keyToEntry.get(pair.leftId);
    const right = keyToEntry.get(pair.rightId);
    if (!left || !right) continue;
    await ctx.db.insert("reviewMatchups", {
      sessionId: session._id,
      round,
      pairIndex: i,
      leftRunOutputId: left.runOutputId,
      leftCycleOutputId: left.cycleOutputId,
      rightRunOutputId: right.runOutputId,
      rightCycleOutputId: right.cycleOutputId,
      leftBlindLabel: left.sessionBlindLabel,
      rightBlindLabel: right.sessionBlindLabel,
      testCaseId: left.testCaseId,
      reasonTags: [],
    });
  }
}

// ---------------------------------------------------------------------------
// Overall-note upserts
// ---------------------------------------------------------------------------

async function upsertOverallNote(
  ctx: MutationCtx,
  existing: Doc<"outputFeedback"> | Doc<"cycleFeedback"> | null,
  args:
    | {
        run: {
          outputId: Id<"runOutputs">;
          userId: Id<"users">;
          sessionId: Id<"reviewSessions">;
        };
        note: string;
      }
    | {
        cycle: {
          cycleId: Id<"reviewCycles">;
          cycleOutputId: Id<"cycleOutputs">;
          userId: Id<"users">;
          sessionId: Id<"reviewSessions">;
          source: "author" | "evaluator";
        };
        note: string;
      },
): Promise<void> {
  const emptyAnnotation = {
    from: 0,
    to: 0,
    highlightedText: "",
    comment: args.note,
  };

  if (existing) {
    if (args.note.trim() === "") {
      await ctx.db.delete(existing._id);
    } else {
      await ctx.db.patch(existing._id, { annotationData: emptyAnnotation });
    }
    return;
  }
  if (args.note.trim() === "") return;

  if ("run" in args) {
    await ctx.db.insert("outputFeedback", {
      outputId: args.run.outputId,
      userId: args.run.userId,
      annotationData: emptyAnnotation,
      reviewSessionId: args.run.sessionId,
      targetKind: "overall",
    });
  } else {
    await ctx.db.insert("cycleFeedback", {
      cycleId: args.cycle.cycleId,
      cycleOutputId: args.cycle.cycleOutputId,
      userId: args.cycle.userId,
      annotationData: emptyAnnotation,
      source: args.cycle.source,
      reviewSessionId: args.cycle.sessionId,
      targetKind: "overall",
    });
  }
}
