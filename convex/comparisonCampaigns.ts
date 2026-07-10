/**
 * Self-serve paired comparison campaigns over the existing agent-trace spine.
 *
 * The owner imports two candidates per shared context. Reviewers later redeem a
 * campaign share token for their own opaque, user-bound review session; the
 * share token itself never authorizes trace content or decisions.
 */
import { v } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireAuth, requireProjectRole } from "./lib/auth";
import { generateToken } from "./lib/crypto";
import { fisherYatesShuffle } from "./lib/shuffle";
import {
  parsePairedComparisonCsv,
  type PairedComparisonCsvSummary,
} from "./lib/pairedComparisonCsv";
import { renderStep, type StepMeta } from "./lib/trainingExport";

const MAX_BYTES = 8 * 1024 * 1024;
const INITIAL_BATCH_SIZE = 5;
type ReadCtx = QueryCtx | MutationCtx;

interface CampaignReservation {
  readonly campaignId: Id<"comparisonCampaigns">;
  readonly status: "importing" | "draft" | "open" | "closed";
  readonly rawPayloadStorageId?: Id<"_storage">;
  readonly existing: boolean;
}

interface ImportResult {
  readonly campaignId: Id<"comparisonCampaigns">;
  readonly importedCases: number;
  readonly deduped: boolean;
  readonly summary: PairedComparisonCsvSummary;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Reserve an idempotent campaign import before the action writes storage. */
export const reserveImport = internalMutation({
  args: {
    projectId: v.id("projects"),
    name: v.string(),
    importKey: v.string(),
  },
  handler: async (ctx, args): Promise<CampaignReservation> => {
    const { userId } = await requireProjectRole(ctx, args.projectId, [
      "owner",
      "editor",
    ]);
    const existing = await ctx.db
      .query("comparisonCampaigns")
      .withIndex("by_project_import", (q) =>
        q.eq("projectId", args.projectId).eq("importKey", args.importKey),
      )
      .unique();
    if (existing) {
      return {
        campaignId: existing._id,
        status: existing.status,
        rawPayloadStorageId: existing.rawPayloadStorageId,
        existing: true,
      };
    }
    const campaignId = await ctx.db.insert("comparisonCampaigns", {
      projectId: args.projectId,
      name: args.name.trim(),
      status: "importing",
      shareToken: generateToken(),
      importKey: args.importKey,
      caseCount: 0,
      judgmentCount: 0,
      createdById: userId,
      createdAt: Date.now(),
    });
    return { campaignId, status: "importing", existing: false };
  },
});

/** Attach the retained raw CSV once; retries never allocate another blob. */
export const attachRawPayload = internalMutation({
  args: {
    campaignId: v.id("comparisonCampaigns"),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) throw new Error("Comparison campaign not found.");
    await requireProjectRole(ctx, campaign.projectId, ["owner", "editor"]);
    if (campaign.rawPayloadStorageId === undefined) {
      await ctx.db.patch(campaign._id, { rawPayloadStorageId: args.storageId });
    }
  },
});

/** Mark a fully materialized import ready for owner review. */
export const finalizeImport = internalMutation({
  args: { campaignId: v.id("comparisonCampaigns") },
  handler: async (ctx, args) => {
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) throw new Error("Comparison campaign not found.");
    await requireProjectRole(ctx, campaign.projectId, ["owner", "editor"]);
    const matchups = await ctx.db
      .query("agentTraceMatchups")
      .withIndex("by_campaign", (q) => q.eq("campaignId", campaign._id))
      .collect();
    await ctx.db.patch(campaign._id, { status: "draft", caseCount: matchups.length });
  },
});

/**
 * Import a strict paired CSV as two candidate traces and one comparable matchup
 * per valid row. The result is content-free and safe to render as a receipt.
 */
