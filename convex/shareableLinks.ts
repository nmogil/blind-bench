import { v, ConvexError } from "convex/values";
import { query, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireAuth, requireProjectRole } from "./lib/auth";
import { generateToken } from "./lib/evalTokens";

const SHAREABLE_LINK_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours

// --- Owner/editor functions ---

export const createShareableLink = mutation({
  args: { runId: v.id("promptRuns") },
  handler: async (ctx, { runId }) => {
    const userId = await requireAuth(ctx);
    const run = await ctx.db.get(runId);
    if (!run) throw new Error("Run not found");
    if (run.status !== "completed")
      throw new Error("Can only share completed runs");

    await requireProjectRole(ctx, run.projectId, ["owner", "editor"]);

    // Check for existing active general link (exclude per-email invitation links)
    const existingLinks = await ctx.db
      .query("shareableEvalLinks")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .take(100);
    const existing = existingLinks.find(
      (l) => l.active && l.purpose !== "invitation",
    );
    if (existing) return existing.token;

    const token = generateToken();
    await ctx.db.insert("shareableEvalLinks", {
      token,
      runId,
      projectId: run.projectId,
      createdById: userId,
      expiresAt: Date.now() + SHAREABLE_LINK_TTL_MS,
      responseCount: 0,
      active: true,
    });

    await ctx.scheduler.runAfter(0, internal.analyticsActions.track, {
      event: "shareable link created",
      distinctId: userId as string,
      properties: {
        run_id: runId as string,
        project_id: run.projectId as string,
      },
    });

    return token;
  },
});

export const deactivateShareableLink = mutation({
  args: { linkId: v.id("shareableEvalLinks") },
  handler: async (ctx, { linkId }) => {
    await requireAuth(ctx);
    const link = await ctx.db.get(linkId);
    if (!link) throw new Error("Link not found");

    await requireProjectRole(ctx, link.projectId, ["owner", "editor"]);
    await ctx.db.patch(linkId, { active: false });
  },
});

export const getShareableLinkForRun = query({
  args: { runId: v.id("promptRuns") },
  handler: async (ctx, { runId }) => {
    await requireAuth(ctx);
    const run = await ctx.db.get(runId);
    if (!run) return null;

    await requireProjectRole(ctx, run.projectId, ["owner", "editor"]);

    const links = await ctx.db
      .query("shareableEvalLinks")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .take(100);
    const link = links.find(
      (l) => l.active && l.purpose !== "invitation",
    );

    return link ?? null;
  },
});

export const getAnonymousResults = query({
  args: { runId: v.id("promptRuns") },
  handler: async (ctx, { runId }) => {
    await requireAuth(ctx);
    const run = await ctx.db.get(runId);
    if (!run) return null;

    await requireProjectRole(ctx, run.projectId, ["owner", "editor"]);

    const link = await ctx.db
      .query("shareableEvalLinks")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .first();
    if (!link) return null;

    const prefs = await ctx.db
      .query("anonymousPreferences")
      .withIndex("by_link", (q) => q.eq("shareableLinkId", link._id))
      .collect();

    // Aggregate ratings per blind label
    const aggregated: Record<
      string,
      { best: number; acceptable: number; weak: number }
    > = {};
    for (const pref of prefs) {
      for (const { blindLabel, rating } of pref.ratings) {
        if (!aggregated[blindLabel]) {
          aggregated[blindLabel] = { best: 0, acceptable: 0, weak: 0 };
        }
        aggregated[blindLabel]![rating]++;
      }
    }

    return {
      totalResponses: prefs.length,
      aggregated,
    };
  },
});

// --- Public (no-auth) functions ---

export const resolveShareableLink = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const link = await ctx.db
      .query("shareableEvalLinks")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();

    if (!link || !link.active || link.expiresAt < Date.now()) return null;
    if (link.maxResponses && link.responseCount >= link.maxResponses)
      return null;

    const run = await ctx.db.get(link.runId);
    if (!run) return null;

    const project = await ctx.db.get(link.projectId);

    const outputs = await ctx.db
      .query("runOutputs")
      .withIndex("by_run", (q) => q.eq("runId", link.runId))
      .collect();

    // Return ONLY blind-safe fields
    return {
      projectName: project?.name ?? "Untitled",
      outputs: outputs.map((o) => ({
        blindLabel: o.blindLabel,
        outputContent: o.outputContent,
      })),
    };
  },
});

export const submitAnonymousPreferences = mutation({
  args: {
    token: v.string(),
    sessionId: v.string(),
    ratings: v.array(
      v.object({
        blindLabel: v.string(),
        rating: v.union(
          v.literal("best"),
          v.literal("acceptable"),
          v.literal("weak"),
        ),
      }),
    ),
  },
  handler: async (ctx, { token, sessionId, ratings }) => {
    const link = await ctx.db
      .query("shareableEvalLinks")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();

    if (!link || !link.active || link.expiresAt < Date.now())
      throw new ConvexError("This link is no longer active");
    if (link.maxResponses && link.responseCount >= link.maxResponses)
      throw new ConvexError("This link has reached its response limit");

    // Deduplicate by sessionId
    const existing = await ctx.db
      .query("anonymousPreferences")
      .withIndex("by_session", (q) =>
        q.eq("shareableLinkId", link._id).eq("sessionId", sessionId),
      )
      .first();
    if (existing) throw new ConvexError("You have already submitted a response");

    await ctx.db.insert("anonymousPreferences", {
      shareableLinkId: link._id,
      runId: link.runId,
      sessionId,
      ratings,
    });

    await ctx.db.patch(link._id, {
      responseCount: link.responseCount + 1,
    });

    // Mark email invitation as responded if this is a per-email link
    if (link.purpose === "invitation") {
      const invitation = await ctx.db
        .query("evalInvitations")
        .withIndex("by_shareable_link", (q) =>
          q.eq("shareableLinkId", link.token),
        )
        .first();
      if (invitation && invitation.status === "pending") {
        await ctx.db.patch(invitation._id, {
          status: "responded",
          respondedAt: Date.now(),
        });
      }
    }
  },
});
