/**
 * M25: Unified invitations. Replaces the three parallel invite paths (org
 * members, project collaborators, cycle reviewers) with one table + one API.
 *
 * Scope mapping:
 *   org      → organizationMembers on accept
 *   project  → projectCollaborators on accept
 *   cycle    → cycleEvaluators on accept (users) OR guestIdentities (guests)
 *
 * Guest principals may ONLY accept scope=cycle with role=cycle_reviewer.
 * Org/project invites require real auth.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireAuth, requireOrgRole, requireProjectRole } from "./lib/auth";
import { generateToken } from "./lib/crypto";

const ORG_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PROJECT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CYCLE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const scopeValidator = v.union(
  v.literal("org"),
  v.literal("project"),
  v.literal("cycle"),
);

const roleValidator = v.union(
  v.literal("org_owner"),
  v.literal("org_admin"),
  v.literal("org_member"),
  v.literal("project_owner"),
  v.literal("project_editor"),
  v.literal("project_evaluator"),
  v.literal("cycle_reviewer"),
);

type Scope = "org" | "project" | "cycle";
type InviteRole = Doc<"invitations">["role"];

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function ttlForScope(scope: Scope): number {
  if (scope === "cycle") return CYCLE_TTL_MS;
  if (scope === "project") return PROJECT_TTL_MS;
  return ORG_TTL_MS;
}

function roleMatchesScope(scope: Scope, role: InviteRole): boolean {
  if (scope === "org")
    return role === "org_owner" || role === "org_admin" || role === "org_member";
  if (scope === "project")
    return (
      role === "project_owner" ||
      role === "project_editor" ||
      role === "project_evaluator"
    );
  return role === "cycle_reviewer";
}

async function authorizeCreate(
  ctx: MutationCtx,
  scope: Scope,
  scopeId: string,
): Promise<{ orgId: Id<"organizations">; actorUserId: Id<"users"> }> {
  if (scope === "org") {
    const orgId = scopeId as Id<"organizations">;
    const { userId } = await requireOrgRole(ctx, orgId, ["owner"]);
    return { orgId, actorUserId: userId };
  }
  if (scope === "project") {
    const projectId = scopeId as Id<"projects">;
    const project = await ctx.db.get(projectId);
    if (!project) throw new Error("Project not found");
    const { userId } = await requireProjectRole(ctx, projectId, ["owner"]);
    return { orgId: project.organizationId, actorUserId: userId };
  }
  // cycle
  const cycleId = scopeId as Id<"reviewCycles">;
  const cycle = await ctx.db.get(cycleId);
  if (!cycle) throw new Error("Cycle not found");
  const project = await ctx.db.get(cycle.projectId);
  if (!project) throw new Error("Project not found");
  const { userId } = await requireProjectRole(ctx, cycle.projectId, [
    "owner",
    "editor",
  ]);
  return { orgId: project.organizationId, actorUserId: userId };
}

async function scopeNameFor(
  ctx: QueryCtx,
  scope: Scope,
  scopeId: string,
): Promise<string> {
  if (scope === "org") {
    const org = await ctx.db.get(scopeId as Id<"organizations">);
    return org?.name ?? "your organization";
  }
  if (scope === "project") {
    const project = await ctx.db.get(scopeId as Id<"projects">);
    return project?.name ?? "a project";
  }
  const cycle = await ctx.db.get(scopeId as Id<"reviewCycles">);
  return cycle?.name ?? "a review cycle";
}

/**
 * Create one or more invitations. Scope-aware auth:
 *   org   → owner
 *   proj  → owner
 *   cycle → project owner or editor
 *
 * Returns per-email outcome so the UI can show "3 sent, 1 skipped (already
 * invited)".
 */
