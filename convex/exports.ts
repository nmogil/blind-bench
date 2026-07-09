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
  buildExportManifest,
  gateRows,
  toJsonl,
  renderStep,
  renderTranscript,
  moreSensitive,
  type ClassifiedRow,
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
  prefix?: StepRef[];
  chosen?: StepRef;
  rejected?: StepRef;
  messages?: StepRef[];
  finalAnswer?: Id<"_storage">;
}

export const gatherTrajectoryPlan = internalQuery({
  args: { projectId: v.id("projects"), format: FORMAT },
  handler: async (
    ctx,
    args,
  ): Promise<{ plan: TrajectoryPlanRow[]; stats: ExportSourceStats }> => {
    await requireProjectRole(ctx, args.projectId, ["owner", "editor"]);
    const stepsOf = (traceId: Id<"agentTraces">) =>
      ctx.db
        .query("agentTraceSteps")
        .withIndex("by_trace_and_index", (q) => q.eq("agentTraceId", traceId))
        .collect();

    const plan: TrajectoryPlanRow[] = [];
    const reviewerIds = new Set<string>();

    if (args.format === "dpo") {
      const matchups = await ctx.db
        .query("agentTraceMatchups")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .collect();
      for (const m of matchups) {
        if (m.winner !== "left" && m.winner !== "right") continue;
        const winnerId = m.winner === "left" ? m.leftTraceId : m.rightTraceId;
        const loserId = m.winner === "left" ? m.rightTraceId : m.leftTraceId;
        const [wt, lt] = [await ctx.db.get(winnerId), await ctx.db.get(loserId)];
        if (!wt || !lt) continue;
        const wSteps = await stepsOf(winnerId);
        const lSteps = await stepsOf(loserId);
        const chosen = wSteps.find((s) => s.stepIndex === m.divergenceStepIndex);
        const rejected = lSteps.find((s) => s.stepIndex === m.divergenceStepIndex);
        if (!chosen || !rejected) continue;
        plan.push({
          privacyClass: moreSensitive(wt.privacyClass, lt.privacyClass),
          metadata: { reason_tags: m.reasonTags },
          prefix: wSteps
            .filter((s) => s.stepIndex < m.divergenceStepIndex)
            .map((s) => ({ meta: metaOf(s), storageId: s.fullBodyStorageId })),
          chosen: { meta: metaOf(chosen), storageId: chosen.fullBodyStorageId },
          rejected: { meta: metaOf(rejected), storageId: rejected.fullBodyStorageId },
        });
        if (m.userId) reviewerIds.add(m.userId);
      }
    } else if (args.format === "sft") {
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
        if (!verdicts.some((vd) => vd.rating === "best")) continue;
        const steps = await stepsOf(tr._id);
        plan.push({
          privacyClass: tr.privacyClass,
          metadata: { verdict: "best" },
          messages: steps
            .filter((s) => s.kind === "message")
            .map((s) => ({ meta: metaOf(s), storageId: s.fullBodyStorageId })),
          finalAnswer: tr.finalAnswerStorageId,
        });
        for (const vd of verdicts) if (vd.rating === "best") reviewerIds.add(vd.userId);
      }
    }
    return { plan, stats: { sourceUnits: plan.length, reviewers: reviewerIds.size } };
  },
});

// --- record + list -----------------------------------------------------------

export const recordExport = internalMutation({
  args: {
    projectId: v.id("projects"),
    source: SOURCE,
    format: FORMAT,
    storageId: v.id("_storage"),
    rowCount: v.number(),
    excludedCount: v.number(),
    manifest: v.string(),
    createdById: v.id("users"),
    createdAt: v.number(),
  },
  handler: async (ctx, args): Promise<Id<"trainingExports">> =>
    await ctx.db.insert("trainingExports", args),
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
    return rows.map((r) => ({
      _id: r._id,
      source: r.source,
      format: r.format,
      rowCount: r.rowCount,
      excludedCount: r.excludedCount,
      // Parsed ExportManifest, or null for exports created before #288.
      manifest: r.manifest ? (JSON.parse(r.manifest) as ExportManifest) : null,
      createdAt: r.createdAt,
      expired: Date.now() - r.createdAt > DOWNLOAD_TTL_MS,
    }));
  },
});

// --- the export action -------------------------------------------------------