export const importPairedCsv = action({
  args: {
    projectId: v.id("projects"),
    name: v.string(),
    csv: v.string(),
  },
  handler: async (ctx, args): Promise<ImportResult> => {
    await ctx.runQuery(internal.agentTraces.authorizePersist, {
      projectId: args.projectId,
    });
    if (!args.name.trim()) throw new Error("Add a comparison name.");
    const inputBytes = new TextEncoder().encode(args.csv).byteLength;
    if (inputBytes > MAX_BYTES) {
      throw new Error("Paired CSV is over the 8 MB upload limit.");
    }
    const batch = parsePairedComparisonCsv(args.csv);
    if (batch.summary.invalid > 0) {
      throw new Error(
        `Paired CSV has ${batch.summary.invalid} invalid row${batch.summary.invalid === 1 ? "" : "s"} (${batch.summary.invalidRows.join(", ")}). Fix every row and import again.`,
      );
    }
    if (batch.cases.length === 0) {
      throw new Error("Paired CSV has no complete candidate pairs to import.");
    }
    const importKey = await sha256(args.csv);
    const reservation: CampaignReservation = await ctx.runMutation(
      internal.comparisonCampaigns.reserveImport,
      {
        projectId: args.projectId,
        name: args.name,
        importKey,
      },
    );
    if (reservation.existing && reservation.status !== "importing") {
      return {
        campaignId: reservation.campaignId,
        importedCases: 0,
        deduped: true,
        summary: batch.summary,
      };
    }

    if (reservation.rawPayloadStorageId === undefined) {
      const storageId = await ctx.storage.store(
        new Blob([args.csv], { type: "text/csv" }),
      );
      await ctx.runMutation(internal.comparisonCampaigns.attachRawPayload, {
        campaignId: reservation.campaignId,
        storageId,
      });
    }

    for (let index = 0; index < batch.cases.length; index++) {
      const item = batch.cases[index];
      if (!item) continue;
      // Keep the pair ordered: Convex actions share bounded storage/write
      // resources, and each trace already stores its steps in bounded chunks.
      const candidateA = await ctx.runAction(api.agentTraces.persistTrace, {
        projectId: args.projectId,
        trace: item.candidateA,
      });
      const candidateB = await ctx.runAction(api.agentTraces.persistTrace, {
        projectId: args.projectId,
        trace: item.candidateB,
      });
      await ctx.runMutation(api.agentTraceReview.createMatchup, {
        leftTraceId: candidateA.agentTraceId,
        rightTraceId: candidateB.agentTraceId,
        divergenceStepIndex: 1,
        leftBlindLabel: "A",
        rightBlindLabel: "B",
        campaignId: reservation.campaignId,
        caseKey: item.caseKey,
        segment: item.segment,
        sortOrder: index,
      });
    }

    await ctx.runMutation(internal.comparisonCampaigns.finalizeImport, {
      campaignId: reservation.campaignId,
    });
    return {
      campaignId: reservation.campaignId,
      importedCases: batch.cases.length,
      deduped: false,
      summary: batch.summary,
    };
  },
});