export const create = mutation({
  args: {
    scope: scopeValidator,
    scopeId: v.string(),
    role: roleValidator,
    emails: v.array(v.string()),
    shareable: v.optional(v.boolean()),
    maxAccepts: v.optional(v.number()),
    // M26: only meaningful for reviewer roles (project_evaluator,
    // cycle_reviewer). Defaults to `true` at accept time for those roles to
    // preserve current blind semantics.
    blindMode: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    if (!roleMatchesScope(args.scope, args.role)) {
      throw new Error("Role does not match scope");
    }
    const { orgId, actorUserId } = await authorizeCreate(
      ctx,
      args.scope,
      args.scopeId,
    );

    const scopeName = await scopeNameFor(ctx, args.scope, args.scopeId);
    const ttl = ttlForScope(args.scope);
    const shareable = args.shareable ?? false;
    const now = Date.now();

    // Only store blindMode for roles that actually gate on it. Defaulting here
    // (vs. at read-time) keeps the stored value inspectable in the admin UI.
    const isReviewerRole =
      args.role === "project_evaluator" || args.role === "cycle_reviewer";
    const blindMode = isReviewerRole ? (args.blindMode ?? true) : undefined;

    const inviter = await ctx.db.get(actorUserId);
    const inviterName = inviter?.name ?? inviter?.email ?? "A teammate";

    let sent = 0;
    let skipped = 0;
    const created: Id<"invitations">[] = [];

    // Shareable link creates one row with empty email
    const emails = shareable
      ? [""]
      : args.emails.map(normalizeEmail).filter((e) => e.length > 0);

    for (const email of emails) {
      if (!shareable) {
        const existing = await ctx.db
          .query("invitations")
          .withIndex("by_email_scope", (q) =>
            q
              .eq("email", email)
              .eq("scope", args.scope)
              .eq("scopeId", args.scopeId),
          )
          .filter((q) => q.eq(q.field("status"), "pending"))
          .first();
        if (existing) {
          // Refresh TTL + re-send; counts as sent.
          await ctx.db.patch(existing._id, {
            expiresAt: now + ttl,
            invitedAt: now,
          });
          await ctx.scheduler.runAfter(
            0,
            internal.invitationActions.sendInvitationEmail,
            {
              recipientEmail: email,
              scope: args.scope,
              scopeName,
              inviterName,
              token: existing.token,
              blindMode: existing.blindMode,
            },
          );
          sent++;
          continue;
        }
      }

      const token = generateToken();
      const id = await ctx.db.insert("invitations", {
        scope: args.scope,
        scopeId: args.scopeId,
        orgId,
        role: args.role,
        email,
        token,
        shareable,
        blindMode,
        status: "pending",
        invitedById: actorUserId,
        invitedAt: now,
        expiresAt: now + ttl,
        acceptCount: 0,
        maxAccepts: args.maxAccepts,
      });
      created.push(id);

      if (!shareable) {
        await ctx.scheduler.runAfter(
          0,
          internal.invitationActions.sendInvitationEmail,
          {
            recipientEmail: email,
            scope: args.scope,
            scopeName,
            inviterName,
            token,
            blindMode,
          },
        );
        sent++;
      }
    }

    return { sent, skipped, createdIds: created };
  },
});

/**
 * Revoke an invitation. Scope-aware auth.
 */
export const revoke = mutation({
  args: { invitationId: v.id("invitations") },
  handler: async (ctx, args) => {
    const invite = await ctx.db.get(args.invitationId);
    if (!invite) throw new Error("Invitation not found");
    await authorizeCreate(ctx, invite.scope, invite.scopeId);
    await ctx.db.patch(args.invitationId, { status: "revoked" });
  },
});

/**
 * List invitations for a scope. Scope-aware auth.
 */
export const list = query({
  args: {
    scope: scopeValidator,
    scopeId: v.string(),
  },
  handler: async (ctx, args) => {
    // Re-use the create-authorization path (same read permissions).
    // We can't call the MutationCtx-typed helper from a query — inline the
    // check instead.
    if (args.scope === "org") {
      await requireOrgRole(ctx, args.scopeId as Id<"organizations">, [
        "owner",
      ]);
    } else if (args.scope === "project") {
      await requireProjectRole(ctx, args.scopeId as Id<"projects">, ["owner"]);
    } else {
      const cycle = await ctx.db.get(args.scopeId as Id<"reviewCycles">);
      if (!cycle) return [];
      await requireProjectRole(ctx, cycle.projectId, ["owner", "editor"]);
    }

    const rows = await ctx.db
      .query("invitations")
      .withIndex("by_scope", (q) =>
        q.eq("scope", args.scope).eq("scopeId", args.scopeId),
      )
      .take(200);

    return rows.map((r) => ({
      _id: r._id,
      email: r.email,
      role: r.role,
      status: r.status,
      shareable: r.shareable,
      token: r.token,
      invitedAt: r.invitedAt,
      expiresAt: r.expiresAt,
      acceptCount: r.acceptCount,
      maxAccepts: r.maxAccepts ?? null,
    }));
  },
});

/**
 * Invites pending for the signed-in user's email.
 */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireAuth(ctx);
    const user = await ctx.db.get(userId);
    if (!user?.email) return [];
    const email = normalizeEmail(user.email);

    // No by_email index — scan pending invites via by_org_status for each org
    // the user belongs to. Simpler: use the rare filter on the whole table
    // (bounded by maxAccepts exposure and pending count).
    const rows = await ctx.db
      .query("invitations")
      .filter((q) =>
        q.and(
          q.eq(q.field("email"), email),
          q.eq(q.field("status"), "pending"),
        ),
      )
      .take(100);

    const results = [];
    for (const r of rows) {
      if (r.expiresAt < Date.now()) continue;
      const scopeName = await scopeNameFor(ctx, r.scope, r.scopeId);
      results.push({
        _id: r._id,
        token: r.token,
        scope: r.scope,
        scopeName,
        role: r.role,
        invitedAt: r.invitedAt,
        expiresAt: r.expiresAt,
      });
    }
    return results;
  },
});

