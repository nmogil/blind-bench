/** Explicit, revocable owner approval snapshots for training export (#287). */
import { v } from "convex/values";
import { action, internalMutation, internalQuery, mutation, query, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireProjectRole } from "./lib/auth";
import { TRAINING_EXPORT_LIMITS, trainingExportSizeViolation } from "./lib/trainingExport";
import { deriveTrainingTaskHash, parseHarborReviewerProjection } from "./lib/harborEvidence";

export const TRAINING_POLICY_VERSION = "full-span-training-v2";

type PrivacyClass = Doc<"agentTraces">["privacyClass"];
type ExclusionReason = Doc<"trainingApprovalItems">["exclusionReason"];
type ProjectionRef = { readonly storageId: Id<"_storage">; readonly taskHash: string; readonly privacyClass: PrivacyClass };
type ProjectionSnapshot = ProjectionRef & { readonly sha256: string };
type Candidate = {
  readonly agentTraceId?: Id<"agentTraces">;
  readonly matchupId?: Id<"agentTraceMatchups">;
  readonly winner?: "left" | "right";
  readonly divergenceStepIndex?: number;
  readonly sharedPrefixHash?: string;
  readonly taskHash?: string;
  readonly projection?: ProjectionSnapshot;
  readonly leftProjection?: ProjectionSnapshot;
  readonly rightProjection?: ProjectionSnapshot;
  readonly privacyClass: PrivacyClass;
  readonly reviewerCount: number;
  readonly eligibility: "eligible" | "excluded";
  readonly exclusionReason?: ExclusionReason;
};
type PreparedCandidate = Omit<Candidate, "projection" | "leftProjection" | "rightProjection"> & {
  readonly projection?: ProjectionRef;
  readonly leftProjection?: ProjectionRef;
  readonly rightProjection?: ProjectionRef;
};
type ApprovalResult = { readonly approvalId: Id<"trainingApprovals">; readonly eligibleCount: number; readonly excludedCount: number };
type PreparedResult = { readonly existing: ApprovalResult | null; readonly projectId: Id<"projects">; readonly reviewerCount: number; readonly candidates: PreparedCandidate[] };

const PRIVACY = v.union(v.literal("public"), v.literal("internal"), v.literal("confidential"), v.literal("pii"), v.literal("phi"));
const EXCLUSION = v.union(v.literal("not_full_span"), v.literal("fixture_only"), v.literal("insufficient_evidence"), v.literal("sensitive"), v.literal("no_approved_verdict"), v.literal("review_disagreement"), v.literal("non_comparable_prefix"), v.literal("no_preference"), v.literal("task_mismatch"), v.literal("invalid_task_hash"));
const SNAPSHOT = v.object({ storageId: v.id("_storage"), sha256: v.string(), taskHash: v.string(), privacyClass: PRIVACY });
const CANDIDATE = v.object({
  agentTraceId: v.optional(v.id("agentTraces")), matchupId: v.optional(v.id("agentTraceMatchups")),
  winner: v.optional(v.union(v.literal("left"), v.literal("right"))), divergenceStepIndex: v.optional(v.number()),
  sharedPrefixHash: v.optional(v.string()), taskHash: v.optional(v.string()), projection: v.optional(SNAPSHOT),
  leftProjection: v.optional(SNAPSHOT), rightProjection: v.optional(SNAPSHOT), privacyClass: PRIVACY,
  reviewerCount: v.number(), eligibility: v.union(v.literal("eligible"), v.literal("excluded")), exclusionReason: v.optional(EXCLUSION),
});

const SHA256 = /^[0-9a-f]{64}$/;

function sensitive(value: PrivacyClass): boolean { return value === "confidential" || value === "pii" || value === "phi"; }
function combinedPrivacy(left: PrivacyClass, right: PrivacyClass): PrivacyClass {
  if (sensitive(left)) return left;
  if (sensitive(right)) return right;
  return left === "internal" || right === "internal" ? "internal" : "public";
}

