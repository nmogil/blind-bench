/**
 * #53: training-data export bridge. One engine, two sources
 * (output_preference | trajectory), feeding the #53 serializers + data-boundary
 * gate (convex/lib/trainingExport.ts).
 *
 * Split (actions have no ctx.db; trajectory bodies live in storage):
 *  - `gatherOutputPrefRows` (internalQuery): output-preference rows are complete
 *    (outputContent is inline text) — returns ClassifiedRow[] ready to gate.
 *  - `gatherTrajectoryPlan` (internalQuery): trajectory bodies are in storage, so
 *    it returns a PLAN (step metadata + fullBodyStorageId refs); the action reads
 *    the blobs and assembles the rows.
 *  - `generateExport` (action): gather → (trajectory: read bodies) → gate →
 *    toJsonl → store blob → record row. Auth is owner/editor ONLY (export is
 *    privileged + un-blinded — never evaluators).
 *
 * Anonymization is by CONSTRUCTION: rows are built from an allowlist (resolved
 * prompt, output/step text, blind labels, counts) — never raw docs, org names,
 * emails, or user ids. `gateRows` is the backstop.
 */
import { v } from "convex/values";
import { action, internalMutation, internalQuery, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireProjectRole } from "./lib/auth";
import { readMessages } from "./lib/messages";
import {
  parseHarborReviewerProjection,
  type HarborReviewerProjection,
} from "../src/lib/evals/harborEvidence";
import {
  buildExportManifest,
  gateRows,
  toJsonl,
  moreSensitive,
  serializeAgentObservableEvent,
  serializeAgentObservableTrajectoryContext,
  TRAINING_EXPORT_LIMITS,
  trainingExportSizeViolation,
  utf8Bytes,
  type ClassifiedRow,
  type ExcludedRow,
  type ExportFormat,
  type ExportManifest,
  type ExportSourceStats,
  type PrivacyClass,
  type StepMeta,
} from "./lib/trainingExport";

const SOURCE = v.union(v.literal("trajectory"), v.literal("output_preference"));
const FORMAT = v.union(v.literal("dpo"), v.literal("annotated"), v.literal("sft"));