/**
 * Unauthenticated lookup used by the /invite/:token landing page. Returns
 * only the fields the landing UI needs — no scopeId, no internal flags.
 */
export const lookupByToken = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const invite = await ctx.db
      .query("invitations")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    if (!invite) return null;

    const expired = invite.expiresAt < Date.now();
    if (expired && invite.status === "pending") {
      // Don't leak token validity forever; but don't mutate here either
      // (query). Just surface "expired" to the UI.
    }

    const scopeName = await scopeNameFor(ctx, invite.scope, invite.scopeId);
    const inviter = await ctx.db.get(invite.invitedById);
    return {
      scope: invite.scope,
      scopeName,
      role: invite.role,
      email: invite.email,
      shareable: invite.shareable,
      // M26: undefined for non-reviewer roles; true/false for reviewer roles.
      // Landing page copy branches on this.
      blindMode: invite.blindMode,
      status: expired ? "expired" : invite.status,
      inviterName: inviter?.name ?? inviter?.email ?? "A teammate",
      expiresAt: invite.expiresAt,
    };
  },
});

/**
 * Authenticated accept. Creates the appropriate membership row and marks the
 * invite accepted. Returns a next-step hint for the UI.
 */
export const acceptWithAuth = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const user = await ctx.db.get(userId);
    if (!user) throw new Error("Not authenticated");
    const email = user.email ? normalizeEmail(user.email) : null;

    const invite = await ctx.db
      .query("invitations")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    if (!invite) throw new Error("Invitation not found");
    if (invite.status === "revoked") throw new Error("Invitation was revoked");
    if (invite.expiresAt < Date.now())
      throw new Error("This invitation has expired");

    if (!invite.shareable) {
      if (invite.status === "accepted")
        throw new Error("Invitation was already accepted");
      if (email && invite.email && invite.email !== email)
        throw new Error("This invitation was sent to a different email");
    }

    // Materialize the membership based on scope.
    await materializeMembership(ctx, invite, userId);

    const now = Date.now();
    if (invite.shareable) {
      await ctx.db.patch(invite._id, {
        acceptCount: invite.acceptCount + 1,
      });
    } else {
      await ctx.db.patch(invite._id, {
        status: "accepted",
        acceptedAt: now,
        acceptedByUserId: userId,
        acceptCount: invite.acceptCount + 1,
      });
    }

    return {
      scope: invite.scope,
      scopeId: invite.scopeId,
      role: invite.role,
    };
  },
});

/**
 * Guest accept (unauthenticated). Only allowed for scope=cycle,
 * role=cycle_reviewer. Creates/reuses a guestIdentities row keyed on the
 * invite email.
 *
 * For shareable invites the caller must provide `email` (public link,
 * self-attested). For targeted invites the email is pre-bound.
 */
export const acceptAsGuest = mutation({
  args: {
    token: v.string(),
    // Required only for shareable invites; ignored otherwise.
    email: v.optional(v.string()),
    displayName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const invite = await ctx.db
      .query("invitations")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    if (!invite) throw new Error("Invitation not found");
    if (invite.scope !== "cycle" || invite.role !== "cycle_reviewer") {
      throw new Error("Guest acceptance is only allowed for cycle reviewers");
    }
    if (invite.status === "revoked") throw new Error("Invitation was revoked");
    if (invite.expiresAt < Date.now())
      throw new Error("This invitation has expired");

    if (
      invite.shareable &&
      invite.maxAccepts !== undefined &&
      invite.acceptCount >= invite.maxAccepts
    ) {
      throw new Error("This invitation has reached its response limit");
    }

    const email = normalizeEmail(
      invite.shareable ? args.email ?? "" : invite.email,
    );
    if (!email) throw new Error("Email is required");

    // Find-or-create the guest identity.
    const existingGuest = await ctx.db
      .query("guestIdentities")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();

    let guestId: Id<"guestIdentities">;
    const now = Date.now();
    if (existingGuest) {
      guestId = existingGuest._id;
      if (args.displayName && !existingGuest.displayName) {
        await ctx.db.patch(guestId, { displayName: args.displayName });
      }
    } else {
      guestId = await ctx.db.insert("guestIdentities", {
        email,
        verifiedAt: now,
        displayName: args.displayName,
      });
    }

    // Write the cycleEvaluator row as a guest marker? No — cycleEvaluators is
    // userId-keyed. M25.5 will repoint evaluator tracking through invitations.
    // For now we just mark the invite accepted.
    if (invite.shareable) {
      await ctx.db.patch(invite._id, {
        acceptCount: invite.acceptCount + 1,
      });
    } else {
      await ctx.db.patch(invite._id, {
        status: "accepted",
        acceptedAt: now,
        acceptedByGuestId: guestId,
        acceptCount: invite.acceptCount + 1,
      });
    }

    return {
      scope: invite.scope,
      scopeId: invite.scopeId,
      role: invite.role,
      guestIdentityId: guestId,
    };
  },
});