/** Owner/editor campaign summary, including provenance hidden from reviewers. */
export const getOwnerCampaign = query({
  args: { campaignId: v.id("comparisonCampaigns") },
  handler: async (ctx, args) => {
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) throw new Error("Comparison campaign not found.");
    await requireProjectRole(ctx, campaign.projectId, ["owner", "editor"]);
    const matchups = await ctx.db
      .query("agentTraceMatchups")
      .withIndex("by_campaign", (q) => q.eq("campaignId", campaign._id))
      .collect();
    const reviewSessions = await ctx.db
      .query("agentTraceReviewSessions")
      .withIndex("by_campaign_and_reviewer", (q) => q.eq("campaignId", campaign._id))
      .collect();
    const displayNameByReviewer = new Map(
      reviewSessions.map((session) => [
        String(session.reviewerUserId),
        session.reviewerDisplayName,
      ]),
    );
    const candidates = new Map<string, { model: string; harness: string }>();
    const candidateA = new Set<string>();
    const candidateB = new Set<string>();
    const reviewers = new Map<string, Id<"users">>();
    const feedbackRows: Array<{
      caseKey: string;
      reviewerId: string;
      outcome: "Candidate A" | "Candidate B" | "Same" | "Neither acceptable" | "Cannot judge";
      note: string;
    }> = [];
    const results = {
      judgments: 0,
      leftWins: 0,
      rightWins: 0,
      same: 0,
      neither: 0,
      cannotJudge: 0,
      reviewedCases: 0,
      agreementCases: 0,
      agreementJudgments: 0,
      majorityJudgments: 0,
    };
    for (const matchup of matchups) {
      const traces = await Promise.all([
        ctx.db.get(matchup.leftTraceId),
        ctx.db.get(matchup.rightTraceId),
      ]);
      for (const trace of traces) {
        if (!trace) continue;
        const model = trace.model ?? "Unknown model";
        const key = `${model}\u0000${trace.harnessName}`;
        candidates.set(key, { model, harness: trace.harnessName });
      }
      if (traces[0]) candidateA.add(traces[0].model ?? traces[0].harnessName);
      if (traces[1]) candidateB.add(traces[1].model ?? traces[1].harnessName);
      const decisions = await ctx.db
        .query("agentTraceMatchupDecisions")
        .withIndex("by_matchup", (q) => q.eq("matchupId", matchup._id))
        .collect();
      const caseCounts = new Map<string, number>();
      if (decisions.length > 0) results.reviewedCases++;
      for (const decision of decisions) {
        reviewers.set(String(decision.userId), decision.userId);
        results.judgments++;
        caseCounts.set(decision.winner, (caseCounts.get(decision.winner) ?? 0) + 1);
        if (decision.note) {
          const outcome = decision.winner === "left" ? "Candidate A"
            : decision.winner === "right" ? "Candidate B"
              : decision.winner === "tie" ? "Same"
                : decision.winner === "neither" ? "Neither acceptable"
                  : "Cannot judge";
          feedbackRows.push({
            caseKey: matchup.caseKey ?? "Comparison case",
            reviewerId: String(decision.userId),
            outcome,
            note: decision.note,
          });
        }
        if (decision.winner === "left") results.leftWins++;
        else if (decision.winner === "right") results.rightWins++;
        else if (decision.winner === "tie") results.same++;
        else if (decision.winner === "neither") results.neither++;
        else results.cannotJudge++;
      }
      if (decisions.length >= 2) {
        results.agreementCases++;
        results.agreementJudgments += decisions.length;
        results.majorityJudgments += Math.max(...caseCounts.values());
      }
    }
    const reviewerNames: string[] = [];
    const reviewerNameById = new Map<string, string>();
    for (const reviewerId of reviewers.values()) {
      const reviewer = await ctx.db.get(reviewerId);
      const name = displayNameByReviewer.get(String(reviewerId))?.trim()
        || reviewer?.name?.trim()
        || "Guest reviewer";
      reviewerNames.push(name);
      reviewerNameById.set(String(reviewerId), name);
    }

    return {
      id: campaign._id,
      projectId: campaign.projectId,
      name: campaign.name,
      status: campaign.status,
      shareToken: campaign.shareToken,
      caseCount: matchups.length,
      comparableCount: matchups.filter(
        (matchup) => matchup.comparabilityStatus === "valid",
      ).length,
      invalidCount: matchups.filter(
        (matchup) => matchup.comparabilityStatus !== "valid",
      ).length,
      candidates: [...candidates.values()].sort((left, right) =>
        left.model.localeCompare(right.model),
      ),
      candidateA: [...candidateA].sort(),
      candidateB: [...candidateB].sort(),
      reviewerNames: reviewerNames.sort((left, right) => left.localeCompare(right)),
      feedback: feedbackRows.map(({ reviewerId, ...row }) => ({
        ...row,
        reviewerName: reviewerNameById.get(reviewerId) ?? "Guest reviewer",
      })),
      results: {
        ...results,
        reviewers: reviewers.size,
        possibleJudgments: matchups.length * reviewers.size,
        agreementRate: results.agreementJudgments > 0
          ? results.majorityJudgments / results.agreementJudgments
          : null,
      },
    };
  },
});