const DOWNLOAD_TTL_MS = 60 * 60 * 1000; // AC6: download expires after 1 hour
const MAX_PAIRS_PER_RUN = 20; // cap best×weak explosion per run

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Buffer(value: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// {{word}} substitution — mirrors convex/runsActions.ts substituteVariables.
const substitute = (t: string, vars: Record<string, string>): string =>
  t.replace(/\{\{(\w+)\}\}/g, (m, n: string) => vars[n] ?? m);

const metaOf = (s: Doc<"agentTraceSteps">): StepMeta => ({
  kind: s.kind,
  role: s.role,
  toolName: s.toolName,
  label: s.label,
  policy: s.policy,
  action: s.action,
  reason: s.reason,
});

// --- output-preference source (complete rows, no storage) --------------------

export const gatherOutputPrefRows = internalQuery({
  args: { projectId: v.id("projects"), format: FORMAT },
  handler: async (
    ctx,
    args,
  ): Promise<{ rows: ClassifiedRow[]; stats: ExportSourceStats }> => {
    await requireProjectRole(ctx, args.projectId, ["owner", "editor"]);
    const rows: ClassifiedRow[] = [];
    let sourceUnits = 0;
    const reviewerIds = new Set<string>();
    const runs = await ctx.db
      .query("promptRuns")
      .withIndex("by_project_and_status", (q) =>
        q.eq("projectId", args.projectId).eq("status", "completed"),
      )
      .collect();

    for (const run of runs) {
      const outputs = await ctx.db
        .query("runOutputs")
        .withIndex("by_run", (q) => q.eq("runId", run._id))
        .collect();
      if (outputs.length === 0) continue;
      const prefs = await ctx.db
        .query("outputPreferences")
        .withIndex("by_run", (q) => q.eq("runId", run._id))
        .collect();
      if (prefs.length === 0) continue;

      // Tally ratings per output; classify best (≥1 best, 0 weak) vs weak (≥1 weak).
      const tally = new Map<string, { best: number; weak: number }>();
      for (const p of prefs) {
        const t = tally.get(p.outputId) ?? { best: 0, weak: 0 };
        if (p.rating === "best") t.best++;
        else if (p.rating === "weak") t.weak++;
        tally.set(p.outputId, t);
      }
      const best = outputs.filter((o) => {
        const t = tally.get(o._id);
        return t && t.best > 0 && t.weak === 0;
      });
      const weak = outputs.filter((o) => {
        const t = tally.get(o._id);
        return t && t.weak > 0;
      });
      if (best.length === 0) continue;

      // Resolve the prompt (variables substituted) from the run's version.
      const version = await ctx.db.get(run.promptVersionId);
      let vars: Record<string, string> | undefined = run.inputSnapshot?.text;
      if (!vars && run.testCaseId) {
        const tc = await ctx.db.get(run.testCaseId);
        vars = tc?.variableValues ?? undefined;
      }
      vars = vars ?? run.inlineVariables ?? {};
      const messages = version
        ? readMessages(version).map((m) => ({ role: m.role, content: substitute(m.content ?? "", vars!) }))
        : [];
      const promptText = messages.map((m) => `${m.role}: ${m.content}`).join("\n");
      const evaluatorCount = new Set(prefs.map((p) => p.userId)).size;

      const before = rows.length;
      if (args.format === "dpo") {
        let made = 0;
        for (const b of best) {
          for (const w of weak) {
            if (made >= MAX_PAIRS_PER_RUN) break;
            rows.push({
              privacyClass: "internal",
              row: {
                kind: "dpo",
                prompt: promptText,
                chosen: b.outputContent,
                rejected: w.outputContent,
                metadata: {
                  blind_labels: [b.blindLabel, w.blindLabel],
                  evaluator_count: evaluatorCount,
                },
              },
            });
            made++;
          }
        }
      } else if (args.format === "sft") {
        for (const b of best) {
          rows.push({
            privacyClass: "internal",
            row: {
              kind: "sft",
              messages: [...messages, { role: "assistant", content: b.outputContent }],
              metadata: { preference: "best" },
            },
          });
        }
      }
      if (rows.length > before) {
        sourceUnits++;
        for (const p of prefs) reviewerIds.add(p.userId);
      }
    }
    return { rows, stats: { sourceUnits, reviewers: reviewerIds.size } };
  },
});

// --- trajectory source (plan → action reads storage) -------------------------

interface StepRef {
  meta: StepMeta;
  storageId?: Id<"_storage">;
}
interface TrajectoryPlanRow {
  privacyClass: PrivacyClass;
  metadata: Record<string, unknown>;
  excludeReason?: ExcludedRow["reason"];
  prefix?: StepRef[];
  chosen?: StepRef;
  rejected?: StepRef;
  messages?: StepRef[];
  finalAnswer?: Id<"_storage">;
}

export const gatherTrajectoryPlan = internalQuery({
  args: {
    projectId: v.id("projects"),
    format: FORMAT,
    campaignId: v.optional(v.id("comparisonCampaigns")),
    verdictCampaignId: v.optional(v.id("verdictReviewCampaigns")),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ plan: TrajectoryPlanRow[]; stats: ExportSourceStats }> => {
    await requireProjectRole(ctx, args.projectId, ["owner", "editor"]);
    if (args.campaignId !== undefined) {
      const campaign = await ctx.db.get(args.campaignId);
      if (!campaign || campaign.projectId !== args.projectId) {
        throw new Error("Comparison campaign not found.");
      }
      if (campaign.status !== "closed") {
        throw new Error("Close the comparison review before exporting training data.");
      }
    }
    if (args.verdictCampaignId !== undefined) {
      const campaign = await ctx.db.get(args.verdictCampaignId);
      if (!campaign || campaign.projectId !== args.projectId) {
        throw new Error("Run review not found.");
      }
      if (campaign.status !== "closed") {
        throw new Error("Close the run review before exporting training data.");
      }
    }
    const stepsOf = (traceId: Id<"agentTraces">) =>
      ctx.db
        .query("agentTraceSteps")
        .withIndex("by_trace_and_index", (q) => q.eq("agentTraceId", traceId))
        .collect();

    const plan: TrajectoryPlanRow[] = [];
    const reviewerIds = new Set<string>();

    if (args.format === "dpo") {
      if (args.verdictCampaignId !== undefined) {
        throw new Error("Run verdict reviews export as SFT, not DPO.");
      }
      const allMatchups = await ctx.db
        .query("agentTraceMatchups")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .collect();
      const matchups = args.campaignId === undefined
        ? allMatchups
        : allMatchups.filter((matchup) => matchup.campaignId === args.campaignId);
      for (const m of matchups) {
        const [leftTrace, rightTrace] = await Promise.all([
          ctx.db.get(m.leftTraceId),
          ctx.db.get(m.rightTraceId),
        ]);
        if (!leftTrace || !rightTrace) continue;
        const privacyClass = moreSensitive(leftTrace.privacyClass, rightTrace.privacyClass);
        if (m.comparabilityStatus !== "valid") {
          plan.push({
            privacyClass,
            metadata: {},
            excludeReason: "non_comparable_prefix",
          });
          continue;
        }
        const decisions = await ctx.db
          .query("agentTraceMatchupDecisions")
          .withIndex("by_matchup", (q) => q.eq("matchupId", m._id))
          .collect();
        for (const decision of decisions) reviewerIds.add(decision.userId);
        const directional = decisions.filter(
          (decision) => decision.winner === "left" || decision.winner === "right",
        );
        if (decisions.some((decision) =>
          decision.winner === "tie" ||
          decision.winner === "neither" ||
          decision.winner === "skip")) {
          plan.push({ privacyClass, metadata: {}, excludeReason: "no_preference" });
          continue;
        }
        if (directional.length === 0) continue;
        const winner = directional[0]?.winner;
        if (!winner || directional.some((decision) => decision.winner !== winner)) {
          plan.push({
            privacyClass,
            metadata: { reviewer_count: directional.length },
            excludeReason: "review_disagreement",
          });
          continue;
        }
        const winnerId = winner === "left" ? m.leftTraceId : m.rightTraceId;
        const loserId = winner === "left" ? m.rightTraceId : m.leftTraceId;
        const winnerTrace = winner === "left" ? leftTrace : rightTrace;
        const loserTrace = winner === "left" ? rightTrace : leftTrace;
        const [winnerSteps, loserSteps] = await Promise.all([
          stepsOf(winnerId),
          stepsOf(loserId),
        ]);
        const chosen = winnerSteps.find((step) => step.stepIndex === m.divergenceStepIndex);
        const rejected = loserSteps.find((step) => step.stepIndex === m.divergenceStepIndex);
        if (!chosen || !rejected) continue;
        const reasonTags = [...new Set(directional.flatMap((decision) => decision.reasonTags))];
        plan.push({
          privacyClass: moreSensitive(winnerTrace.privacyClass, loserTrace.privacyClass),
          metadata: {
            reason_tags: reasonTags,
            reviewer_count: directional.length,
            prefix_hash_verified: true,
          },
          prefix: winnerSteps
            .filter((step) => step.stepIndex < m.divergenceStepIndex)
            .map((step) => ({ meta: metaOf(step), storageId: step.fullBodyStorageId })),
          chosen: { meta: metaOf(chosen), storageId: chosen.fullBodyStorageId },
          rejected: { meta: metaOf(rejected), storageId: rejected.fullBodyStorageId },
        });
      }
    } else if (args.format === "sft") {
      if (args.verdictCampaignId !== undefined) {
        const verdictCampaignId = args.verdictCampaignId;
        const items = await ctx.db
          .query("verdictReviewItems")
          .withIndex("by_campaign", (q) => q.eq("campaignId", verdictCampaignId))
          .collect();
        for (const item of items) {
          const tr = await ctx.db.get(item.agentTraceId);
          if (!tr || tr.status !== "ready") continue;
          const verdicts = await ctx.db
            .query("verdictReviewDecisions")
            .withIndex("by_item", (q) => q.eq("itemId", item._id))
            .collect();
          for (const verdict of verdicts) reviewerIds.add(verdict.userId);
          if (verdicts.some((verdict) => verdict.rating === "weak")) {
            plan.push({
              privacyClass: tr.privacyClass,
              metadata: { reviewer_count: verdicts.length },
              excludeReason: "review_disagreement",
            });
            continue;
          }
          if (!verdicts.some((verdict) => verdict.rating === "best")) {
            plan.push({
              privacyClass: tr.privacyClass,
              metadata: { reviewer_count: verdicts.length },
              excludeReason: "no_approved_verdict",
            });
            continue;
          }
          const steps = await stepsOf(tr._id);
          plan.push({
            privacyClass: tr.privacyClass,
            metadata: { verdict: "best", reviewer_count: verdicts.length },
            messages: steps
              .filter((step) =>
                step.kind === "message" &&
                ["system", "user", "assistant"].includes(step.role ?? ""),
              )
              .map((step) => ({
                meta: metaOf(step),
                storageId: step.fullBodyStorageId,
              })),
            finalAnswer: tr.finalAnswerStorageId,
          });
        }
      } else {
        const traces = await ctx.db
          .query("agentTraces")
          .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
          .collect();
        for (const tr of traces) {
          if (tr.status !== "ready") continue;
          const verdicts = await ctx.db
            .query("agentTraceVerdicts")
            .withIndex("by_trace", (q) => q.eq("agentTraceId", tr._id))
            .collect();
          if (!verdicts.some((verdict) => verdict.rating === "best")) continue;
          if (verdicts.some((verdict) => verdict.rating === "weak")) {
            plan.push({
              privacyClass: tr.privacyClass,
              metadata: {},
              excludeReason: "review_disagreement",
            });
            for (const verdict of verdicts) reviewerIds.add(verdict.userId);
            continue;
          }
          const steps = await stepsOf(tr._id);
          plan.push({
            privacyClass: tr.privacyClass,
            metadata: { verdict: "best" },
            messages: steps
              .filter((step) =>
                step.kind === "message" &&
                ["system", "user", "assistant"].includes(step.role ?? ""),
              )
              .map((step) => ({
                meta: metaOf(step),
                storageId: step.fullBodyStorageId,
              })),
            finalAnswer: tr.finalAnswerStorageId,
          });
          for (const verdict of verdicts) {
            if (verdict.rating === "best") reviewerIds.add(verdict.userId);
          }
        }
      }
    }
    return { plan, stats: { sourceUnits: plan.length, reviewers: reviewerIds.size } };
  },
});

// --- approved immutable source plan ------------------------------------------

type ApprovedPlanRow =
  | { readonly eligibility: "excluded"; readonly reason: ExcludedRow["reason"]; readonly privacyClass: PrivacyClass; readonly reviewerCount: number }
  | { readonly eligibility: "eligible"; readonly format: "sft"; readonly privacyClass: PrivacyClass; readonly reviewerCount: number; readonly projectionStorageId: Id<"_storage">; readonly projectionSha256: string; readonly taskHash: string }
  | { readonly eligibility: "eligible"; readonly format: "dpo"; readonly privacyClass: PrivacyClass; readonly reviewerCount: number; readonly winner: "left" | "right"; readonly divergenceStepIndex: number; readonly sharedPrefixHash: string; readonly taskHash: string; readonly leftProjectionStorageId: Id<"_storage">; readonly leftProjectionSha256: string; readonly rightProjectionStorageId: Id<"_storage">; readonly rightProjectionSha256: string };

/** Resolve only immutable approval snapshot references; never rediscover spans/matchups. */
export const gatherApprovedPlan = internalQuery({
  args: { projectId: v.id("projects"), approvalId: v.id("trainingApprovals"), format: FORMAT, campaignId: v.optional(v.id("comparisonCampaigns")), verdictCampaignId: v.optional(v.id("verdictReviewCampaigns")) },
  handler: async (ctx, args): Promise<{ readonly plan: ApprovedPlanRow[]; readonly policyVersion: string; readonly candidateCount: number; readonly reviewers: number }> => {
    await requireProjectRole(ctx, args.projectId, ["owner", "editor"]);
    const approval = await ctx.db.get(args.approvalId);
    if (!approval || approval.projectId !== args.projectId) throw new Error("Training approval not found for this project.");
    if (approval.status !== "active") throw new Error("Training approval is revoked; grant a new approval before exporting.");
    if (args.format === "sft" && (approval.kind !== "verdict_campaign" || approval.verdictCampaignId !== args.verdictCampaignId)) throw new Error("This training approval does not cover the selected run review.");
    if (args.format === "dpo" && (approval.kind !== "comparison_campaign" || approval.comparisonCampaignId !== args.campaignId)) throw new Error("This training approval does not cover the selected comparison review.");
    if (trainingExportSizeViolation({ candidates: approval.candidateCount })) throw new Error("Approved candidate count exceeds the export limit.");
    const items = await ctx.db.query("trainingApprovalItems").withIndex("by_approval_and_order", (q) => q.eq("approvalId", approval._id)).take(TRAINING_EXPORT_LIMITS.maxCandidates + 1);
    if (items.length !== approval.candidateCount || trainingExportSizeViolation({ candidates: items.length })) throw new Error("Training approval snapshot is incomplete or oversized.");
    const plan: ApprovedPlanRow[] = [];
    for (const item of items) {
      if (item.eligibility === "excluded") {
        plan.push({ eligibility: "excluded", reason: item.exclusionReason ?? "insufficient_evidence", privacyClass: item.privacyClass, reviewerCount: item.reviewerCount });
      } else if (args.format === "sft" && item.projectionStorageId && item.projectionSha256 && item.taskHash) {
        plan.push({ eligibility: "eligible", format: "sft", privacyClass: item.privacyClass, reviewerCount: item.reviewerCount, projectionStorageId: item.projectionStorageId, projectionSha256: item.projectionSha256, taskHash: item.taskHash });
      } else if (args.format === "dpo" && item.winner && item.divergenceStepIndex !== undefined && item.sharedPrefixHash && item.taskHash && item.leftTaskHash === item.taskHash && item.rightTaskHash === item.taskHash && item.leftProjectionStorageId && item.leftProjectionSha256 && item.rightProjectionStorageId && item.rightProjectionSha256) {
        plan.push({ eligibility: "eligible", format: "dpo", privacyClass: item.privacyClass, reviewerCount: item.reviewerCount, winner: item.winner, divergenceStepIndex: item.divergenceStepIndex, sharedPrefixHash: item.sharedPrefixHash, taskHash: item.taskHash, leftProjectionStorageId: item.leftProjectionStorageId, leftProjectionSha256: item.leftProjectionSha256, rightProjectionStorageId: item.rightProjectionStorageId, rightProjectionSha256: item.rightProjectionSha256 });
      } else {
        throw new Error("Training approval snapshot is invalid for the requested format.");
      }
    }
    return { plan, policyVersion: approval.policyVersion, candidateCount: approval.candidateCount, reviewers: approval.reviewerCount };
  },
});

// --- record + list -----------------------------------------------------------

export const recordExport = internalMutation({
  args: {
    projectId: v.id("projects"),
    source: SOURCE,
    format: FORMAT,
    storageId: v.id("_storage"),
    manifestStorageId: v.id("_storage"),
    trainingApprovalId: v.id("trainingApprovals"),
    campaignId: v.optional(v.id("comparisonCampaigns")),
    verdictCampaignId: v.optional(v.id("verdictReviewCampaigns")),
    rowCount: v.number(),
    excludedCount: v.number(),
    manifest: v.string(),
    createdById: v.id("users"),
    createdAt: v.number(),
  },
  handler: async (ctx, args): Promise<Id<"trainingExports">> => {
    const approval = await ctx.db.get(args.trainingApprovalId);
    if (!approval || approval.status !== "active" || approval.projectId !== args.projectId) throw new Error("Training approval is no longer active for this project.");
    const verdictBound = approval.kind === "verdict_campaign" && approval.verdictCampaignId === args.verdictCampaignId && args.campaignId === undefined && args.format === "sft";
    const comparisonBound = approval.kind === "comparison_campaign" && approval.comparisonCampaignId === args.campaignId && args.verdictCampaignId === undefined && args.format === "dpo";
    if (!verdictBound && !comparisonBound) throw new Error("Training approval campaign binding changed before export was recorded.");
    const existing = await ctx.db.query("trainingExports").withIndex("by_approval", (q) => q.eq("trainingApprovalId", approval._id)).take(TRAINING_EXPORT_LIMITS.maxExportsPerApproval);
    if (existing.length >= TRAINING_EXPORT_LIMITS.maxExportsPerApproval) throw new Error("Training approval export limit reached.");
    const { campaignId: _campaignId, verdictCampaignId: _verdictCampaignId, ...row } = args;
    return await ctx.db.insert("trainingExports", row);
  },
});

export const listExports = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProjectRole(ctx, args.projectId, ["owner", "editor"]);
    const rows = await ctx.db
      .query("trainingExports")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(50);
    return await Promise.all(rows.map(async (r) => {
      const expired = Date.now() - r.createdAt > DOWNLOAD_TTL_MS;
      const approval = r.trainingApprovalId ? await ctx.db.get(r.trainingApprovalId) : null;
      const availability = r.trainingApprovalId === undefined
        ? "legacy_unapproved" as const
        : !approval || approval.status === "revoked"
          ? "revoked" as const
          : expired
            ? "expired" as const
            : "available" as const;
      return {
        _id: r._id,
        source: r.source,
        format: r.format,
        rowCount: r.rowCount,
        excludedCount: r.excludedCount,
        // Parsed legacy sidecar; never used as authorization evidence.
        manifest: r.manifest ? (JSON.parse(r.manifest) as ExportManifest) : null,
        createdAt: r.createdAt,
        expired,
        availability,
      };
    }));
  },
});

