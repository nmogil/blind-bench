import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";

const schema = defineSchema({
  ...authTables,

  // M1: Organizations & Projects
  organizations: defineTable({
    name: v.string(),
    slug: v.string(),
    logoUrl: v.optional(v.string()),
    createdById: v.id("users"),
  }).index("by_slug", ["slug"]),

  organizationMembers: defineTable({
    organizationId: v.id("organizations"),
    userId: v.id("users"),
    role: v.union(
      v.literal("owner"),
      v.literal("admin"),
      v.literal("member"),
    ),
  })
    .index("by_org", ["organizationId"])
    .index("by_user", ["userId"])
    .index("by_org_and_user", ["organizationId", "userId"]),

  projects: defineTable({
    organizationId: v.id("organizations"),
    name: v.string(),
    description: v.optional(v.string()),
    createdById: v.id("users"),
  }).index("by_org", ["organizationId"]),

  projectCollaborators: defineTable({
    projectId: v.id("projects"),
    userId: v.id("users"),
    role: v.union(
      v.literal("owner"),
      v.literal("editor"),
      v.literal("evaluator"),
    ),
    invitedById: v.id("users"),
    invitedAt: v.number(),
    acceptedAt: v.optional(v.number()),
  })
    .index("by_project", ["projectId"])
    .index("by_user", ["userId"])
    .index("by_project_and_user", ["projectId", "userId"]),

  // M2: projectVariables, testCases, promptVersions, promptAttachments
  // M3: openRouterKeys, promptRuns, runOutputs
  // M4: outputFeedback, promptFeedback
  // M5: optimizationRequests
});

export default schema;
