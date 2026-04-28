import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireProjectRole } from "./lib/auth";
import { validateTemplate } from "./lib/templateValidation";
import {
  deriveLegacyFields,
  genMessageId,
  messageValidator,
  readMessages,
  validateMessages,
  type PromptMessage,
} from "./lib/messages";

export const list = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) return [];
    await requireProjectRole(ctx, args.projectId, ["owner", "editor"]);

    const versions = await ctx.db
      .query("promptVersions")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(200);

    // Enrich each row with creator, run count, and a coarse feedback count so
    // the Versions list can surface "has feedback" affordances per row.
    const enriched = [];
    for (const version of versions) {
      const creator = await ctx.db.get(version.createdById);

      const promptFb = await ctx.db
        .query("promptFeedback")
        .withIndex("by_version", (q) =>
          q.eq("promptVersionId", version._id),
        )
        .take(100);

      const runs = await ctx.db
        .query("promptRuns")
        .withIndex("by_version", (q) =>
          q.eq("promptVersionId", version._id),
        )
        .take(100);

      // Count cycle feedback that targets outputs sourced from this version's
      // runs. Capped so very active versions don't make this query quadratic.
      let cycleFeedbackCount = 0;
      for (const run of runs.slice(0, 50)) {
        const outputs = await ctx.db
          .query("runOutputs")
          .withIndex("by_run", (q) => q.eq("runId", run._id))
          .take(10);
        for (const output of outputs) {
          const cycleOutputs = await ctx.db
            .query("cycleOutputs")
            .withIndex("by_source_output", (q) =>
              q.eq("sourceOutputId", output._id),
            )
            .take(20);
          for (const co of cycleOutputs) {
            const fb = await ctx.db
              .query("cycleFeedback")
              .withIndex("by_cycle_output", (q) =>
                q.eq("cycleOutputId", co._id),
              )
              .take(100);
            cycleFeedbackCount += fb.length;
          }
        }
      }

      enriched.push({
        ...version,
        creatorName: creator?.name ?? null,
        creatorImage: creator?.image ?? null,
        runCount: runs.length,
        feedbackCount: promptFb.length + cycleFeedbackCount,
      });
    }

    return enriched.sort((a, b) => b.versionNumber - a.versionNumber);
  },
});

export const get = query({
  args: { versionId: v.id("promptVersions") },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.versionId);
    if (!version) return null;

    // M26: non-blind reviewers can read versions just like editors. Blind
    // evaluators stay denied — they reach prompt content only via the
    // session-scoped blind surface.
    const { collaborator } = await requireProjectRole(
      ctx,
      version.projectId,
      ["owner", "editor", "evaluator"],
    );
    if (
      collaborator.role === "evaluator" &&
      (collaborator.blindMode ?? true)
    ) {
      throw new Error("Permission denied");
    }
    return version;
  },
});

export const getCurrent = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const { collaborator } = await requireProjectRole(ctx, args.projectId, [
      "owner",
      "editor",
      "evaluator",
    ]);
    if (
      collaborator.role === "evaluator" &&
      (collaborator.blindMode ?? true)
    ) {
      throw new Error("Permission denied");
    }

    const versions = await ctx.db
      .query("promptVersions")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(200);

    // Return current version if one exists
    const current = versions.find((v) => v.status === "current");
    if (current) return current;

    // Otherwise return the latest draft (highest versionNumber)
    const drafts = versions
      .filter((v) => v.status === "draft")
      .sort((a, b) => b.versionNumber - a.versionNumber);
    return drafts[0] ?? null;
  },
});

const formatValidator = v.optional(
  v.union(v.literal("plain"), v.literal("markdown")),
);

// Auto-create variables that appear in any message but are not yet defined on
// the project. Used by both create and update so new {{vars}} surface from
// messages[] the same way they did from legacy fields.
async function autoCreateUnknownVariables(
  ctx: { db: import("./_generated/server").MutationCtx["db"] },
  projectId: import("./_generated/dataModel").Id<"projects">,
  texts: string[],
): Promise<void> {
  const variables = await ctx.db
    .query("projectVariables")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .take(200);
  const variableNames = variables.map((v) => v.name);

  const unknownSet = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const name of validateTemplate(text, variableNames)) {
      unknownSet.add(name);
    }
  }
  const unknown = [...unknownSet];
  const maxOrder = variables.reduce((max, v) => Math.max(max, v.order), -1);
  for (let i = 0; i < unknown.length; i++) {
    await ctx.db.insert("projectVariables", {
      projectId,
      name: unknown[i]!,
      required: true,
      order: maxOrder + 1 + i,
    });
  }
}