async function projectionRef(ctx: QueryCtx, trace: Doc<"agentTraces"> | null): Promise<{ readonly eligible: true; readonly ref: ProjectionRef } | { readonly eligible: false; readonly reason: ExclusionReason; readonly privacyClass: PrivacyClass }> {
  const privacyClass = trace?.privacyClass ?? "internal";
  if (!trace) return { eligible: false, reason: "insufficient_evidence", privacyClass };
  if (sensitive(privacyClass)) return { eligible: false, reason: "sensitive", privacyClass };
  const span = await ctx.db.query("fullSpanEvalRuns").withIndex("by_trace", (q) => q.eq("agentTraceId", trace._id)).unique();
  if (!span || span.status !== "ready") return { eligible: false, reason: "not_full_span", privacyClass };
  if (span.runQualification === "fixture_only") return { eligible: false, reason: "fixture_only", privacyClass };
  if (span.runQualification !== "quality_eligible" || !span.canJudgeTaskSuccess || span.evidenceCompleteness !== "complete" || !span.reviewerProjectionStorageId) return { eligible: false, reason: "insufficient_evidence", privacyClass };
  if (!span.trainingTaskHash || !SHA256.test(span.trainingTaskHash)) return { eligible: false, reason: "invalid_task_hash", privacyClass };
  return { eligible: true, ref: { storageId: span.reviewerProjectionStorageId, taskHash: span.trainingTaskHash, privacyClass } };
}

async function sha256Bytes(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function snapshotRef(storage: { get: (id: Id<"_storage">) => Promise<Blob | null> }, ref: ProjectionRef): Promise<ProjectionSnapshot> {
  const blob = await storage.get(ref.storageId);
  if (!blob) throw new Error("Reviewer projection is unavailable for approval.");
  if (trainingExportSizeViolation({ projectionBytes: blob.size })) throw new Error("Reviewer projection exceeds the training approval byte limit.");
  const bytes = await blob.arrayBuffer();
  let projection: ReturnType<typeof parseHarborReviewerProjection>;
  try {
    const raw: unknown = JSON.parse(new TextDecoder().decode(bytes));
    projection = parseHarborReviewerProjection(raw);
  } catch {
    throw new Error("Reviewer projection is malformed for training approval.");
  }
  if (!projection.taskRevision) throw new Error("Reviewer projection lacks the task revision required for training approval.");
  const derivedTaskHash = await deriveTrainingTaskHash(projection.taskPrompt, projection.taskRevision);
  if (derivedTaskHash !== ref.taskHash) throw new Error("Reviewer projection task hash mismatch.");
  return { ...ref, sha256: await sha256Bytes(bytes) };
}

export const prepareVerdictApproval = internalQuery({
  args: { campaignId: v.id("verdictReviewCampaigns") },
  handler: async (ctx, args): Promise<PreparedResult> => {
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) throw new Error("Review not found.");
    await requireProjectRole(ctx, campaign.projectId, ["owner"]);
    if (campaign.status !== "closed") throw new Error("Close the review before granting training approval.");
    const active = (await ctx.db.query("trainingApprovals").withIndex("by_verdict_campaign", (q) => q.eq("verdictCampaignId", campaign._id)).order("desc").collect()).find((row) => row.status === "active");
    if (active) return { existing: { approvalId: active._id, eligibleCount: active.eligibleCount, excludedCount: active.excludedCount }, projectId: campaign.projectId, reviewerCount: active.reviewerCount, candidates: [] as PreparedCandidate[] };
    const items = await ctx.db.query("verdictReviewItems").withIndex("by_campaign", (q) => q.eq("campaignId", campaign._id)).take(TRAINING_EXPORT_LIMITS.maxCandidates + 1);
    if (items.length === 0 || trainingExportSizeViolation({ candidates: items.length })) throw new Error(`Training approval supports 1 to ${TRAINING_EXPORT_LIMITS.maxCandidates} candidates.`);
    items.sort((a, b) => a.sortOrder - b.sortOrder);
    const candidates: PreparedCandidate[] = [];
    const reviewers = new Set<string>();
    for (const item of items) {
      const trace = await ctx.db.get(item.agentTraceId);
      const decisions = await ctx.db.query("verdictReviewDecisions").withIndex("by_item", (q) => q.eq("itemId", item._id)).collect();
      decisions.forEach((decision) => reviewers.add(String(decision.userId)));
      const evidence = await projectionRef(ctx, trace);
      if (!evidence.eligible) candidates.push({ agentTraceId: item.agentTraceId, privacyClass: evidence.privacyClass, reviewerCount: decisions.length, eligibility: "excluded", exclusionReason: evidence.reason });
      else if (decisions.some((decision) => decision.rating === "weak" || decision.rating === "insufficient_evidence")) candidates.push({ agentTraceId: item.agentTraceId, projection: evidence.ref, taskHash: evidence.ref.taskHash, privacyClass: evidence.ref.privacyClass, reviewerCount: decisions.length, eligibility: "excluded", exclusionReason: "review_disagreement" });
      else if (!decisions.some((decision) => decision.rating === "best")) candidates.push({ agentTraceId: item.agentTraceId, projection: evidence.ref, taskHash: evidence.ref.taskHash, privacyClass: evidence.ref.privacyClass, reviewerCount: decisions.length, eligibility: "excluded", exclusionReason: "no_approved_verdict" });
      else candidates.push({ agentTraceId: item.agentTraceId, projection: evidence.ref, taskHash: evidence.ref.taskHash, privacyClass: evidence.ref.privacyClass, reviewerCount: decisions.length, eligibility: "eligible" });
    }
    return { existing: null, projectId: campaign.projectId, reviewerCount: reviewers.size, candidates };
  },
});

