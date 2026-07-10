import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  requireAuth,
  requireOrgRole,
  requireProjectRole,
} from "./lib/auth";
import { safeDeleteTestCaseBlob } from "./lib/storageCleanup";
import { genMessageId } from "./lib/messages";
import { ensureReviewSessionsForReviewer } from "./lib/traceReviewSessions";
import {
  createPersonalOrg,
  findUserOwnedOrg,
  materializeSampleProject,
} from "./sampleSeed";
import { Doc, Id } from "./_generated/dataModel";

/**
 * M29.4: Resolve a personal org for the current user — reusing the one they
 * already created at first-run, otherwise creating a fresh one. The welcome
 * screen mutations call this so brand-new users land in a real workspace.
 */
async function ensurePersonalOrgFor(
  ctx: import("./_generated/server").MutationCtx,
  userId: Id<"users">,
): Promise<{ org: Doc<"organizations">; orgId: Id<"organizations"> }> {
  const owned = await findUserOwnedOrg(ctx, userId);
  if (owned) return { org: owned, orgId: owned._id };
  const { orgId } = await createPersonalOrg(ctx, userId);
  const org = await ctx.db.get(orgId);
  if (!org) throw new Error("Failed to create personal workspace");
  return { org, orgId };
}

// ===== Meta Context (owner only) =====

export const getMetaContext = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProjectRole(ctx, args.projectId, ["owner"]);
    const project = await ctx.db.get(args.projectId);
    if (!project) return [];
    return project.metaContext ?? [];
  },
});

