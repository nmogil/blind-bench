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

/**
 * M25: Unified principal type. A principal is either a signed-in user or a
 * verified guest (email-only identity) that accepted a cycle invite. Review
 * session endpoints that can serve guests use `resolvePrincipal` — everything
 * else stays on `requireAuth`.
 */
export type Principal =
  | { kind: "user"; userId: Id<"users">; email: string | null }
  | { kind: "guest"; guestId: Id<"guestIdentities">; email: string };

/**
 * Resolve the current caller to a Principal. Passing a `guestToken` falls
 * back to guest resolution when there is no signed-in user — guest tokens
 * are minted at guest-invite acceptance time and stored client-side.
 *
 * Throws if neither auth nor a valid guest token is present.
 */
export async function resolvePrincipal(
  ctx: QueryCtx,
  guestIdentityId?: Id<"guestIdentities">,
): Promise<Principal> {
  const userId = await getAuthUserId(ctx);
  if (userId !== null) {
    const user = await ctx.db.get(userId);
    return { kind: "user", userId, email: user?.email ?? null };
  }
  if (guestIdentityId) {
    const guest = await ctx.db.get(guestIdentityId);
    if (guest) {
      return { kind: "guest", guestId: guestIdentityId, email: guest.email };
    }
  }
  throw new Error("Not authenticated");
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