// --- the export action -------------------------------------------------------

export const generateExport = action({
  args: {
    projectId: v.id("projects"),
    source: SOURCE,
    format: FORMAT,
    // Retained in the RPC shape for explicit rejection of legacy clients.
    allowSensitive: v.optional(v.boolean()),
    campaignId: v.optional(v.id("comparisonCampaigns")),
    verdictCampaignId: v.optional(v.id("verdictReviewCampaigns")),
    trainingApprovalId: v.optional(v.id("trainingApprovals")),
  },
  handler: async (ctx, args): Promise<{
    exportId: Id<"trainingExports">;
    rowCount: number;
    excludedCount: number;
    manifest: ExportManifest;
  }> => {
    // Authenticate/authorize before revealing approval state to the caller.
    const userId = await ctx.runQuery(internal.exports.whoAmIForExport, { projectId: args.projectId });
    if (args.trainingApprovalId === undefined) throw new Error("A separate active training approval is required before export.");
    if (args.allowSensitive === true) throw new Error("Sensitive/private rows cannot be authorized for training export.");
    if (args.source !== "trajectory") throw new Error("Approved review exports use the trajectory source.");
    if ((args.campaignId === undefined) === (args.verdictCampaignId === undefined)) throw new Error("Export exactly one approved review result.");
    if (args.verdictCampaignId !== undefined && args.format !== "sft") throw new Error("Run verdict reviews export as SFT.");
    if (args.campaignId !== undefined && args.format !== "dpo") throw new Error("Comparison reviews export as DPO.");
    if (args.format === "annotated") throw new Error("Annotated export isn’t available yet — use DPO or SFT.");

    const approved = await ctx.runQuery(internal.exports.gatherApprovedPlan, {
      projectId: args.projectId,
      approvalId: args.trainingApprovalId,
      format: args.format,
      campaignId: args.campaignId,
      verdictCampaignId: args.verdictCampaignId,
    });
    const hydrated = await hydrateApprovedPlan(ctx, approved.plan);
    const gated = gateRows(hydrated.rows, { allowSensitive: false });
    const included = gated.included;
    const excluded = [...hydrated.excluded, ...gated.excluded];
    const jsonl = toJsonl(args.format as ExportFormat, included);
    const lines = jsonl ? jsonl.split("\n") : [];
    if (lines.some((line) => trainingExportSizeViolation({ rowBytes: utf8Bytes(line) }) !== null)) throw new Error("A training export row exceeds the serialized row limit.");
    if (trainingExportSizeViolation({ jsonlBytes: utf8Bytes(jsonl) })) throw new Error("Training export JSONL exceeds the total artifact limit.");
    const rowHashes = await Promise.all(lines.map(sha256));
    const datasetHash = await sha256(jsonl);
    const createdAt = Date.now();
    const manifest = buildExportManifest({
      source: "trajectory",
      format: args.format as ExportFormat,
      included,
      excluded,
      allowSensitive: false,
      stats: { sourceUnits: approved.candidateCount, reviewers: approved.reviewers },
      generatedAt: createdAt,
      approvalPolicyVersion: approved.policyVersion,
      rowHashes,
      datasetHash,
      candidateCount: approved.candidateCount,
    });
    if (!manifest.integrity.reconciled) throw new Error("Training export counts did not reconcile.");
    const manifestText = JSON.stringify(manifest, null, 2) + "\n";
    if (trainingExportSizeViolation({ manifestBytes: utf8Bytes(manifestText) })) throw new Error("Training export manifest exceeds the artifact limit.");

    let storageId: Id<"_storage"> | undefined;
    let manifestStorageId: Id<"_storage"> | undefined;
    try {
      storageId = await ctx.storage.store(new Blob([jsonl], { type: "application/jsonl" }));
      manifestStorageId = await ctx.storage.store(new Blob([manifestText], { type: "application/json" }));
      const exportId = await ctx.runMutation(internal.exports.recordExport, {
        projectId: args.projectId,
        source: "trajectory",
        format: args.format,
        storageId,
        manifestStorageId,
        trainingApprovalId: args.trainingApprovalId,
        campaignId: args.campaignId,
        verdictCampaignId: args.verdictCampaignId,
        rowCount: included.length,
        excludedCount: excluded.length,
        manifest: JSON.stringify(manifest),
        createdById: userId,
        createdAt,
      });
      return { exportId, rowCount: included.length, excludedCount: excluded.length, manifest };
    } catch (cause: unknown) {
      for (const id of [storageId, manifestStorageId]) {
        if (id !== undefined) {
          try { await ctx.storage.delete(id); } catch { /* best-effort idempotent cleanup */ }
        }
      }
      throw cause;
    }
  },
});

