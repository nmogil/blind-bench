import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { requireProjectRole } from "./lib/auth";
import { generateToken } from "./lib/evalTokens";

const SHAREABLE_LINK_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours
const REMINDER_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours
const MAX_REMINDERS = 3;

export const sendInvitations = mutation({
  args: {
    emails: v.array(v.string()),
    cycleId: v.optional(v.id("reviewCycles")),
    runId: v.optional(v.id("promptRuns")),
  },
  handler: async (ctx, args) => {
    if (!args.cycleId && !args.runId) {
      throw new Error("Either cycleId or runId is required");
    }
    if (args.cycleId && args.runId) {
      throw new Error("Provide only one of cycleId or runId");
    }

    const linkType = args.cycleId ? ("cycle" as const) : ("run" as const);
    let projectId: Id<"projects">;
    let projectName: string;
    let cycleName: string | undefined;

    if (args.cycleId) {
      const cycle = await ctx.db.get(args.cycleId);
      if (!cycle) throw new Error("Cycle not found");
      if (cycle.status !== "open") {
        throw new Error("Can only send invitations for open cycles");
      }
      projectId = cycle.projectId;
      cycleName = cycle.name;
    } else {
      const run = await ctx.db.get(args.runId!);
      if (!run) throw new Error("Run not found");
      if (run.status !== "completed") {
        throw new Error("Can only send invitations for completed runs");
      }
      projectId = run.projectId;
    }

    const { userId } = await requireProjectRole(ctx, projectId, [
      "owner",
      "editor",
    ]);

    const project = await ctx.db.get(projectId);
    projectName = project?.name ?? "Unknown";

    let sent = 0;
    let skipped = 0;

    for (const rawEmail of args.emails) {
      const email = rawEmail.trim().toLowerCase();
      if (!email) continue;

      // Check for existing invitation
      const existing = args.cycleId
        ? await ctx.db
            .query("evalInvitations")
            .withIndex("by_email_and_cycle", (q) =>
              q.eq("email", email).eq("cycleId", args.cycleId!),
            )
            .first()
        : await ctx.db
            .query("evalInvitations")
            .withIndex("by_email_and_run", (q) =>
              q.eq("email", email).eq("runId", args.runId!),
            )
            .first();

      if (existing) {
        if (existing.status === "responded") {
          skipped++;
          continue;
        }
        // Re-send: refresh TTL on existing link and resend email
        if (linkType === "cycle") {
          const link = await ctx.db
            .query("cycleShareableLinks")
            .withIndex("by_token", (q) =>
              q.eq("token", existing.shareableLinkId),
            )
            .first();
          if (link) {
            await ctx.db.patch(link._id, {
              expiresAt: Date.now() + SHAREABLE_LINK_TTL_MS,
            });
          }
        } else {
          const link = await ctx.db
            .query("shareableEvalLinks")
            .withIndex("by_token", (q) =>
              q.eq("token", existing.shareableLinkId),
            )
            .first();
          if (link) {
            await ctx.db.patch(link._id, {
              expiresAt: Date.now() + SHAREABLE_LINK_TTL_MS,
            });
          }
        }

        await ctx.scheduler.runAfter(
          0,
          internal.evalInvitationActions.sendInvitationEmail,
          {
            recipientEmail: email,
            projectName,
            cycleName,
            token: existing.shareableLinkId,
            linkType,
          },
        );
        sent++;
        continue;
      }

      // Create new per-email shareable link
      const token = generateToken();

      if (linkType === "cycle") {
        await ctx.db.insert("cycleShareableLinks", {
          token,
          cycleId: args.cycleId!,
          projectId,
          createdById: userId,
          expiresAt: Date.now() + SHAREABLE_LINK_TTL_MS,
          maxResponses: 1,
          responseCount: 0,
          active: true,
          purpose: "invitation",
        });
      } else {
        await ctx.db.insert("shareableEvalLinks", {
          token,
          runId: args.runId!,
          projectId,
          createdById: userId,
          expiresAt: Date.now() + SHAREABLE_LINK_TTL_MS,
          maxResponses: 1,
          responseCount: 0,
          active: true,
          purpose: "invitation",
        });
      }

      // Create invitation record
      await ctx.db.insert("evalInvitations", {
        email,
        projectId,
        cycleId: args.cycleId,
        runId: args.runId,
        shareableLinkId: token,
        linkType,
        invitedById: userId,
        invitedAt: Date.now(),
        status: "pending",
        reminderCount: 0,
      });

      // Schedule email
      await ctx.scheduler.runAfter(
        0,
        internal.evalInvitationActions.sendInvitationEmail,
        {
          recipientEmail: email,
          projectName,
          cycleName,
          token,
          linkType,
        },
      );

      sent++;
    }

    return { sent, skipped };
  },
});

export const getInvitations = query({
  args: {
    cycleId: v.optional(v.id("reviewCycles")),
    runId: v.optional(v.id("promptRuns")),
  },
  handler: async (ctx, args) => {
    if (!args.cycleId && !args.runId) return [];

    let projectId: Id<"projects">;

    if (args.cycleId) {
      const cycle = await ctx.db.get(args.cycleId);
      if (!cycle) return [];
      projectId = cycle.projectId;
    } else {
      const run = await ctx.db.get(args.runId!);
      if (!run) return [];
      projectId = run.projectId;
    }

    await requireProjectRole(ctx, projectId, ["owner", "editor"]);

    const invitations = args.cycleId
      ? await ctx.db
          .query("evalInvitations")
          .withIndex("by_cycle", (q) => q.eq("cycleId", args.cycleId!))
          .take(200)
      : await ctx.db
          .query("evalInvitations")
          .withIndex("by_run", (q) => q.eq("runId", args.runId!))
          .take(200);

    return invitations.map((inv) => ({
      _id: inv._id,
      email: inv.email,
      status: inv.status,
      invitedAt: inv.invitedAt,
      respondedAt: inv.respondedAt ?? null,
      lastReminderSentAt: inv.lastReminderSentAt ?? null,
      reminderCount: inv.reminderCount,
    }));
  },
});