async function materializeMembership(
  ctx: MutationCtx,
  invite: Doc<"invitations">,
  userId: Id<"users">,
): Promise<void> {
  const now = Date.now();
  if (invite.scope === "org") {
    const existing = await ctx.db
      .query("organizationMembers")
      .withIndex("by_org_and_user", (q) =>
        q
          .eq("organizationId", invite.scopeId as Id<"organizations">)
          .eq("userId", userId),
      )
      .unique();
    if (existing) return; // idempotent
    const orgRole =
      invite.role === "org_owner"
        ? "owner"
        : invite.role === "org_admin"
          ? "admin"
          : "member";
    await ctx.db.insert("organizationMembers", {
      organizationId: invite.scopeId as Id<"organizations">,
      userId,
      role: orgRole,
    });
    return;
  }
  if (invite.scope === "project") {
    const projectId = invite.scopeId as Id<"projects">;
    const project = await ctx.db.get(projectId);
    if (!project) throw new Error("Project not found");

    // Ensure the user is in the org (needed for the existing org-scoped
    // permission model).
    const orgMembership = await ctx.db
      .query("organizationMembers")
      .withIndex("by_org_and_user", (q) =>
        q.eq("organizationId", project.organizationId).eq("userId", userId),
      )
      .unique();
    if (!orgMembership) {
      await ctx.db.insert("organizationMembers", {
        organizationId: project.organizationId,
        userId,
        role: "member",
      });
    }

    const existing = await ctx.db
      .query("projectCollaborators")
      .withIndex("by_project_and_user", (q) =>
        q.eq("projectId", projectId).eq("userId", userId),
      )
      .unique();
    if (existing) return;

    const projectRole =
      invite.role === "project_owner"
        ? "owner"
        : invite.role === "project_editor"
          ? "editor"
          : "evaluator";
    await ctx.db.insert("projectCollaborators", {
      projectId,
      userId,
      role: projectRole,
      // M26: blindMode only carries meaning for evaluator rows. Default to
      // true (blind) for legacy invites missing the flag.
      blindMode:
        projectRole === "evaluator" ? (invite.blindMode ?? true) : undefined,
      invitedById: invite.invitedById,
      invitedAt: invite.invitedAt,
      acceptedAt: now,
    });
    return;
  }
  // cycle
  const cycleId = invite.scopeId as Id<"reviewCycles">;
  const cycle = await ctx.db.get(cycleId);
  if (!cycle) throw new Error("Cycle not found");
  const project = await ctx.db.get(cycle.projectId);
  if (!project) throw new Error("Project not found");

  // Cycle reviewers are NOT auto-added to the inviter's org. They get a
  // projectCollaborators evaluator row (sufficient for requireProjectRole on
  // the review session pipeline) and nothing else — leaving them with zero
  // orgs of their own means RootRedirect's first-run seed will provision
  // them a personal workspace after they finish reviewing, instead of
  // stranding them on someone else's dashboard as a low-privilege "member".
  const existingCollab = await ctx.db
    .query("projectCollaborators")
    .withIndex("by_project_and_user", (q) =>
      q.eq("projectId", cycle.projectId).eq("userId", userId),
    )
    .unique();
  if (!existingCollab) {
    await ctx.db.insert("projectCollaborators", {
      projectId: cycle.projectId,
      userId,
      role: "evaluator",
      // M26: cycle_reviewer invites always land here as evaluator — carry the
      // invite's blindMode through (defaults to true for legacy invites).
      blindMode: invite.blindMode ?? true,
      invitedById: invite.invitedById,
      invitedAt: invite.invitedAt,
      acceptedAt: now,
    });
  }

  const existing = await ctx.db
    .query("cycleEvaluators")
    .withIndex("by_cycle_and_user", (q) =>
      q.eq("cycleId", cycleId).eq("userId", userId),
    )
    .unique();
  if (existing) return;
  await ctx.db.insert("cycleEvaluators", {
    cycleId,
    userId,
    status: "pending",
    assignedAt: now,
    reminderCount: 0,
  });
}
