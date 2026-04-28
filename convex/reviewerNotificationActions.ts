"use node";

import { Resend } from "resend";
import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const SITE_URL = process.env.SITE_URL ?? "https://blindbench.dev";

/**
 * Sends "new draft ready" emails to every non-blind reviewer on the project,
 * skipping anyone notified in the last 24h. Records a dedup row per send.
 *
 * Scheduled from versions.update right after a draft auto-promotes to
 * "current". Multiple rapid-fire publishes within 24h still produce at most
 * one email per reviewer per project (criterion #4).
 */
export const sendNewDraftEmails = internalAction({
  args: { versionId: v.id("promptVersions") },
  handler: async (ctx, args) => {
    const data = await ctx.runQuery(
      internal.reviewerNotifications.collectRecipients,
      { versionId: args.versionId },
    );
    if (!data || data.recipients.length === 0) return;

    const url = `${SITE_URL}/review/${data.projectId}`;
    const subject = `New draft of ${data.projectName} ready for your review`;
    const changes =
      data.changesSummary && data.changesSummary.trim().length > 0
        ? data.changesSummary
        : "Manual edit";

    const resend = process.env.RESEND_API_KEY
      ? new Resend(process.env.RESEND_API_KEY)
      : null;

    for (const r of data.recipients) {
      if (!resend) {
        console.log(
          `[DEV] New-draft email for ${r.email} (project=${data.projectName}): ${url}`,
        );
      } else {
        try {
          await resend.emails.send({
            from: "Blind Bench <noreply@blindbench.dev>",
            to: r.email,
            subject,
            html: `
              <h2>${subject}</h2>
              <p>Hi ${r.name ?? "there"},</p>
              <p><strong>${data.authorName}</strong> just shipped a new draft of <strong>${data.projectName}</strong> after your last round of feedback.</p>
              <p style="color:#444;"><strong>What changed:</strong> ${changes}</p>
              <p><a href="${url}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;">Review the new draft</a></p>
              <p style="color:#666;font-size:12px;">You're getting this because you're a reviewer on ${data.projectName}.</p>
            `,
          });
        } catch (err) {
          // Don't let one bad email block the rest. Surface for ops.
          console.error(
            `Failed to send new-draft email to ${r.email}:`,
            err,
          );
          continue;
        }
      }

      await ctx.runMutation(internal.reviewerNotifications.recordSent, {
        userId: r.userId as Id<"users">,
        projectId: data.projectId as Id<"projects">,
        versionId: args.versionId,
      });
    }
  },
});
