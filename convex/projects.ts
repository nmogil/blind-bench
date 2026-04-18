import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireAuth, requireOrgRole, requireProjectRole } from "./lib/auth";

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
    return { project, role: collaborator.role };
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