export const prepareComparisonApproval = internalQuery({
  args: { campaignId: v.id("comparisonCampaigns") },
  handler: async (ctx, args): Promise<PreparedResult> => {
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) throw new Error("Comparison review not found.");
    await requireProjectRole(ctx, campaign.projectId, ["owner"]);
    if (campaign.status !== "closed") throw new Error("Close the comparison before granting training approval.");
    const active = (await ctx.db.query("trainingApprovals").withIndex("by_comparison_campaign", (q) => q.eq("comparisonCampaignId", campaign._id)).order("desc").collect()).find((row) => row.status === "active");
    if (active) return { existing: { approvalId: active._id, eligibleCount: active.eligibleCount, excludedCount: active.excludedCount }, projectId: campaign.projectId, reviewerCount: active.reviewerCount, candidates: [] as PreparedCandidate[] };
    const matchups = await ctx.db.query("agentTraceMatchups").withIndex("by_campaign", (q) => q.eq("campaignId", campaign._id)).take(TRAINING_EXPORT_LIMITS.maxCandidates + 1);
    if (matchups.length === 0 || trainingExportSizeViolation({ candidates: matchups.length })) throw new Error(`Training approval supports 1 to ${TRAINING_EXPORT_LIMITS.maxCandidates} candidates.`);
    matchups.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    const candidates: PreparedCandidate[] = [];
    const reviewers = new Set<string>();
    for (const matchup of matchups) {
      const decisions = await ctx.db.query("agentTraceMatchupDecisions").withIndex("by_matchup", (q) => q.eq("matchupId", matchup._id)).collect();
      decisions.forEach((decision) => reviewers.add(String(decision.userId)));
      const directional = decisions.filter((decision) => decision.winner === "left" || decision.winner === "right");
      const winner = directional[0]?.winner;
      if (matchup.comparabilityStatus !== "valid" || !matchup.prefixHash) { candidates.push({ matchupId: matchup._id, privacyClass: "internal", reviewerCount: decisions.length, eligibility: "excluded", exclusionReason: "non_comparable_prefix" }); continue; }
      if (directional.length === 0 || decisions.some((decision) => ["tie", "neither", "skip"].includes(decision.winner))) { candidates.push({ matchupId: matchup._id, privacyClass: "internal", reviewerCount: decisions.length, eligibility: "excluded", exclusionReason: "no_preference" }); continue; }
      if ((winner !== "left" && winner !== "right") || directional.some((decision) => decision.winner !== winner)) { candidates.push({ matchupId: matchup._id, privacyClass: "internal", reviewerCount: decisions.length, eligibility: "excluded", exclusionReason: "review_disagreement" }); continue; }
      const [leftTrace, rightTrace] = await Promise.all([ctx.db.get(matchup.leftTraceId), ctx.db.get(matchup.rightTraceId)]);
      const [left, right] = await Promise.all([projectionRef(ctx, leftTrace), projectionRef(ctx, rightTrace)]);
      if (!left.eligible) { candidates.push({ matchupId: matchup._id, winner, privacyClass: left.privacyClass, reviewerCount: decisions.length, eligibility: "excluded", exclusionReason: left.reason }); continue; }
      if (!right.eligible) { candidates.push({ matchupId: matchup._id, winner, privacyClass: right.privacyClass, reviewerCount: decisions.length, eligibility: "excluded", exclusionReason: right.reason }); continue; }
      const privacyClass = combinedPrivacy(left.ref.privacyClass, right.ref.privacyClass);
      if (left.ref.taskHash !== right.ref.taskHash) { candidates.push({ matchupId: matchup._id, winner, leftProjection: left.ref, rightProjection: right.ref, privacyClass, reviewerCount: decisions.length, eligibility: "excluded", exclusionReason: "task_mismatch" }); continue; }
      candidates.push({ matchupId: matchup._id, winner, divergenceStepIndex: matchup.divergenceStepIndex, sharedPrefixHash: matchup.prefixHash, taskHash: left.ref.taskHash, leftProjection: left.ref, rightProjection: right.ref, privacyClass, reviewerCount: decisions.length, eligibility: "eligible" });
    }
    return { existing: null, projectId: campaign.projectId, reviewerCount: reviewers.size, candidates };
  },
});