// Normalize a client-supplied messages[] array: preserve ids but fill in any
// missing/empty ones, then run invariant checks.
function normalizeMessages(input: PromptMessage[]): PromptMessage[] {
  const seen = new Set<string>();
  const normalized: PromptMessage[] = input.map((m) => {
    let id = m.id;
    if (!id || seen.has(id)) id = genMessageId();
    seen.add(id);
    return { ...m, id } as PromptMessage;
  });
  validateMessages(normalized);
  return normalized;
}

function collectMessageTexts(messages: PromptMessage[]): string[] {
  return messages
    .map((m) => (m.role === "assistant" ? (m.content ?? "") : m.content))
    .filter((s) => s.length > 0);
}

export const create = mutation({
  args: {
    projectId: v.id("projects"),
    systemMessage: v.optional(v.string()),
    userMessageTemplate: v.optional(v.string()),
    systemMessageFormat: formatValidator,
    userMessageTemplateFormat: formatValidator,
    // M18: optional messages[]. When present, it's authoritative and legacy
    // fields are derived from it before insert.
    messages: v.optional(v.array(messageValidator)),
    parentVersionId: v.optional(v.id("promptVersions")),
  },
  handler: async (ctx, args) => {
    const { userId } = await requireProjectRole(ctx, args.projectId, [
      "owner",
      "editor",
    ]);

    let messages: PromptMessage[] | undefined;
    let legacy: {
      systemMessage?: string;
      userMessageTemplate: string;
      systemMessageFormat?: "plain" | "markdown";
      userMessageTemplateFormat?: "plain" | "markdown";
    };

    if (args.messages) {
      messages = normalizeMessages(args.messages);
      legacy = deriveLegacyFields(messages);
    } else {
      if (args.userMessageTemplate === undefined) {
        throw new Error(
          "Provide either messages[] or a userMessageTemplate.",
        );
      }
      legacy = {
        systemMessage: args.systemMessage,
        userMessageTemplate: args.userMessageTemplate,
        systemMessageFormat: args.systemMessageFormat,
        userMessageTemplateFormat: args.userMessageTemplateFormat,
      };
    }

    // Auto-create any unknown {{vars}} from every message's text
    const texts = messages
      ? collectMessageTexts(messages)
      : [legacy.userMessageTemplate, legacy.systemMessage ?? ""].filter(
          (s) => s.length > 0,
        );
    await autoCreateUnknownVariables(ctx, args.projectId, texts);

    // Compute next version number and archive existing current version
    const existing = await ctx.db
      .query("promptVersions")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(200);
    const maxVersion = existing.reduce(
      (max, v) => Math.max(max, v.versionNumber),
      0,
    );

    for (const v of existing) {
      if (v.status === "current") {
        await ctx.db.patch(v._id, { status: "archived" as const });
      }
    }

    return await ctx.db.insert("promptVersions", {
      projectId: args.projectId,
      versionNumber: maxVersion + 1,
      systemMessage: legacy.systemMessage,
      userMessageTemplate: legacy.userMessageTemplate,
      systemMessageFormat: legacy.systemMessageFormat,
      userMessageTemplateFormat: legacy.userMessageTemplateFormat,
      messages,
      parentVersionId: args.parentVersionId,
      status: "draft",
      createdById: userId,
    });
  },
});