async function hydrateApprovedPlan(
  ctx: { storage: { get: (id: Id<"_storage">) => Promise<Blob | null> } },
  plan: ReadonlyArray<ApprovedPlanRow>,
): Promise<{ rows: ClassifiedRow[]; excluded: ExcludedRow[] }> {
  if (trainingExportSizeViolation({ candidates: plan.length })) throw new Error("Approved candidate count exceeds the export limit.");
  const readProjection = async (storageId: Id<"_storage">, expectedSha256: string): Promise<HarborReviewerProjection> => {
    const blob = await ctx.storage.get(storageId);
    if (!blob) throw new Error("Approved reviewer projection is unavailable.");
    if (trainingExportSizeViolation({ projectionBytes: blob.size })) throw new Error("Approved reviewer projection exceeds the byte limit.");
    const bytes = await blob.arrayBuffer();
    if (await sha256Buffer(bytes) !== expectedSha256) throw new Error("Approved reviewer projection hash mismatch.");
    const raw: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parseHarborReviewerProjection(raw);
  };
  const rows: ClassifiedRow[] = [];
  const excluded: ExcludedRow[] = [];
  let hydratedJsonlBytes = 0;
  const appendBounded = (classified: ClassifiedRow): void => {
    const format = classified.row.kind === "sft" ? "sft" : "dpo";
    const rowBytes = utf8Bytes(toJsonl(format, [classified.row]));
    if (trainingExportSizeViolation({ rowBytes })) throw new Error("A training export row exceeds the serialized row limit.");
    hydratedJsonlBytes += rowBytes + (rows.length > 0 ? 1 : 0);
    if (trainingExportSizeViolation({ jsonlBytes: hydratedJsonlBytes })) throw new Error("Training export JSONL exceeds the total artifact limit while hydrating.");
    rows.push(classified);
  };
  for (const candidate of plan) {
    if (candidate.eligibility === "excluded") {
      excluded.push({ reason: candidate.reason, privacyClass: candidate.privacyClass });
      continue;
    }
    if (candidate.format === "sft") {
      const projection = await readProjection(candidate.projectionStorageId, candidate.projectionSha256);
      appendBounded({
        privacyClass: candidate.privacyClass,
        row: { kind: "sft", messages: [
          { role: "user", content: serializeAgentObservableTrajectoryContext(projection) },
          { role: "assistant", content: projection.finalOutput },
        ] },
      });
      continue;
    }
    const [left, right] = await Promise.all([
      readProjection(candidate.leftProjectionStorageId, candidate.leftProjectionSha256),
      readProjection(candidate.rightProjectionStorageId, candidate.rightProjectionSha256),
    ]);
    const leftSteps = left.events.filter((event) => event.kind !== "final_output" && event.kind !== "termination");
    const rightSteps = right.events.filter((event) => event.kind !== "final_output" && event.kind !== "termination");
    const leftNext = leftSteps[candidate.divergenceStepIndex];
    const rightNext = rightSteps[candidate.divergenceStepIndex];
    if (!leftNext || !rightNext) {
      excluded.push({ reason: "insufficient_evidence", privacyClass: candidate.privacyClass });
      continue;
    }
    if (leftNext.kind === "assistant_reasoning" || rightNext.kind === "assistant_reasoning") {
      excluded.push({ reason: "hidden_reasoning", privacyClass: candidate.privacyClass });
      continue;
    }
    const chosen = candidate.winner === "left" ? leftNext : rightNext;
    const rejected = candidate.winner === "left" ? rightNext : leftNext;
    const serializedChosen = serializeAgentObservableEvent(chosen);
    const serializedRejected = serializeAgentObservableEvent(rejected);
    if (serializedChosen === null || serializedRejected === null) {
      excluded.push({ reason: "post_hoc_or_non_observable", privacyClass: candidate.privacyClass });
      continue;
    }
    const prefixProjection = candidate.winner === "left" ? left : right;
    const prefixEvents = (candidate.winner === "left" ? leftSteps : rightSteps).slice(0, candidate.divergenceStepIndex);
    appendBounded({
      privacyClass: candidate.privacyClass,
      row: {
        kind: "dpo",
        prompt: serializeAgentObservableTrajectoryContext({ taskPrompt: prefixProjection.taskPrompt, events: prefixEvents }),
        chosen: serializedChosen,
        rejected: serializedRejected,
        metadata: { reviewer_count: candidate.reviewerCount, shared_prefix_sha256_verified: true, serialization: "agent-observable-trajectory-v1" },
      },
    });
  }
  return { rows, excluded };
}

