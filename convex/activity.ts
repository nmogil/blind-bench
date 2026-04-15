import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireProjectRole } from "./lib/auth";

export const listActivity = query({
  args: {
    projectId: v.id("projects"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireProjectRole(ctx, args.projectId, [
      "owner",
      "editor",
      "evaluator",
    ]);

    const limit = args.limit ?? 50;

    // Fetch from each source table in parallel
    const [versions, runs, cycles, optimizations] = await Promise.all([
      ctx.db
        .query("promptVersions")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .take(100),
      ctx.db
        .query("promptRuns")
        .withIndex("by_project_and_status", (q) =>
          q.eq("projectId", args.projectId),
        )
        .take(100),
      ctx.db
        .query("reviewCycles")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .take(50),
      ctx.db
        .query("optimizationRequests")
        .withIndex("by_project_and_status", (q) =>
          q.eq("projectId", args.projectId),
        )
        .take(50),
    ]);

    type ActivityEvent = {
      type: "version_created" | "run_completed" | "run_failed" | "cycle_opened" | "cycle_closed" | "optimization_completed";
      timestamp: number;
      description: string;
      metadata: Record<string, string | number | null>;
    };

    const events: ActivityEvent[] = [];

    // Version events
    for (const v of versions) {
      events.push({
        type: "version_created",
        timestamp: v._creationTime,
        description: `Version v${v.versionNumber} created`,
        metadata: {
          versionId: v._id,
          versionNumber: v.versionNumber,
          status: v.status,
        },
      });
    }

    // Run events
    for (const r of runs) {
      if (r.status === "completed" || r.status === "failed") {
        const version = versions.find((v) => v._id === r.promptVersionId);
        events.push({
          type: r.status === "completed" ? "run_completed" : "run_failed",
          timestamp: r.completedAt ?? r._creationTime,
          description: `Run ${r.status} — v${version?.versionNumber ?? "?"} × ${r.model.split("/").pop()}`,
          metadata: {
            runId: r._id,
            versionNumber: version?.versionNumber ?? null,
            model: r.model,
          },
        });
      }
    }

    // Cycle events
    for (const c of cycles) {
      if (c.openedAt) {
        events.push({
          type: "cycle_opened",
          timestamp: c.openedAt,
          description: `Review cycle "${c.name}" opened`,
          metadata: {
            cycleId: c._id,
            name: c.name,
          },
        });
      }
      if (c.closedAt) {
        events.push({
          type: "cycle_closed",
          timestamp: c.closedAt,
          description: `Review cycle "${c.name}" closed`,
          metadata: {
            cycleId: c._id,
            name: c.name,
            closedAction: c.closedAction ?? null,
          },
        });
      }
    }

    // Optimization events
    for (const o of optimizations) {
      if (o.status === "completed") {
        const version = versions.find((v) => v._id === o.promptVersionId);
        events.push({
          type: "optimization_completed",
          timestamp: o._creationTime,
          description: `Optimization completed for v${version?.versionNumber ?? "?"}`,
          metadata: {
            requestId: o._id,
            versionNumber: version?.versionNumber ?? null,
            reviewStatus: o.reviewStatus ?? null,
          },
        });
      }
    }

    // Sort by timestamp descending and limit
    events.sort((a, b) => b.timestamp - a.timestamp);
    return events.slice(0, limit);
  },
});