export const sendInvitationReminder = mutation({
  args: {
    invitationId: v.id("evalInvitations"),
  },
  handler: async (ctx, args) => {
    const invitation = await ctx.db.get(args.invitationId);
    if (!invitation) throw new Error("Invitation not found");
    if (invitation.status !== "pending") {
      throw new Error("This invitee has already responded");
    }

    await requireProjectRole(ctx, invitation.projectId, ["owner", "editor"]);

    if (invitation.reminderCount >= MAX_REMINDERS) {
      throw new Error("Maximum reminders reached for this invitee");
    }
    if (
      invitation.lastReminderSentAt &&
      Date.now() - invitation.lastReminderSentAt < REMINDER_COOLDOWN_MS
    ) {
      throw new Error("Please wait before sending another reminder");
    }

    // Refresh link TTL
    if (invitation.linkType === "cycle") {
      const link = await ctx.db
        .query("cycleShareableLinks")
        .withIndex("by_token", (q) =>
          q.eq("token", invitation.shareableLinkId),
        )
        .first();
      if (link) {
        await ctx.db.patch(link._id, {
          expiresAt: Date.now() + SHAREABLE_LINK_TTL_MS,
        });
      }
    } else {
      const link = await ctx.db
        .query("shareableEvalLinks")
        .withIndex("by_token", (q) =>
          q.eq("token", invitation.shareableLinkId),
        )
        .first();
      if (link) {
        await ctx.db.patch(link._id, {
          expiresAt: Date.now() + SHAREABLE_LINK_TTL_MS,
        });
      }
    }

    await ctx.db.patch(args.invitationId, {
      lastReminderSentAt: Date.now(),
      reminderCount: invitation.reminderCount + 1,
    });

    const project = await ctx.db.get(invitation.projectId);
    let cycleName: string | undefined;
    if (invitation.cycleId) {
      const cycle = await ctx.db.get(invitation.cycleId);
      cycleName = cycle?.name;
    }

    await ctx.scheduler.runAfter(
      0,
      internal.evalInvitationActions.sendInvitationReminderEmail,
      {
        recipientEmail: invitation.email,
        projectName: project?.name ?? "Unknown",
        cycleName,
        token: invitation.shareableLinkId,
        linkType: invitation.linkType,
      },
    );
  },
});

export const sendReminderToAllPending = mutation({
  args: {
    cycleId: v.optional(v.id("reviewCycles")),
    runId: v.optional(v.id("promptRuns")),
  },
  handler: async (ctx, args) => {
    if (!args.cycleId && !args.runId) {
      throw new Error("Either cycleId or runId is required");
    }

    let projectId: Id<"projects">;
    let cycleName: string | undefined;

    if (args.cycleId) {
      const cycle = await ctx.db.get(args.cycleId);
      if (!cycle) throw new Error("Cycle not found");
      projectId = cycle.projectId;
      cycleName = cycle.name;
    } else {
      const run = await ctx.db.get(args.runId!);
      if (!run) throw new Error("Run not found");
      projectId = run.projectId;
    }

    await requireProjectRole(ctx, projectId, ["owner", "editor"]);

    const project = await ctx.db.get(projectId);
    const projectName = project?.name ?? "Unknown";

    const invitations = args.cycleId
      ? await ctx.db
          .query("evalInvitations")
          .withIndex("by_cycle", (q) => q.eq("cycleId", args.cycleId!))
          .take(200)
      : await ctx.db
          .query("evalInvitations")
          .withIndex("by_run", (q) => q.eq("runId", args.runId!))
          .take(200);

    const now = Date.now();
    let sentCount = 0;

    for (const inv of invitations) {
      if (inv.status !== "pending") continue;
      if (inv.reminderCount >= MAX_REMINDERS) continue;
      if (inv.lastReminderSentAt && now - inv.lastReminderSentAt < REMINDER_COOLDOWN_MS) continue;

      // Refresh link TTL
      if (inv.linkType === "cycle") {
        const link = await ctx.db
          .query("cycleShareableLinks")
          .withIndex("by_token", (q) => q.eq("token", inv.shareableLinkId))
          .first();
        if (link) {
          await ctx.db.patch(link._id, {
            expiresAt: now + SHAREABLE_LINK_TTL_MS,
          });
        }
      } else {
        const link = await ctx.db
          .query("shareableEvalLinks")
          .withIndex("by_token", (q) => q.eq("token", inv.shareableLinkId))
          .first();
        if (link) {
          await ctx.db.patch(link._id, {
            expiresAt: now + SHAREABLE_LINK_TTL_MS,
          });
        }
      }

      await ctx.db.patch(inv._id, {
        lastReminderSentAt: now,
        reminderCount: inv.reminderCount + 1,
      });

      await ctx.scheduler.runAfter(
        0,
        internal.evalInvitationActions.sendInvitationReminderEmail,
        {
          recipientEmail: inv.email,
          projectName,
          cycleName,
          token: inv.shareableLinkId,
          linkType: inv.linkType,
        },
      );

      sentCount++;
    }

    return { sentCount };
  },
});