export const commitApproval = internalMutation({
  args: { kind: v.union(v.literal("verdict_campaign"), v.literal("comparison_campaign")), campaignId: v.string(), projectId: v.id("projects"), reviewerCount: v.number(), candidates: v.array(CANDIDATE), approvedById: v.id("users") },
  handler: async (ctx, args) => {
    if (args.candidates.length === 0 || trainingExportSizeViolation({ candidates: args.candidates.length })) throw new Error("Training approval candidate count is invalid.");
    const normalizedCampaignId = args.kind === "verdict_campaign" ? ctx.db.normalizeId("verdictReviewCampaigns", args.campaignId) : ctx.db.normalizeId("comparisonCampaigns", args.campaignId);
    if (!normalizedCampaignId) throw new Error("Training approval campaign is invalid.");
    const campaign = await ctx.db.get(normalizedCampaignId);
    if (!campaign || campaign.projectId !== args.projectId || campaign.status !== "closed") throw new Error("Training approval campaign changed before commit.");
    const active = args.kind === "verdict_campaign"
      ? (await ctx.db.query("trainingApprovals").withIndex("by_verdict_campaign", (q) => q.eq("verdictCampaignId", normalizedCampaignId as Id<"verdictReviewCampaigns">)).collect()).find((row) => row.status === "active")
      : (await ctx.db.query("trainingApprovals").withIndex("by_comparison_campaign", (q) => q.eq("comparisonCampaignId", normalizedCampaignId as Id<"comparisonCampaigns">)).collect()).find((row) => row.status === "active");
    if (active) return { approvalId: active._id, eligibleCount: active.eligibleCount, excludedCount: active.excludedCount };
    for (const candidate of args.candidates.filter((item) => item.eligibility === "eligible")) {
      if (args.kind === "verdict_campaign") {
        if (!candidate.agentTraceId || !candidate.projection || candidate.taskHash !== candidate.projection.taskHash) throw new Error("Verdict approval snapshot is incomplete.");
        const span = await ctx.db.query("fullSpanEvalRuns").withIndex("by_trace", (q) => q.eq("agentTraceId", candidate.agentTraceId)).unique();
        if (!span || span.reviewerProjectionStorageId !== candidate.projection.storageId || span.trainingTaskHash !== candidate.taskHash) throw new Error("Verdict approval source changed before commit.");
      } else {
        if (!candidate.matchupId || !candidate.leftProjection || !candidate.rightProjection || !candidate.sharedPrefixHash || candidate.divergenceStepIndex === undefined || candidate.leftProjection.taskHash !== candidate.rightProjection.taskHash || candidate.taskHash !== candidate.leftProjection.taskHash) throw new Error("Comparison approval snapshot is incomplete or tasks differ.");
        const matchup = await ctx.db.get(candidate.matchupId);
        if (!matchup || matchup.campaignId !== normalizedCampaignId || matchup.prefixHash !== candidate.sharedPrefixHash || matchup.divergenceStepIndex !== candidate.divergenceStepIndex) throw new Error("Comparison approval source changed before commit.");
        const [leftSpan, rightSpan] = await Promise.all([
          ctx.db.query("fullSpanEvalRuns").withIndex("by_trace", (q) => q.eq("agentTraceId", matchup.leftTraceId)).unique(),
          ctx.db.query("fullSpanEvalRuns").withIndex("by_trace", (q) => q.eq("agentTraceId", matchup.rightTraceId)).unique(),
        ]);
        if (!leftSpan || !rightSpan || leftSpan.reviewerProjectionStorageId !== candidate.leftProjection.storageId || rightSpan.reviewerProjectionStorageId !== candidate.rightProjection.storageId || leftSpan.trainingTaskHash !== candidate.taskHash || rightSpan.trainingTaskHash !== candidate.taskHash) throw new Error("Comparison approval evidence changed before commit.");
      }
    }
    const eligibleCount = args.candidates.filter((candidate) => candidate.eligibility === "eligible").length;
    if (eligibleCount === 0) throw new Error("Training approval denied: this review has no quality-eligible, non-sensitive approved candidates.");
    const verdictCampaignId = args.kind === "verdict_campaign" ? normalizedCampaignId as Id<"verdictReviewCampaigns"> : undefined;
    const comparisonCampaignId = args.kind === "comparison_campaign" ? normalizedCampaignId as Id<"comparisonCampaigns"> : undefined;
    const approvalId = await ctx.db.insert("trainingApprovals", { projectId: args.projectId, kind: args.kind, verdictCampaignId, comparisonCampaignId, status: "active", policyVersion: TRAINING_POLICY_VERSION, candidateCount: args.candidates.length, reviewerCount: args.reviewerCount, eligibleCount, excludedCount: args.candidates.length - eligibleCount, approvedById: args.approvedById, approvedAt: Date.now() });
    for (let sortOrder = 0; sortOrder < args.candidates.length; sortOrder++) {
      const candidate = args.candidates[sortOrder]; if (!candidate) continue;
      await ctx.db.insert("trainingApprovalItems", { approvalId, projectId: args.projectId, sortOrder, agentTraceId: candidate.agentTraceId, matchupId: candidate.matchupId, winner: candidate.winner, divergenceStepIndex: candidate.divergenceStepIndex, sharedPrefixHash: candidate.sharedPrefixHash, taskHash: candidate.taskHash, leftTaskHash: candidate.leftProjection?.taskHash, rightTaskHash: candidate.rightProjection?.taskHash, projectionStorageId: candidate.projection?.storageId, projectionSha256: candidate.projection?.sha256, leftProjectionStorageId: candidate.leftProjection?.storageId, leftProjectionSha256: candidate.leftProjection?.sha256, rightProjectionStorageId: candidate.rightProjection?.storageId, rightProjectionSha256: candidate.rightProjection?.sha256, privacyClass: candidate.privacyClass, reviewerCount: candidate.reviewerCount, eligibility: candidate.eligibility, exclusionReason: candidate.exclusionReason });
    }
    return { approvalId, eligibleCount, excludedCount: args.candidates.length - eligibleCount };
  },
});