// Actions have no ctx.db; resolve the owner/editor caller via an internal query.
export const whoAmIForExport = internalQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<Id<"users">> => {
    const { userId } = await requireProjectRole(ctx, args.projectId, ["owner", "editor"]);
    return userId;
  },
});

// --- download (1-hour gate) --------------------------------------------------

export const downloadExport = action({
  args: { exportId: v.id("trainingExports") },
  handler: async (ctx, args): Promise<{ url: string; manifestUrl: string }> => {
    const meta = await ctx.runQuery(internal.exports.exportForDownload, {
      exportId: args.exportId,
    });
    if (Date.now() - meta.createdAt > DOWNLOAD_TTL_MS) {
      throw new Error("This export link has expired. Generate a fresh export.");
    }
    const [url, manifestUrl] = await Promise.all([
      ctx.storage.getUrl(meta.storageId),
      meta.manifestStorageId ? ctx.storage.getUrl(meta.manifestStorageId) : Promise.resolve(null),
    ]);
    if (!url || !manifestUrl) throw new Error("Export artifact or manifest is no longer available.");
    return { url, manifestUrl };
  },
});

export const exportForDownload = internalQuery({
  args: { exportId: v.id("trainingExports") },
  handler: async (
    ctx,
    args,
  ): Promise<{ storageId: Id<"_storage">; manifestStorageId?: Id<"_storage">; createdAt: number }> => {
    const row = await ctx.db.get(args.exportId);
    if (!row) throw new Error("Export not found.");
    await requireProjectRole(ctx, row.projectId, ["owner", "editor"]);
    if (row.trainingApprovalId === undefined) throw new Error("This legacy export has no training approval and cannot be downloaded.");
    const approval = await ctx.db.get(row.trainingApprovalId);
    if (!approval || approval.status !== "active") throw new Error("Training approval is revoked; this export can no longer be downloaded.");
    return { storageId: row.storageId, manifestStorageId: row.manifestStorageId, createdAt: row.createdAt };
  },
});