/** List owner/editor comparison campaigns with progress counts. */
export const listCampaigns = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProjectRole(ctx, args.projectId, ["owner", "editor"]);
    const campaigns = await ctx.db
      .query("comparisonCampaigns")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(100);
    return campaigns.map((campaign) => ({
      id: campaign._id,
      name: campaign.name,
      status: campaign.status,
      caseCount: campaign.caseCount ?? 0,
      judgments: campaign.judgmentCount ?? 0,
      createdAt: campaign.createdAt,
    }));
  },
});

/** Open a fully imported campaign for guest review. */
export const openCampaign = mutation({
  args: { campaignId: v.id("comparisonCampaigns") },
  handler: async (ctx, args) => {
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) throw new Error("Comparison campaign not found.");
    await requireProjectRole(ctx, campaign.projectId, ["owner", "editor"]);
    if (campaign.status !== "draft" && campaign.status !== "open") {
      throw new Error("Only a ready comparison campaign can be opened.");
    }
    if (campaign.status === "draft") {
      await ctx.db.patch(campaign._id, { status: "open", openedAt: Date.now() });
    }
    return { shareToken: campaign.shareToken };
  },
});

/** Stop new and in-progress judgments while preserving results and exports. */
export const closeCampaign = mutation({
  args: { campaignId: v.id("comparisonCampaigns") },
  handler: async (ctx, args) => {
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) throw new Error("Comparison campaign not found.");
    await requireProjectRole(ctx, campaign.projectId, ["owner", "editor"]);
    if (campaign.status !== "open" && campaign.status !== "closed") {
      throw new Error("Only an open comparison campaign can be closed.");
    }
    if (campaign.status === "open") {
      await ctx.db.patch(campaign._id, { status: "closed", closedAt: Date.now() });
    }
    return { closed: true };
  },
});

async function campaignSession(ctx: ReadCtx, token: string) {
  const userId = await requireAuth(ctx);
  const session = await ctx.db
    .query("agentTraceReviewSessions")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();
  if (
    !session ||
    session.reviewerUserId !== userId ||
    session.kind !== "campaign" ||
    session.campaignId === undefined
  ) {
    throw new Error("Review session not found or expired.");
  }
  const campaign = await ctx.db.get(session.campaignId);
  if (!campaign || campaign.projectId !== session.projectId) {
    throw new Error("Review campaign is no longer available.");
  }
  return { userId, session, campaign };
}