export const generateExport = action({
  args: {
    projectId: v.id("projects"),
    source: SOURCE,
    format: FORMAT,
    // Explicit consent to include prod-sensitive (confidential/pii/phi) rows.
    allowSensitive: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    exportId: Id<"trainingExports">;
    rowCount: number;
    excludedCount: number;
    manifest: ExportManifest;
  }> => {
    if (args.format === "annotated") {
      throw new Error("Annotated export isn’t available yet — use DPO or SFT.");
    }
    const userId = await ctx.runQuery(internal.exports.whoAmIForExport, {
      projectId: args.projectId,
    });

    let classified: ClassifiedRow[];
    let stats: ExportSourceStats;
    if (args.source === "output_preference") {
      const res = await ctx.runQuery(internal.exports.gatherOutputPrefRows, {
        projectId: args.projectId,
        format: args.format,
      });
      classified = res.rows;
      stats = res.stats;
    } else {
      const res = await ctx.runQuery(internal.exports.gatherTrajectoryPlan, {
        projectId: args.projectId,
        format: args.format,
      });
      classified = await hydrateTrajectory(ctx, res.plan, args.format);
      stats = res.stats;
    }

    const { included, excluded } = gateRows(classified, {
      allowSensitive: args.allowSensitive,
    });
    const jsonl = toJsonl(args.format as ExportFormat, included);
    const createdAt = Date.now();
    const manifest = buildExportManifest({
      source: args.source,
      format: args.format as ExportFormat,
      included,
      excluded,
      allowSensitive: args.allowSensitive ?? false,
      stats,
      generatedAt: createdAt,
    });

    const storageId = await ctx.storage.store(
      new Blob([jsonl], { type: "application/jsonl" }),
    );
    const exportId = await ctx.runMutation(internal.exports.recordExport, {
      projectId: args.projectId,
      source: args.source,
      format: args.format,
      storageId,
      rowCount: included.length,
      excludedCount: excluded.length,
      manifest: JSON.stringify(manifest),
      createdById: userId,
      createdAt,
    });
    return {
      exportId,
      rowCount: included.length,
      excludedCount: excluded.length,
      manifest,
    };
  },
});

// Read trajectory bodies from storage and assemble ExportRows.
async function hydrateTrajectory(
  ctx: { storage: { get: (id: Id<"_storage">) => Promise<Blob | null> } },
  plan: TrajectoryPlanRow[],
  format: "dpo" | "sft" | "annotated",
): Promise<ClassifiedRow[]> {
  const cache = new Map<string, unknown>();
  const read = async (id?: Id<"_storage">): Promise<unknown> => {
    if (!id) return undefined;
    if (cache.has(id)) return cache.get(id);
    const blob = await ctx.storage.get(id);
    let body: unknown = undefined;
    if (blob) {
      try {
        body = JSON.parse(await blob.text());
      } catch {
        body = undefined;
      }
    }
    cache.set(id, body);
    return body;
  };

  const out: ClassifiedRow[] = [];
  for (const r of plan) {
    if (format === "dpo" && r.chosen && r.rejected) {
      const prefix = await Promise.all(
        (r.prefix ?? []).map(async (s) => ({ meta: s.meta, body: await read(s.storageId) })),
      );
      const chosen = renderStep(r.chosen.meta, await read(r.chosen.storageId));
      const rejected = renderStep(r.rejected.meta, await read(r.rejected.storageId));
      out.push({
        privacyClass: r.privacyClass,
        row: { kind: "dpo", prompt: renderTranscript(prefix), chosen, rejected, metadata: r.metadata },
      });
    } else if (format === "sft" && r.messages) {
      const msgs = await Promise.all(
        r.messages.map(async (s) => ({
          role: s.meta.role ?? "assistant",
          content: String(((await read(s.storageId)) as Record<string, unknown> | undefined)?.content ?? ""),
        })),
      );
      const finalBody = (await read(r.finalAnswer)) as Record<string, unknown> | undefined;
      if (finalBody?.text) msgs.push({ role: "assistant", content: String(finalBody.text) });
      out.push({ privacyClass: r.privacyClass, row: { kind: "sft", messages: msgs, metadata: r.metadata } });
    }
  }
  return out;
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
  handler: async (ctx, args): Promise<{ url: string }> => {
    const meta = await ctx.runQuery(internal.exports.exportForDownload, {
      exportId: args.exportId,
    });
    if (Date.now() - meta.createdAt > DOWNLOAD_TTL_MS) {
      throw new Error("This export link has expired. Generate a fresh export.");
    }
    const url = await ctx.storage.getUrl(meta.storageId);
    if (!url) throw new Error("Export file is no longer available.");
    return { url };
  },
});

export const exportForDownload = internalQuery({
  args: { exportId: v.id("trainingExports") },
  handler: async (
    ctx,
    args,
  ): Promise<{ storageId: Id<"_storage">; createdAt: number }> => {
    const row = await ctx.db.get(args.exportId);
    if (!row) throw new Error("Export not found.");
    await requireProjectRole(ctx, row.projectId, ["owner", "editor"]);
    return { storageId: row.storageId, createdAt: row.createdAt };
  },
});
