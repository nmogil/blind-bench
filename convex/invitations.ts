/**
 * M25: Unified invitations. Replaces the three parallel invite paths (org
 * members, project collaborators, cycle reviewers) with one table + one API.
 *
 * # Membership model — three rings (M29.2)
 *
 * Access in Blind Bench is structured as three non-overlapping rings:
 *
 *   1. **Org member** (`organizationMembers`) — full team member of a
 *      workspace. Can create projects, manage org-level settings, see the
 *      org sidebar.
 *   2. **Project collaborator** (`projectCollaborators`) — scoped access to
 *      a single project as `owner` / `editor` / `evaluator`. Independent
 *      of org membership: a project collaborator does *not* implicitly
 *      gain org-level read access.
 *
 * M30: there is no separate guest principal. A "guest" reviewer is an
 * anonymous Convex Auth user (`isAnonymous: true`) that accepts a reviewer
 * invite and is written into ring 2 as an `evaluator`. See
 * `acceptInviteAsGuest` — the entire review pipeline then treats it like any
 * other evaluator collaborator.
 *
 * # One-row-per-scope rule
 *
 * Each invite scope writes exactly **one row** into exactly **one
 * membership table** on accept. No cross-scope writes.
 *
 *   | Scope     | Writes to                                    |
 *   | --------- | -------------------------------------------- |
 *   | `org`     | `organizationMembers`                        |
 *   | `project` | `projectCollaborators`                       |
 *   | `cycle`   | `projectCollaborators` (role: `evaluator`)   |
 *
 * `cycleEvaluators` is also written on cycle accept, but it is a per-cycle
 * **workflow status** table (pending / in_progress / completed), not a
 * membership ring. It does not grant access — `requireProjectRole` reads
 * `projectCollaborators` only. The status-table write is therefore not a
 * cross-scope membership write.
 *
 * Why the rule matters: invite acceptance used to insert into multiple
 * membership tables "to be safe," which silently coupled invites to
 * onboarding state and routing. See `convex/sampleSeed.ts` (M29.1) for
 * the seed-signal decoupling and commit `6e01dd7` for the cycle-invite
 * fix that motivated the rule.
 *
 * Anonymous guests may ONLY accept reviewer-role invites (`cycle_reviewer`,
 * `project_evaluator`) — both resolve to an `evaluator` row. Owner/editor and
 * all org invites require a real account.
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
 * M29.6: Single-shot helper for the co-pilot collab nudge. Mints (or reuses)
 * a shareable project_evaluator invite for the given project and returns the
 * token so the client can copy the URL to the clipboard immediately. Reuse
 * keeps clicking "Get feedback" twice from spawning duplicate links — same
 * link, same clipboard write.
 */
export const mintShareableProjectInvite = mutation({
  args: {
    projectId: v.id("projects"),
    blindMode: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { userId } = await requireProjectRole(ctx, args.projectId, [
      "owner",
    ]);

    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Project not found");

    const now = Date.now();

    // Reuse a pending shareable evaluator invite if one already exists.
    const existing = await ctx.db
      .query("invitations")
      .withIndex("by_scope", (q) =>
        q.eq("scope", "project").eq("scopeId", args.projectId as string),
      )
      .filter((q) =>
        q.and(
          q.eq(q.field("role"), "project_evaluator"),
          q.eq(q.field("shareable"), true),
          q.eq(q.field("status"), "pending"),
        ),
      )
      .first();

    if (existing && existing.expiresAt > now) {
      return { token: existing.token, reused: true };
    }

    const token = generateToken();
    await ctx.db.insert("invitations", {
      scope: "project",
      scopeId: args.projectId as string,
      orgId: project.organizationId,
      role: "project_evaluator",
      email: "",
      token,
      shareable: true,
      blindMode: args.blindMode ?? true,
      status: "pending",
      invitedById: userId,
      invitedAt: now,
      expiresAt: now + PROJECT_TTL_MS,
      acceptCount: 0,
    });

    return { token, reused: false };
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

    // M29.2: dispatch to the per-scope acceptor. Each acceptor writes to
    // exactly one membership table — see the three-rings comment at the
    // top of this file.
    if (invite.scope === "org") {
      await acceptOrgInvite(ctx, invite, userId);
    } else if (invite.scope === "project") {
      await acceptProjectInvite(ctx, invite, userId);
    } else {
      await acceptCycleInvite(ctx, invite, userId);
    }

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

    // M29.2 follow-up: surface enough context to route acceptors directly to
    // their landing surface (project URL, org dashboard) instead of bouncing
    // them through RootRedirect. Without this, project-invite acceptors land
    // on the seeded sample workspace because they no longer auto-join the
    // inviter's org — see acceptProjectInvite for that change.
    let orgSlug: string | null = null;
    let projectId: Id<"projects"> | null = null;
    if (invite.scope === "org") {
      const org = await ctx.db.get(invite.scopeId as Id<"organizations">);
      orgSlug = org?.slug ?? null;
    } else if (invite.scope === "project") {
      projectId = invite.scopeId as Id<"projects">;
      const project = await ctx.db.get(projectId);
      if (project) {
        const org = await ctx.db.get(project.organizationId);
        orgSlug = org?.slug ?? null;
      }
    }

    return {
      scope: invite.scope,
      scopeId: invite.scopeId,
      role: invite.role,
      orgSlug,
      projectId,
    };
  },
});