/** Redeem a campaign share token for one user-bound opaque review session. */
export const joinCampaign = mutation({
  args: { shareToken: v.string(), displayName: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const campaign = await ctx.db
      .query("comparisonCampaigns")
      .withIndex("by_share_token", (q) => q.eq("shareToken", args.shareToken))
      .unique();
    if (!campaign || campaign.status !== "open") {
      throw new Error("This comparison is not open for review.");
    }
    const collaborator = await ctx.db
      .query("projectCollaborators")
      .withIndex("by_project_and_user", (q) =>
        q.eq("projectId", campaign.projectId).eq("userId", userId),
      )
      .unique();
    if (collaborator?.role === "owner" || collaborator?.role === "editor") {
      throw new Error("Open this review link in a guest window to preserve blinding.");
    }
    const existing = await ctx.db
      .query("agentTraceReviewSessions")
      .withIndex("by_campaign_and_reviewer", (q) =>
        q.eq("campaignId", campaign._id).eq("reviewerUserId", userId),
      )
      .unique();
    const displayName = args.displayName.trim().slice(0, 80);
    if (!displayName) throw new Error("Add your display name before starting.");
    if (existing) {
      if (displayName && existing.reviewerDisplayName !== displayName) {
        await ctx.db.patch(existing._id, { reviewerDisplayName: displayName });
      }
      return { sessionToken: existing.token };
    }

    const matchups = await ctx.db
      .query("agentTraceMatchups")
      .withIndex("by_campaign", (q) => q.eq("campaignId", campaign._id))
      .collect();
    const ordered = fisherYatesShuffle(
      matchups.filter((matchup) => matchup.comparabilityStatus === "valid"),
    );
    if (ordered.length === 0) throw new Error("This comparison has no reviewable pairs.");
    const token = generateToken();
    await ctx.db.insert("agentTraceReviewSessions", {
      projectId: campaign.projectId,
      reviewerUserId: userId,
      token,
      kind: "campaign",
      campaignId: campaign._id,
      reviewerDisplayName: displayName,
      campaignOrder: ordered.map((matchup, index) => ({
        matchupId: matchup._id,
        leftFirst: (token.charCodeAt(index % token.length) + index) % 2 === 0,
      })),
      currentIndex: 0,
      visibleCount: Math.min(INITIAL_BATCH_SIZE, ordered.length),
    });
    return { sessionToken: token };
  },
});

async function decisionsForSession(
  ctx: ReadCtx,
  session: Doc<"agentTraceReviewSessions">,
): Promise<Map<string, Doc<"agentTraceMatchupDecisions">>> {
  const decisions = new Map<string, Doc<"agentTraceMatchupDecisions">>();
  for (const entry of session.campaignOrder ?? []) {
    const row = await ctx.db
      .query("agentTraceMatchupDecisions")
      .withIndex("by_matchup_and_user", (q) =>
        q.eq("matchupId", entry.matchupId).eq("userId", session.reviewerUserId),
      )
      .unique();
    if (row) decisions.set(String(entry.matchupId), row);
  }
  return decisions;
}

const REVIEW_CHOICE = v.union(
  v.literal("first"),
  v.literal("second"),
  v.literal("same"),
  v.literal("neither"),
  v.literal("cannot_judge"),
);

/** Save or revise one displayed campaign choice without trusting client ids. */
export const submitChoice = mutation({
  args: {
    sessionToken: v.string(),
    position: v.number(),
    choice: REVIEW_CHOICE,
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { userId, session, campaign } = await campaignSession(ctx, args.sessionToken);
    if (campaign.status !== "open") throw new Error("This comparison is closed.");
    const order = session.campaignOrder ?? [];
    const visibleCount = Math.min(session.visibleCount ?? INITIAL_BATCH_SIZE, order.length);
    if (!Number.isInteger(args.position) || args.position < 0 || args.position >= visibleCount) {
      throw new Error("That comparison item is not available.");
    }
    const entry = order[args.position];
    if (!entry) throw new Error("That comparison item is not available.");
    const matchup = await ctx.db.get(entry.matchupId);
    if (!matchup || matchup.campaignId !== campaign._id || matchup.comparabilityStatus !== "valid") {
      throw new Error("That comparison item is no longer reviewable.");
    }
    const winner = args.choice === "first"
      ? (entry.leftFirst ? "left" : "right")
      : args.choice === "second"
        ? (entry.leftFirst ? "right" : "left")
        : args.choice === "same"
          ? "tie"
          : args.choice === "neither"
            ? "neither"
            : "skip";
    const note = args.note?.trim().slice(0, 2_000) || undefined;
    const existing = await ctx.db
      .query("agentTraceMatchupDecisions")
      .withIndex("by_matchup_and_user", (q) =>
        q.eq("matchupId", matchup._id).eq("userId", userId),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { winner, note, decidedAt: Date.now() });
    } else {
      await ctx.db.insert("agentTraceMatchupDecisions", {
        matchupId: matchup._id,
        projectId: campaign.projectId,
        userId,
        winner,
        note,
        reasonTags: [],
        decidedAt: Date.now(),
      });
      await ctx.db.patch(campaign._id, {
        judgmentCount: (campaign.judgmentCount ?? 0) + 1,
      });
    }
    const nextIndex = Math.max(session.currentIndex ?? 0, args.position + 1);
    await ctx.db.patch(session._id, {
      currentIndex: nextIndex,
      ...(nextIndex >= order.length ? { completedAt: Date.now() } : {}),
    });
    return { saved: true };
  },
});