export const setMetaContext = mutation({
  args: {
    projectId: v.id("projects"),
    metaContext: v.array(
      v.object({
        id: v.string(),
        question: v.string(),
        answer: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    await requireProjectRole(ctx, args.projectId, ["owner"]);
    await ctx.db.patch(args.projectId, { metaContext: args.metaContext });
  },
});

export const create = mutation({
  args: {
    orgId: v.id("organizations"),
    name: v.string(),
    description: v.optional(v.string()),
    seedSample: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { userId } = await requireOrgRole(ctx, args.orgId, [
      "owner",
      "admin",
      "member",
    ]);

    const projectId = await ctx.db.insert("projects", {
      organizationId: args.orgId,
      name: args.name,
      description: args.description,
      createdById: userId,
    });

    await ctx.db.insert("projectCollaborators", {
      projectId,
      userId,
      role: "owner",
      invitedById: userId,
      invitedAt: Date.now(),
      acceptedAt: Date.now(),
    });

    if (args.seedSample) {
      // Seed variable
      await ctx.db.insert("projectVariables", {
        projectId,
        name: "text",
        description: "The text to translate",
        required: true,
        order: 0,
      });

      // Seed test case
      await ctx.db.insert("testCases", {
        projectId,
        name: "Casual paragraph",
        variableValues: {
          text: "Hey! Just wanted to let you know that the meeting tomorrow has been moved to 3pm. Also, don't forget to bring those budget reports we talked about. Let me know if that works for you!",
        },
        attachmentIds: [],
        order: 0,
        createdById: userId,
      });

      // Seed v1 draft
      await ctx.db.insert("promptVersions", {
        projectId,
        versionNumber: 1,
        systemMessage:
          "You are a professional translator. Render English text into natural, idiomatic French suitable for native speakers. Preserve the original tone and register.",
        userMessageTemplate: "Translate the following into natural French:\n\n{{text}}",
        status: "draft",
        createdById: userId,
      });

      // Seed meta context
      await ctx.db.patch(projectId, {
        metaContext: [
          {
            id: "sample-1",
            question: "What domain does this project serve?",
            answer:
              "General-purpose English-to-French translation for business communication.",
          },
          {
            id: "sample-2",
            question: "What tone should the output have?",
            answer:
              "Natural and conversational, matching the register of the input. Informal inputs should produce informal French.",
          },
          {
            id: "sample-3",
            question: "Who is the end user?",
            answer:
              "French-speaking colleagues who need to read translated messages from English-speaking team members.",
          },
        ],
      });
    }

    await ctx.scheduler.runAfter(0, internal.analyticsActions.track, {
      event: "project created",
      distinctId: userId as string,
      properties: {
        project_id: projectId as string,
        org_id: args.orgId as string,
        seeded: args.seedSample ?? false,
      },
    });

    return projectId;
  },
});

export const createWithPrompt = mutation({
  args: {
    orgId: v.id("organizations"),
    name: v.string(),
    description: v.optional(v.string()),
    promptText: v.string(),
    detectedVariables: v.array(
      v.object({
        name: v.string(),
        defaultValue: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const { userId } = await requireOrgRole(ctx, args.orgId, [
      "owner",
      "admin",
      "member",
    ]);

    // 1. Create project
    const projectId = await ctx.db.insert("projects", {
      organizationId: args.orgId,
      name: args.name,
      description: args.description,
      createdById: userId,
    });

    // 2. Add creator as owner
    await ctx.db.insert("projectCollaborators", {
      projectId,
      userId,
      role: "owner",
      invitedById: userId,
      invitedAt: Date.now(),
      acceptedAt: Date.now(),
    });

    // 3. Create variables
    for (let i = 0; i < args.detectedVariables.length; i++) {
      const v = args.detectedVariables[i]!;
      await ctx.db.insert("projectVariables", {
        projectId,
        name: v.name,
        defaultValue: v.defaultValue,
        required: true,
        order: i,
      });
    }

    // 4. Create v1 draft version with the pasted prompt
    const versionId = await ctx.db.insert("promptVersions", {
      projectId,
      versionNumber: 1,
      userMessageTemplate: args.promptText,
      status: "draft",
      createdById: userId,
    });

    await ctx.scheduler.runAfter(0, internal.analyticsActions.track, {
      event: "project created with prompt",
      distinctId: userId as string,
      properties: {
        project_id: projectId as string,
        org_id: args.orgId as string,
        variable_count: args.detectedVariables.length,
      },
    });

    return { projectId, versionId };
  },
});

// ===== Welcome-screen entrypoints =====

/**
 * Ingestion-first welcome path. Creates a personal workspace and an empty
 * project without manufacturing a prompt version, then routes the user to the
 * completed-run import surface.
 */
export const createForImport = mutation({
  args: { name: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const { org, orgId } = await ensurePersonalOrgFor(ctx, userId);
    const name = args.name?.trim() || "Agent evaluations";
    const projectId = await ctx.db.insert("projects", {
      organizationId: orgId,
      name,
      createdById: userId,
    });
    await ctx.db.insert("projectCollaborators", {
      projectId,
      userId,
      role: "owner",
      invitedById: userId,
      invitedAt: Date.now(),
      acceptedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.analyticsActions.track, {
      event: "welcome create for import",
      distinctId: userId as string,
      properties: { project_id: projectId as string, org_id: orgId as string },
    });
    return { orgSlug: org.slug, projectId };
  },
});

const WELCOME_VARIABLE_REGEX = /\{\{(\w+)\}\}/g;

function detectVariables(template: string): string[] {
  const matches = template.match(WELCOME_VARIABLE_REGEX);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.slice(2, -2)))];
}

/**
 * M29.4: Path A on the welcome screen — "I have a prompt I'm working on".
 * Spins up a personal workspace if needed, creates an "Untitled prompt"
 * project, and writes the pasted content as the v1 promptVersion's first
 * message at the requested role. Returns enough for the client to route
 * straight into the editor.
 */
export const createFromPaste = mutation({
  args: {
    content: v.string(),
    role: v.union(v.literal("system"), v.literal("user")),
  },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    if (!args.content.trim()) {
      throw new Error("Paste in some prompt text first.");
    }

    const { org, orgId } = await ensurePersonalOrgFor(ctx, userId);

    const projectId = await ctx.db.insert("projects", {
      organizationId: orgId,
      name: "Untitled prompt",
      createdById: userId,
    });

    await ctx.db.insert("projectCollaborators", {
      projectId,
      userId,
      role: "owner",
      invitedById: userId,
      invitedAt: Date.now(),
      acceptedAt: Date.now(),
    });

    // Auto-detect {{variables}} in the pasted content so the user can run
    // immediately without a "go define your variables first" detour.
    const variableNames = detectVariables(args.content);
    for (let i = 0; i < variableNames.length; i++) {
      await ctx.db.insert("projectVariables", {
        projectId,
        name: variableNames[i]!,
        required: true,
        order: i,
      });
    }

    // Build a single-message v1. System paste also seeds an empty user
    // template so MessageComposer always has a user turn to render.
    const messages =
      args.role === "system"
        ? [
            {
              id: genMessageId(),
              role: "system" as const,
              content: args.content,
              format: "plain" as const,
            },
            {
              id: genMessageId(),
              role: "user" as const,
              content: "",
              format: "plain" as const,
            },
          ]
        : [
            {
              id: genMessageId(),
              role: "user" as const,
              content: args.content,
              format: "plain" as const,
            },
          ];

    const versionId = await ctx.db.insert("promptVersions", {
      projectId,
      versionNumber: 1,
      systemMessage: args.role === "system" ? args.content : undefined,
      userMessageTemplate: args.role === "user" ? args.content : "",
      systemMessageFormat: args.role === "system" ? "plain" : undefined,
      userMessageTemplateFormat: "plain",
      messages,
      status: "draft",
      createdById: userId,
    });

    await ctx.scheduler.runAfter(0, internal.analyticsActions.track, {
      event: "welcome create from paste",
      distinctId: userId as string,
      properties: {
        project_id: projectId as string,
        org_id: orgId as string,
        role: args.role,
        variable_count: variableNames.length,
      },
    });

    return { orgSlug: org.slug, projectId, versionId };
  },
});

/**
 * M29.4: Path B on the welcome screen — "Show me an example". Materializes
 * the canonical starter project (same fixtures as the legacy auto-seed) into
 * a brand-new, fully-mutable project the user owns from minute zero.
 */
export const cloneStarter = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireAuth(ctx);
    const { org, orgId } = await ensurePersonalOrgFor(ctx, userId);

    const projectId = await materializeSampleProject(ctx, orgId, userId);

    const versions = await ctx.db
      .query("promptVersions")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .take(50);
    const firstVersion = versions
      .slice()
      .sort((a, b) => a.versionNumber - b.versionNumber)[0];

    await ctx.scheduler.runAfter(0, internal.analyticsActions.track, {
      event: "welcome clone starter",
      distinctId: userId as string,
      properties: {
        project_id: projectId as string,
        org_id: orgId as string,
      },
    });

    return {
      orgSlug: org.slug,
      projectId,
      versionId: firstVersion?._id ?? null,
    };
  },
});

