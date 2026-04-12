import { getAuthUserId } from "@convex-dev/auth/server";
import { QueryCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";

/**
 * Require the caller to be authenticated. Returns the userId.
 * Throws "Not authenticated" if no valid session.
 */
export async function requireAuth(
  ctx: QueryCtx,
): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new Error("Not authenticated");
  }
  return userId;
}

type OrgRole = Doc<"organizationMembers">["role"];

/**
 * Require the caller to hold one of the allowed roles on the given org.
 * Throws "Permission denied" if not a member or wrong role.
 */
export async function requireOrgRole(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  allowedRoles: OrgRole[],
): Promise<{ userId: Id<"users">; membership: Doc<"organizationMembers"> }> {
  const userId = await requireAuth(ctx);
  const membership = await ctx.db
    .query("organizationMembers")
    .withIndex("by_org_and_user", (q) =>
      q.eq("organizationId", orgId).eq("userId", userId),
    )
    .unique();
  if (!membership || !allowedRoles.includes(membership.role)) {
    throw new Error("Permission denied");
  }
  return { userId, membership };
}

type ProjectRole = Doc<"projectCollaborators">["role"];

/**
 * Require the caller to hold one of the allowed roles on the given project.
 * Throws "Permission denied" if not a collaborator or wrong role.
 */
export async function requireProjectRole(
  ctx: QueryCtx,
  projectId: Id<"projects">,
  allowedRoles: ProjectRole[],
): Promise<{
  userId: Id<"users">;
  collaborator: Doc<"projectCollaborators">;
}> {
  const userId = await requireAuth(ctx);
  const collaborator = await ctx.db
    .query("projectCollaborators")
    .withIndex("by_project_and_user", (q) =>
      q.eq("projectId", projectId).eq("userId", userId),
    )
    .unique();
  if (!collaborator || !allowedRoles.includes(collaborator.role)) {
    throw new Error("Permission denied");
  }
  return { userId, collaborator };
}
