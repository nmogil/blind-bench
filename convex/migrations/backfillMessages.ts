import { internalMutation } from "../_generated/server";
import {
  genMessageId,
  legacyTargetFieldForMessage,
  type PromptMessage,
} from "../lib/messages";

/**
 * Backfill messages[] on promptVersions and target.messageId on promptFeedback.
 * Idempotent — skips versions that already have messages[] and feedback rows
 * that already have target set.
 *
 * Run manually after the M18 schema lands:
 *   npx convex run migrations/backfillMessages
 */
export const backfillMessages = internalMutation({
  args: {},
  handler: async (ctx) => {
    let versionsBackfilled = 0;
    let feedbackRelinked = 0;
    let feedbackOrphaned = 0;

    const versions = await ctx.db.query("promptVersions").take(5000);

    for (const version of versions) {
      if (version.messages && version.messages.length > 0) continue;

      const messages: PromptMessage[] = [];
      if (version.systemMessage) {
        messages.push({
          id: genMessageId(),
          role: "system",
          content: version.systemMessage,
          format: version.systemMessageFormat ?? "plain",
        });
      }
      messages.push({
        id: genMessageId(),
        role: "user",
        content: version.userMessageTemplate,
        format: version.userMessageTemplateFormat ?? "plain",
      });

      await ctx.db.patch(version._id, { messages });
      versionsBackfilled++;

      // Re-anchor feedback for this version on the new message ids.
      const feedback = await ctx.db
        .query("promptFeedback")
        .withIndex("by_version", (q) => q.eq("promptVersionId", version._id))
        .take(500);

      for (const fb of feedback) {
        if (fb.target) continue;

        let messageId: string | undefined;
        if (fb.targetField === "system_message") {
          const sys = messages.find(
            (m) => m.role === "system" || m.role === "developer",
          );
          messageId = sys?.id;
        } else if (fb.targetField === "user_message_template") {
          const user = messages.find((m) => m.role === "user");
          messageId = user?.id;
        }

        if (messageId) {
          await ctx.db.patch(fb._id, {
            target: { kind: "message" as const, messageId },
          });
          feedbackRelinked++;
        } else {
          feedbackOrphaned++;
        }
      }
    }

    // Also re-anchor feedback on versions that already had messages[] but
    // whose feedback rows still lack target (partial prior backfill).
    const staleFeedback = await ctx.db.query("promptFeedback").take(5000);
    for (const fb of staleFeedback) {
      if (fb.target) continue;
      const version = await ctx.db.get(fb.promptVersionId);
      if (!version || !version.messages) {
        feedbackOrphaned++;
        continue;
      }
      const messages = version.messages;
      let messageId: string | undefined;
      if (fb.targetField === "system_message") {
        const sys = messages.find(
          (m) => m.role === "system" || m.role === "developer",
        );
        messageId = sys?.id;
      } else if (fb.targetField === "user_message_template") {
        const user = messages.find((m) => m.role === "user");
        messageId = user?.id;
      }
      if (messageId) {
        await ctx.db.patch(fb._id, {
          target: { kind: "message" as const, messageId },
        });
        feedbackRelinked++;
      } else {
        feedbackOrphaned++;
      }
    }

    return {
      versionsBackfilled,
      feedbackRelinked,
      feedbackOrphaned,
    };
  },
});

// Keep the helper exported for targeted one-off runs in convex-test.
export { legacyTargetFieldForMessage };