/** Reveal the next five frozen assignments without changing their order. */
export const extendBatch = mutation({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    const { session, campaign } = await campaignSession(ctx, args.sessionToken);
    if (campaign.status !== "open") throw new Error("This comparison is closed.");
    const order = session.campaignOrder ?? [];
    const total = order.length;
    const currentVisibleCount = Math.min(
      session.visibleCount ?? INITIAL_BATCH_SIZE,
      total,
    );
    const decisions = await decisionsForSession(ctx, session);
    if (order.slice(0, currentVisibleCount).some(
      (entry) => !decisions.has(String(entry.matchupId)),
    )) {
      throw new Error("Complete the current five comparisons before adding more.");
    }
    const visibleCount = Math.min(
      total,
      currentVisibleCount + INITIAL_BATCH_SIZE,
    );
    await ctx.db.patch(session._id, { visibleCount });
    return { visibleCount, total };
  },
});

/** Reviewer-safe campaign progress and current blind matchup metadata. */
export const getReview = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    const { session, campaign } = await campaignSession(ctx, args.sessionToken);
    const order = session.campaignOrder ?? [];
    const visibleCount = Math.min(session.visibleCount ?? INITIAL_BATCH_SIZE, order.length);
    const decisions = await decisionsForSession(ctx, session);
    let currentIndex = Math.min(session.currentIndex ?? 0, Math.max(0, visibleCount - 1));
    while (currentIndex < visibleCount && decisions.has(String(order[currentIndex]?.matchupId))) {
      currentIndex++;
    }
    const entry = currentIndex < visibleCount ? order[currentIndex] : undefined;
    const matchup = entry ? await ctx.db.get(entry.matchupId) : null;
    const candidateStep = matchup
      ? await ctx.db
          .query("agentTraceSteps")
          .withIndex("by_trace_and_index", (q) =>
            q.eq("agentTraceId", matchup.leftTraceId).eq("stepIndex", matchup.divergenceStepIndex),
          )
          .unique()
      : null;
    return {
      title: "Blind comparison",
      status: campaign.status,
      progress: {
        judged: decisions.size,
        visible: visibleCount,
        total: order.length,
      },
      batchComplete: entry === undefined,
      allComplete: decisions.size >= order.length,
      current: matchup && entry ? {
        position: currentIndex,
        firstLabel: "A",
        secondLabel: "B",
        firstSide: entry.leftFirst ? "left" as const : "right" as const,
        secondSide: entry.leftFirst ? "right" as const : "left" as const,
        comparable: matchup.comparabilityStatus === "valid",
        divergenceStepIndex: matchup.divergenceStepIndex,
        candidateStep: candidateStep ? {
          stepIndex: candidateStep.stepIndex,
          kind: candidateStep.kind,
        } : {
          stepIndex: matchup.divergenceStepIndex,
          kind: "message" as const,
        },
      } : null,
    };
  },
});

interface ContentStepPlan {
  readonly meta: StepMeta;
  readonly storageId?: Id<"_storage">;
}

interface CurrentContentPlan {
  readonly leftFirst: boolean;
  readonly prefix: ReadonlyArray<ContentStepPlan>;
  readonly left: ContentStepPlan | null;
  readonly right: ContentStepPlan | null;
}

