/**
 * M26: "new draft published" notifications for non-blind reviewers.
 *
 * Triggered after versions.update auto-promotes a draft to "current". The
 * scheduler hands off to a Node action (Resend SDK) which calls back into
 * these queries/mutations to enumerate recipients and write the dedup ledger.
 *
 * Rate limit: at most one email per (reviewer, project) per 24h, regardless
 * of how many versions ship in that window. Implemented by checking
 * `reviewerNotifications` rows before sending and inserting one on send.
 */
import { v } from "convex/values";
import { internalQuery, internalMutation } from "./_generated/server";

const RATE_LIMIT_MS = 24 * 60 * 60 * 1000;

/**
 * Enumerate non-blind reviewers eligible for a new-draft email on this
 * version. Filters out anyone who already received an email for this project
 * in the last 24h (regardless of which version triggered it).
 */
export const collectRecipients = internalQuery({
  args: { versionId: v.id("promptVersions") },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.versionId);
    if (!version) return null;

    const project = await ctx.db.get(version.projectId);
    if (!project) return null;

    const author = await ctx.db.get(version.createdById);
    const collaborators = await ctx.db
      .query("projectCollaborators")
      .withIndex("by_project", (q) => q.eq("projectId", version.projectId))
      .take(500);

    const cutoff = Date.now() - RATE_LIMIT_MS;
    const recipients: {
      userId: string;
      email: string;
      name: string | null;
    }[] = [];

    for (const c of collaborators) {
      if (c.role !== "evaluator" || c.blindMode !== false) continue;
      if (c.userId === version.createdById) continue;

      const lastSent = await ctx.db
        .query("reviewerNotifications")
        .withIndex("by_user_project", (q) =>
          q.eq("userId", c.userId).eq("projectId", version.projectId),
        )
        .order("desc")
        .first();
      if (lastSent && lastSent.sentAt >= cutoff) continue;

      const user = await ctx.db.get(c.userId);
      if (!user?.email) continue;
      recipients.push({
        userId: c.userId as unknown as string,
        email: user.email,
        name: user.name ?? null,
      });
    }

    // Look up the optimizer's changes summary if this version was generated
    // by an accepted optimization. Falls back to "Manual edit" downstream.
    const optimizationFromVersion = await ctx.db
      .query("optimizationRequests")
      .withIndex("by_version", (q) =>
        q.eq("promptVersionId", version.parentVersionId ?? args.versionId),
      )
      .take(20);
    const matchingOpt = optimizationFromVersion.find(
      (o) => o.resultingVersionId === args.versionId,
    );

    return {
      projectId: version.projectId as unknown as string,
      projectName: project.name,
      versionId: args.versionId as unknown as string,
      authorName: author?.name ?? author?.email ?? "A teammate",
      changesSummary: matchingOpt?.changesSummary ?? null,
      recipients,
    };
  },
});

export const recordSent = internalMutation({
  args: {
    userId: v.id("users"),
    projectId: v.id("projects"),
    versionId: v.id("promptVersions"),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("reviewerNotifications", {
      userId: args.userId,
      projectId: args.projectId,
      versionId: args.versionId,
      sentAt: Date.now(),
    });
  },
});