export const update = mutation({
  args: {
    versionId: v.id("promptVersions"),
    systemMessage: v.optional(v.string()),
    userMessageTemplate: v.optional(v.string()),
    systemMessageFormat: formatValidator,
    userMessageTemplateFormat: formatValidator,
    // M18: optional messages[] replaces legacy field-by-field updates. Editor
    // callers pass this on save; legacy callers omit it.
    messages: v.optional(v.array(messageValidator)),
  },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.versionId);
    if (!version) throw new Error("Version not found");
    if (version.status !== "draft") {
      throw new Error("Only drafts can be edited");
    }

    await requireProjectRole(ctx, version.projectId, ["owner", "editor"]);

    const updates: Record<string, unknown> = {};

    if (args.messages) {
      const normalized = normalizeMessages(args.messages);
      const legacy = deriveLegacyFields(normalized);
      updates.messages = normalized;
      updates.systemMessage = legacy.systemMessage;
      updates.userMessageTemplate = legacy.userMessageTemplate;
      updates.systemMessageFormat = legacy.systemMessageFormat;
      updates.userMessageTemplateFormat = legacy.userMessageTemplateFormat;
      await autoCreateUnknownVariables(
        ctx,
        version.projectId,
        collectMessageTexts(normalized),
      );
    } else {
      // Legacy path — update single-string fields. Validate variable usage
      // against both the unchanged and incoming fields.
      const templateToValidate =
        args.userMessageTemplate ?? version.userMessageTemplate;
      const systemToValidate = args.systemMessage ?? version.systemMessage;

      await autoCreateUnknownVariables(
        ctx,
        version.projectId,
        [templateToValidate, systemToValidate ?? ""].filter(
          (s) => s.length > 0,
        ),
      );

      if (args.systemMessage !== undefined) updates.systemMessage = args.systemMessage;
      if (args.userMessageTemplate !== undefined)
        updates.userMessageTemplate = args.userMessageTemplate;
      if (args.systemMessageFormat !== undefined)
        updates.systemMessageFormat = args.systemMessageFormat;
      if (args.userMessageTemplateFormat !== undefined)
        updates.userMessageTemplateFormat = args.userMessageTemplateFormat;

      // If this version has a persisted messages[] (e.g. backfilled), keep it
      // in sync when the legacy path writes. Rewrite the first system/user
      // message content while preserving ids. Multi-turn versions force the
      // caller onto the messages[] path, so this stays 1-sys + 1-user safe.
      if (version.messages && version.messages.length > 0) {
        const patched = patchLegacyIntoMessages(version.messages, {
          systemMessage: args.systemMessage,
          userMessageTemplate: args.userMessageTemplate,
          systemMessageFormat: args.systemMessageFormat,
          userMessageTemplateFormat: args.userMessageTemplateFormat,
        });
        if (patched) updates.messages = patched;
      }
    }

    await ctx.db.patch(args.versionId, updates);

    // Auto-promote draft to current and archive previous current
    const allVersions = await ctx.db
      .query("promptVersions")
      .withIndex("by_project", (q) => q.eq("projectId", version.projectId))
      .take(200);
    for (const v of allVersions) {
      if (v._id !== args.versionId && v.status === "current") {
        await ctx.db.patch(v._id, { status: "archived" as const });
      }
    }
    await ctx.db.patch(args.versionId, { status: "current" as const });
  },
});

// Apply a legacy (systemMessage/userMessageTemplate) patch back onto a
// messages[] array, preserving ids on the first matching slots. Returns the
// new array if any message was actually mutated, undefined otherwise.
function patchLegacyIntoMessages(
  messages: PromptMessage[],
  patch: {
    systemMessage?: string;
    userMessageTemplate?: string;
    systemMessageFormat?: "plain" | "markdown";
    userMessageTemplateFormat?: "plain" | "markdown";
  },
): PromptMessage[] | undefined {
  let changed = false;
  const next = messages.map((m) => {
    if (
      (m.role === "system" || m.role === "developer") &&
      patch.systemMessage !== undefined &&
      m === messages.find((x) => x.role === "system" || x.role === "developer")
    ) {
      changed = true;
      return {
        ...m,
        content: patch.systemMessage,
        format: patch.systemMessageFormat ?? m.format,
      };
    }
    if (
      m.role === "user" &&
      patch.userMessageTemplate !== undefined &&
      m === messages.find((x) => x.role === "user")
    ) {
      changed = true;
      return {
        ...m,
        content: patch.userMessageTemplate,
        format: patch.userMessageTemplateFormat ?? m.format,
      };
    }
    return m;
  });
  return changed ? next : undefined;
}