async function snapshotPrepared(storage: { get: (id: Id<"_storage">) => Promise<Blob | null> }, candidates: ReadonlyArray<PreparedCandidate>): Promise<Candidate[]> {
  const result: Candidate[] = [];
  for (const candidate of candidates) result.push({ ...candidate, projection: candidate.projection ? await snapshotRef(storage, candidate.projection) : undefined, leftProjection: candidate.leftProjection ? await snapshotRef(storage, candidate.leftProjection) : undefined, rightProjection: candidate.rightProjection ? await snapshotRef(storage, candidate.rightProjection) : undefined });
  return result;
}

/** Owner action: hash exact verdict projection bytes, then atomically commit refs. */
export const approveVerdictCampaign = action({
  args: { campaignId: v.id("verdictReviewCampaigns") },
  handler: async (ctx, args): Promise<ApprovalResult> => {
    const prepared: PreparedResult = await ctx.runQuery(internal.trainingApprovals.prepareVerdictApproval, args);
    if (prepared.existing) return prepared.existing;
    const userId: Id<"users"> = await ctx.runQuery(internal.trainingApprovals.ownerForApproval, { projectId: prepared.projectId });
    return await ctx.runMutation(internal.trainingApprovals.commitApproval, { kind: "verdict_campaign", campaignId: String(args.campaignId), projectId: prepared.projectId, reviewerCount: prepared.reviewerCount, candidates: await snapshotPrepared(ctx.storage, prepared.candidates), approvedById: userId });
  },
});