interface ReviewContent {
  readonly context: string;
  readonly firstCandidate: string;
  readonly secondCandidate: string;
}

const stepMeta = (step: Doc<"agentTraceSteps">): StepMeta => ({
  kind: step.kind,
  role: step.role,
  toolName: step.toolName,
  label: step.label,
  policy: step.policy,
  action: step.action,
  reason: step.reason,
});

export const currentContentPlan = internalQuery({
  args: { sessionToken: v.string() },
  handler: async (ctx, args): Promise<CurrentContentPlan | null> => {
    const { session, campaign } = await campaignSession(ctx, args.sessionToken);
    if (campaign.status !== "open") return null;
    const order = session.campaignOrder ?? [];
    const visibleCount = Math.min(session.visibleCount ?? INITIAL_BATCH_SIZE, order.length);
    const decisions = await decisionsForSession(ctx, session);
    let index = Math.min(session.currentIndex ?? 0, Math.max(0, visibleCount - 1));
    while (index < visibleCount && decisions.has(String(order[index]?.matchupId))) index++;
    const entry = index < visibleCount ? order[index] : undefined;
    if (!entry) return null;
    const matchup = await ctx.db.get(entry.matchupId);
    if (!matchup) return null;
    const [leftSteps, rightSteps] = await Promise.all([
      ctx.db.query("agentTraceSteps").withIndex("by_trace_and_index", (q) => q.eq("agentTraceId", matchup.leftTraceId)).collect(),
      ctx.db.query("agentTraceSteps").withIndex("by_trace_and_index", (q) => q.eq("agentTraceId", matchup.rightTraceId)).collect(),
    ]);
    const prefix = leftSteps.filter((step) => step.stepIndex < matchup.divergenceStepIndex);
    const left = leftSteps.find((step) => step.stepIndex === matchup.divergenceStepIndex);
    const right = rightSteps.find((step) => step.stepIndex === matchup.divergenceStepIndex);
    return {
      leftFirst: entry.leftFirst,
      prefix: prefix.map((step) => ({ meta: stepMeta(step), storageId: step.blindBodyStorageId })),
      left: left ? { meta: stepMeta(left), storageId: left.blindBodyStorageId } : null,
      right: right ? { meta: stepMeta(right), storageId: right.blindBodyStorageId } : null,
    };
  },
});

async function readStoredJson(
  ctx: { storage: { get: (id: Id<"_storage">) => Promise<Blob | null> } },
  storageId: Id<"_storage"> | undefined,
): Promise<unknown> {
  if (!storageId) return null;
  const blob = await ctx.storage.get(storageId);
  if (!blob) return null;
  try { return JSON.parse(await blob.text()); } catch { return null; }
}

/** Lazy content action for the current campaign card; provenance never returns. */
export const getCurrentContent = action({
  args: { sessionToken: v.string() },
  handler: async (ctx, args): Promise<ReviewContent> => {
    const plan: CurrentContentPlan | null = await ctx.runQuery(
      internal.comparisonCampaigns.currentContentPlan,
      args,
    );
    if (!plan) return { context: "", firstCandidate: "", secondCandidate: "" };
    const prefixBodies: string[] = [];
    for (const step of plan.prefix) {
      const body = await readStoredJson(ctx, step.storageId);
      prefixBodies.push(renderStep(step.meta, body));
    }
    const leftBody = await readStoredJson(ctx, plan.left?.storageId);
    const rightBody = await readStoredJson(ctx, plan.right?.storageId);
    const left = plan.left ? renderStep(plan.left.meta, leftBody).replace(/^assistant: /, "") : "";
    const right = plan.right ? renderStep(plan.right.meta, rightBody).replace(/^assistant: /, "") : "";
    const context = prefixBodies.join("\n").replace(/^user: /, "");
    return {
      context,
      firstCandidate: plan.leftFirst ? left : right,
      secondCandidate: plan.leftFirst ? right : left,
    };
  },
});