export const list = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { userId } = await requireOrgRole(ctx, args.orgId, [
      "owner",
      "admin",
      "member",
    ]);

    const projects = await ctx.db
      .query("projects")
      .withIndex("by_org", (q) => q.eq("organizationId", args.orgId))
      .take(200);

    const visible = [];
    for (const project of projects) {
      const collab = await ctx.db
        .query("projectCollaborators")
        .withIndex("by_project_and_user", (q) =>
          q.eq("projectId", project._id).eq("userId", userId),
        )
        .unique();
      if (collab) {
        visible.push(project);
      }
    }
    return visible;
  },
});

export const get = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const project = await ctx.db.get(args.projectId);
    if (!project) return null;
    const collaborator = await ctx.db
      .query("projectCollaborators")
      .withIndex("by_project_and_user", (q) =>
        q.eq("projectId", args.projectId).eq("userId", userId),
      )
      .unique();
    if (!collaborator) throw new Error("Permission denied");
    return {
      project,
      role: collaborator.role,
      // M26: surfaces non-blind reviewer status to layouts so they can
      // route open reviewers differently from blind ones.
      blindMode: collaborator.blindMode ?? null,
    };
  },
});

export const update = mutation({
  args: {
    projectId: v.id("projects"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireProjectRole(ctx, args.projectId, ["owner"]);

    const updates: Record<string, string | undefined> = {};
    if (args.name !== undefined) updates.name = args.name;
    if (args.description !== undefined) updates.description = args.description;

    await ctx.db.patch(args.projectId, updates);
  },
});

export const deleteProject = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProjectRole(ctx, args.projectId, ["owner"]);

    // Delete all collaborators first
    const collabs = await ctx.db
      .query("projectCollaborators")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(500);
    for (const c of collabs) {
      await ctx.db.delete(c._id);
    }

    // M21.10: cascade-delete image variable blobs across every test case in
    // the project so the storage account doesn't accumulate orphans when a
    // project is removed. Only image attachments are cleaned up here — other
    // entity rows (testCases, runs, versions, etc.) are intentionally left
    // for the broader cleanup story.
    // #188: because promptRuns rows survive this cascade, their inputSnapshot
    // history can still reference these blobs — route through the retention
    // check so a lingering run's "what we sent" stays intact.
    const testCases = await ctx.db
      .query("testCases")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(500);
    for (const tc of testCases) {
      for (const storageId of Object.values(tc.variableAttachments ?? {})) {
        await safeDeleteTestCaseBlob(ctx, args.projectId, storageId);
      }
    }

    await ctx.db.delete(args.projectId);
  },
});