export const deleteVersion = mutation({
  args: { versionId: v.id("promptVersions") },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.versionId);
    if (!version) throw new Error("Version not found");
    if (version.status !== "draft") {
      throw new Error("Only drafts can be deleted");
    }

    await requireProjectRole(ctx, version.projectId, ["owner", "editor"]);

    // Delete associated attachments
    const attachments = await ctx.db
      .query("promptAttachments")
      .withIndex("by_version", (q) =>
        q.eq("promptVersionId", args.versionId),
      )
      .take(200);
    for (const a of attachments) {
      await ctx.db.delete(a._id);
    }

    await ctx.db.delete(args.versionId);
  },
});

export const fork = mutation({
  args: { sourceVersionId: v.id("promptVersions") },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceVersionId);
    if (!source) throw new Error("Version not found");

    const { userId } = await requireProjectRole(ctx, source.projectId, [
      "owner",
      "editor",
    ]);

    // Compute next version number
    const existing = await ctx.db
      .query("promptVersions")
      .withIndex("by_project", (q) => q.eq("projectId", source.projectId))
      .take(200);
    const maxVersion = existing.reduce(
      (max, v) => Math.max(max, v.versionNumber),
      0,
    );

    // Copy attachments from source
    const sourceAttachments = await ctx.db
      .query("promptAttachments")
      .withIndex("by_version", (q) =>
        q.eq("promptVersionId", args.sourceVersionId),
      )
      .take(200);

    // Fork generates new message ids so feedback on the source doesn't
    // ambiguously anchor on the fork.
    const forkedMessages = source.messages
      ? source.messages.map((m) => ({ ...m, id: genMessageId() }))
      : undefined;

    const newVersionId = await ctx.db.insert("promptVersions", {
      projectId: source.projectId,
      versionNumber: maxVersion + 1,
      systemMessage: source.systemMessage,
      userMessageTemplate: source.userMessageTemplate,
      systemMessageFormat: source.systemMessageFormat,
      userMessageTemplateFormat: source.userMessageTemplateFormat,
      messages: forkedMessages,
      sourceVersionId: args.sourceVersionId,
      status: "draft",
      createdById: userId,
    });

    // Copy attachments to new version
    for (const a of sourceAttachments) {
      await ctx.db.insert("promptAttachments", {
        promptVersionId: newVersionId,
        storageId: a.storageId,
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        order: a.order,
      });
    }

    return newVersionId;
  },
});

export const archive = mutation({
  args: { versionId: v.id("promptVersions") },
  handler: async (ctx, args) => {
    const version = await ctx.db.get(args.versionId);
    if (!version) throw new Error("Version not found");

    await requireProjectRole(ctx, version.projectId, ["owner", "editor"]);
    await ctx.db.patch(args.versionId, { status: "archived" as const });
  },
});

export const rollback = mutation({
  args: { versionId: v.id("promptVersions") },
  handler: async (ctx, args) => {
    const target = await ctx.db.get(args.versionId);
    if (!target) throw new Error("Version not found");

    const { userId } = await requireProjectRole(ctx, target.projectId, [
      "owner",
      "editor",
    ]);

    // Find the head version (highest versionNumber)
    const versions = await ctx.db
      .query("promptVersions")
      .withIndex("by_project", (q) => q.eq("projectId", target.projectId))
      .take(200);
    const head = versions.reduce((h, v) =>
      v.versionNumber > h.versionNumber ? v : h,
    );

    // New ids on rollback for the same reason fork gets new ids.
    const rolledBackMessages = target.messages
      ? target.messages.map((m) => ({ ...m, id: genMessageId() }))
      : undefined;

    // Create new version with target's content
    return await ctx.db.insert("promptVersions", {
      projectId: target.projectId,
      versionNumber: head.versionNumber + 1,
      systemMessage: target.systemMessage,
      userMessageTemplate: target.userMessageTemplate,
      systemMessageFormat: target.systemMessageFormat,
      userMessageTemplateFormat: target.userMessageTemplateFormat,
      messages: rolledBackMessages,
      parentVersionId: head._id,
      sourceVersionId: target._id,
      status: "draft",
      createdById: userId,
    });
  },
});

// M18: Exported for other modules that need the canonical messages[] — works
// on versions whether or not they've been backfilled.
export { readMessages };
