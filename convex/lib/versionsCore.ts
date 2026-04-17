/**
 * Shared logic for creating/updating prompt versions.
 *
 * PUBLIC API: this file is the single source of truth for version mutation
 * behavior. Both convex/versions.ts (user mutations) and convex/api.ts
 * (service-token HTTP mutations) call into these helpers. Do NOT inline this
 * logic at the call site — the API surface and the React frontend would
 * silently drift.
 *
 * Auth is the CALLER's responsibility. These helpers assume the userId has
 * already been validated by the caller (requireProjectRole or service token).
 */

import { MutationCtx } from "../_generated/server";
import { Id } from "../_generated/dataModel";
import { validateTemplate } from "./templateValidation";

export interface CreateVersionInput {
  projectId: Id<"projects">;
  systemMessage?: string;
  userMessageTemplate: string;
  parentVersionId?: Id<"promptVersions">;
  userId: Id<"users">;
}

export async function createVersionCore(
  ctx: MutationCtx,
  args: CreateVersionInput,
): Promise<Id<"promptVersions">> {
  // Auto-create unknown variables referenced by the template.
  const variables = await ctx.db
    .query("projectVariables")
    .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
    .take(200);
  const variableNames = variables.map((v) => v.name);

  const unknownFromUser = validateTemplate(args.userMessageTemplate, variableNames);
  const unknownFromSystem = args.systemMessage
    ? validateTemplate(args.systemMessage, variableNames)
    : [];
  const allUnknown = [...new Set([...unknownFromUser, ...unknownFromSystem])];
  const maxOrder = variables.reduce((max, v) => Math.max(max, v.order), -1);
  for (let i = 0; i < allUnknown.length; i++) {
    await ctx.db.insert("projectVariables", {
      projectId: args.projectId,
      name: allUnknown[i]!,
      required: true,
      order: maxOrder + 1 + i,
    });
  }

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
    systemMessage: args.systemMessage,
    userMessageTemplate: args.userMessageTemplate,
    parentVersionId: args.parentVersionId,
    status: "draft",
    createdById: args.userId,
  });
}