export const listCollaborators = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProjectRole(ctx, args.projectId, [
      "owner",
      "editor",
      "evaluator",
    ]);
    const collabs = await ctx.db
      .query("projectCollaborators")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(200);

    const results = [];
    for (const c of collabs) {
      const user = await ctx.db.get(c.userId);
      if (user) {
        results.push({
          _id: c._id,
          userId: c.userId,
          role: c.role,
          name: user.name,
          email: user.email,
          image: user.image,
          invitedAt: c.invitedAt,
          acceptedAt: c.acceptedAt,
        });
      }
    }
    return results;
  },
});

export const inviteCollaborator = mutation({
  args: {
    projectId: v.id("projects"),
    userId: v.id("users"),
    role: v.union(
      v.literal("owner"),
      v.literal("editor"),
      v.literal("evaluator"),
    ),
  },
  handler: async (ctx, args) => {
    const { userId } = await requireProjectRole(ctx, args.projectId, [
      "owner",
    ]);

    // Verify the invitee is in the same org
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Project not found");

    const inviteeMembership = await ctx.db
      .query("organizationMembers")
      .withIndex("by_org_and_user", (q) =>
        q
          .eq("organizationId", project.organizationId)
          .eq("userId", args.userId),
      )
      .unique();
    if (!inviteeMembership) {
      throw new Error(
        "User must be a member of the organization before being added to a project",
      );
    }

    // Check not already a collaborator
    const existing = await ctx.db
      .query("projectCollaborators")
      .withIndex("by_project_and_user", (q) =>
        q.eq("projectId", args.projectId).eq("userId", args.userId),
      )
      .unique();
    if (existing) {
      throw new Error("User is already a collaborator on this project");
    }

    await ctx.db.insert("projectCollaborators", {
      projectId: args.projectId,
      userId: args.userId,
      role: args.role,
      invitedById: userId,
      invitedAt: Date.now(),
      acceptedAt: Date.now(), // Instant invite for M1
    });
    if (args.role === "evaluator") {
      await ensureReviewSessionsForReviewer(ctx, args.projectId, args.userId);
    }
  },
});

export const updateCollaboratorRole = mutation({
  args: {
    projectId: v.id("projects"),
    userId: v.id("users"),
    role: v.union(
      v.literal("owner"),
      v.literal("editor"),
      v.literal("evaluator"),
    ),
  },
  handler: async (ctx, args) => {
    await requireProjectRole(ctx, args.projectId, ["owner"]);

    const collab = await ctx.db
      .query("projectCollaborators")
      .withIndex("by_project_and_user", (q) =>
        q.eq("projectId", args.projectId).eq("userId", args.userId),
      )
      .unique();
    if (!collab) {
      throw new Error("User is not a collaborator on this project");
    }

    // Prevent removing sole owner
    if (collab.role === "owner" && args.role !== "owner") {
      const owners = await ctx.db
        .query("projectCollaborators")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .take(200);
      const ownerCount = owners.filter((c) => c.role === "owner").length;
      if (ownerCount <= 1) {
        throw new Error("Cannot remove the sole project owner");
      }
    }

    await ctx.db.patch(collab._id, { role: args.role });
    if (args.role === "evaluator") {
      await ensureReviewSessionsForReviewer(ctx, args.projectId, args.userId);
    }
  },
});

export const removeCollaborator = mutation({
  args: {
    projectId: v.id("projects"),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    await requireProjectRole(ctx, args.projectId, ["owner"]);

    const collab = await ctx.db
      .query("projectCollaborators")
      .withIndex("by_project_and_user", (q) =>
        q.eq("projectId", args.projectId).eq("userId", args.userId),
      )
      .unique();
    if (!collab) {
      throw new Error("User is not a collaborator on this project");
    }

    // Prevent removing sole owner
    if (collab.role === "owner") {
      const owners = await ctx.db
        .query("projectCollaborators")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .take(200);
      const ownerCount = owners.filter((c) => c.role === "owner").length;
      if (ownerCount <= 1) {
        throw new Error("Cannot remove the sole project owner");
      }
    }

    await ctx.db.delete(collab._id);
  },
});