/**
 * M30: No-account guest accept. The caller is an *anonymous* Convex Auth user
 * (minted client-side via `signIn("anonymous")` right before this call), so
 * `getAuthUserId` resolves to a real `users` row and the entire review
 * pipeline — `requireProjectRole`, `isBlindReviewer`, session/rating tables —
 * works unchanged. The guest simply becomes an `evaluator` collaborator.
 *
 * Privilege gate: anonymous users may ONLY accept reviewer-role invites
 * (`cycle_reviewer`, `project_evaluator`). Both resolve to an `evaluator`
 * projectCollaborators row — never owner/editor/org access — so a guest can
 * never escalate by presenting an org/project-owner token. Real signed-in
 * users must use `acceptWithAuth` (which handles every scope).
 *
 * `displayName`/`email` are self-reported attribution stored on the anon user
 * row so the cycle owner can tell guests apart. They are NOT auth credentials
 * and are never verified.
 */
export const acceptInviteAsGuest = mutation({
  args: {
    token: v.string(),
    displayName: v.optional(v.string()),
    email: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireAuth(ctx);
    const user = await ctx.db.get(userId);
    if (!user) throw new Error("Not authenticated");
    // Real accounts carry richer identity and route through acceptWithAuth.
    // Keeping guests on the anonymous path stops a signed-in user from
    // accidentally laundering an owner invite down to evaluator access.
    if (!user.isAnonymous) {
      throw new Error("Signed-in users should accept with their account");
    }

    const invite = await ctx.db
      .query("invitations")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    if (!invite) throw new Error("Invitation not found");

    // The privilege gate — see the function-level comment.
    if (
      invite.role !== "cycle_reviewer" &&
      invite.role !== "project_evaluator"
    ) {
      throw new Error("This invitation requires an account");
    }

    if (invite.status === "revoked") throw new Error("Invitation was revoked");
    if (invite.expiresAt < Date.now())
      throw new Error("This invitation has expired");
    if (!invite.shareable && invite.status === "accepted")
      throw new Error("Invitation was already accepted");
    if (
      invite.shareable &&
      invite.maxAccepts !== undefined &&
      invite.acceptCount >= invite.maxAccepts
    ) {
      throw new Error("This invitation has reached its response limit");
    }

    // Self-reported attribution. Only fill blanks — never overwrite values the
    // user already has (an anon user could accept a second invite).
    const patch: { name?: string; email?: string } = {};
    const trimmedName = args.displayName?.trim();
    if (trimmedName && !user.name) patch.name = trimmedName.slice(0, 80);
    const normalizedEmail = args.email ? normalizeEmail(args.email) : "";
    if (normalizedEmail && !user.email) patch.email = normalizedEmail;
    if (Object.keys(patch).length > 0) await ctx.db.patch(userId, patch);

    // Both reviewer roles land as an `evaluator` collaborator via the same
    // per-scope acceptors used by acceptWithAuth — one membership row, blind
    // semantics carried from the invite.
    if (invite.scope === "cycle") {
      await acceptCycleInvite(ctx, invite, userId);
    } else {
      await acceptProjectInvite(ctx, invite, userId);
    }

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
      blindMode: invite.blindMode ?? true,
    };
  },
});

async function acceptOrgInvite(
  ctx: MutationCtx,
  invite: Doc<"invitations">,
  userId: Id<"users">,
): Promise<void> {
  const orgId = invite.scopeId as Id<"organizations">;
  const existing = await ctx.db
    .query("organizationMembers")
    .withIndex("by_org_and_user", (q) =>
      q.eq("organizationId", orgId).eq("userId", userId),
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
    organizationId: orgId,
    userId,
    role: orgRole,
  });
}

async function acceptProjectInvite(
  ctx: MutationCtx,
  invite: Doc<"invitations">,
  userId: Id<"users">,
): Promise<void> {
  const projectId = invite.scopeId as Id<"projects">;
  const project = await ctx.db.get(projectId);
  if (!project) throw new Error("Project not found");

  // M29.2: project invites no longer auto-create an organizationMembers row
  // for the inviter's org. A project collaborator is its own access ring;
  // they reach the project via direct URL or "Pending invitations" and
  // their personal workspace is seeded by ensureFirstRunSeed on next root
  // visit. This matches the post-6e01dd7 cycle-reviewer behavior.
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
    acceptedAt: Date.now(),
  });
}

async function acceptCycleInvite(
  ctx: MutationCtx,
  invite: Doc<"invitations">,
  userId: Id<"users">,
): Promise<void> {
  const cycleId = invite.scopeId as Id<"reviewCycles">;
  const cycle = await ctx.db.get(cycleId);
  if (!cycle) throw new Error("Cycle not found");
  const now = Date.now();

  // Membership ring write: projectCollaborators (evaluator) only — see the
  // three-rings comment at the top of this file. No org-member side effect.
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

  // Per-cycle workflow status (NOT a membership ring). Tracks the
  // reviewer's pending/in_progress/completed state for this specific
  // cycle; access is granted by the projectCollaborators row above.
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