/** Owner action: hash both exact DPO projection blobs, then atomically commit. */
export const approveComparisonCampaign = action({
  args: { campaignId: v.id("comparisonCampaigns") },
  handler: async (ctx, args): Promise<ApprovalResult> => {
    const prepared: PreparedResult = await ctx.runQuery(internal.trainingApprovals.prepareComparisonApproval, args);
    if (prepared.existing) return prepared.existing;
    const userId: Id<"users"> = await ctx.runQuery(internal.trainingApprovals.ownerForApproval, { projectId: prepared.projectId });
    return await ctx.runMutation(internal.trainingApprovals.commitApproval, { kind: "comparison_campaign", campaignId: String(args.campaignId), projectId: prepared.projectId, reviewerCount: prepared.reviewerCount, candidates: await snapshotPrepared(ctx.storage, prepared.candidates), approvedById: userId });
  },
});

export const ownerForApproval = internalQuery({ args: { projectId: v.id("projects") }, handler: async (ctx, args) => (await requireProjectRole(ctx, args.projectId, ["owner"])).userId });

/** Revoke approval and delete every bounded export blob so issued URLs die. */
export const revoke = mutation({
  args: { approvalId: v.id("trainingApprovals") },
  handler: async (ctx, args) => {
    const approval = await ctx.db.get(args.approvalId); if (!approval) throw new Error("Training approval not found.");
    const { userId } = await requireProjectRole(ctx, approval.projectId, ["owner"]);
    if (approval.status === "revoked") return { revoked: true };
    const exports = await ctx.db.query("trainingExports").withIndex("by_approval", (q) => q.eq("trainingApprovalId", approval._id)).take(TRAINING_EXPORT_LIMITS.maxExportsPerApproval + 1);
    if (exports.length > TRAINING_EXPORT_LIMITS.maxExportsPerApproval) throw new Error("Training approval has too many exports to revoke safely.");
    await ctx.db.patch(approval._id, { status: "revoked", revokedById: userId, revokedAt: Date.now() });
    for (const row of exports) { await ctx.storage.delete(row.storageId); if (row.manifestStorageId) await ctx.storage.delete(row.manifestStorageId); }
    return { revoked: true };
  },
});

export const getForVerdictCampaign = query({ args: { campaignId: v.id("verdictReviewCampaigns") }, handler: async (ctx, args) => { const campaign = await ctx.db.get(args.campaignId); if (!campaign) throw new Error("Review not found."); const { collaborator } = await requireProjectRole(ctx, campaign.projectId, ["owner", "editor"]); const approval = (await ctx.db.query("trainingApprovals").withIndex("by_verdict_campaign", (q) => q.eq("verdictCampaignId", campaign._id)).order("desc").collect())[0]; return { canApprove: collaborator.role === "owner", approval: approval ? { id: approval._id, status: approval.status, policyVersion: approval.policyVersion, eligibleCount: approval.eligibleCount, excludedCount: approval.excludedCount, approvedAt: approval.approvedAt, revokedAt: approval.revokedAt } : null }; } });
export const getForComparisonCampaign = query({ args: { campaignId: v.id("comparisonCampaigns") }, handler: async (ctx, args) => { const campaign = await ctx.db.get(args.campaignId); if (!campaign) throw new Error("Comparison review not found."); const { collaborator } = await requireProjectRole(ctx, campaign.projectId, ["owner", "editor"]); const approval = (await ctx.db.query("trainingApprovals").withIndex("by_comparison_campaign", (q) => q.eq("comparisonCampaignId", campaign._id)).order("desc").collect())[0]; return { canApprove: collaborator.role === "owner", approval: approval ? { id: approval._id, status: approval.status, policyVersion: approval.policyVersion, eligibleCount: approval.eligibleCount, excludedCount: approval.excludedCount, approvedAt: approval.approvedAt, revokedAt: approval.revokedAt } : null }; } });
