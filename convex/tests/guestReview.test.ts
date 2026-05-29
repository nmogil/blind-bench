/**
 * M30: No-account guest review.
 *
 * Verifies the anonymous-guest accept gate and that an anonymous guest, once
 * accepted, is a normal blind evaluator the review pipeline accepts unchanged.
 * Blind-filter guarantees themselves are covered by evalSecurity.test.ts —
 * a guest is just an evaluator collaborator, so those guarantees transfer.
 */

import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import type { Id } from "../_generated/dataModel";

async function seedGuestEnv() {
  const t = convexTest(schema);

  const ids = await t.run(async (ctx) => {
    const ownerUserId = await ctx.db.insert("users", {
      name: "Owner",
      email: "owner@test.com",
    });
    const orgId = await ctx.db.insert("organizations", {
      name: "Org",
      slug: "org",
      createdById: ownerUserId,
    });
    const projectId = await ctx.db.insert("projects", {
      organizationId: orgId,
      name: "Project",
      createdById: ownerUserId,
    });
    await ctx.db.insert("projectCollaborators", {
      projectId,
      userId: ownerUserId,
      role: "owner",
      invitedById: ownerUserId,
      invitedAt: Date.now(),
    });
    const versionId = await ctx.db.insert("promptVersions", {
      projectId,
      versionNumber: 1,
      userMessageTemplate: "Hi {{name}}",
      status: "current",
      createdById: ownerUserId,
    });
    const testCaseId = await ctx.db.insert("testCases", {
      projectId,
      name: "TC1",
      variableValues: { name: "World" },
      attachmentIds: [],
      order: 0,
      createdById: ownerUserId,
    });
    const runId = await ctx.db.insert("promptRuns", {
      projectId,
      promptVersionId: versionId,
      testCaseId,
      model: "openai/gpt-4",
      temperature: 0.7,
      status: "completed",
      completedAt: Date.now(),
      triggeredById: ownerUserId,
    });
    const runOutputId = await ctx.db.insert("runOutputs", {
      runId,
      blindLabel: "A",
      outputContent: "content A",
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      latencyMs: 100,
    });
    const cycleId = await ctx.db.insert("reviewCycles", {
      projectId,
      primaryVersionId: versionId,
      name: "Cycle",
      status: "open",
      includeSoloEval: false,
      createdById: ownerUserId,
      openedAt: Date.now(),
    });
    await ctx.db.insert("cycleOutputs", {
      cycleId,
      sourceOutputId: runOutputId,
      sourceRunId: runId,
      sourceVersionId: versionId,
      cycleBlindLabel: "A",
      outputContentSnapshot: "content A",
    });

    return { ownerUserId, orgId, projectId, cycleId, runId };
  });

  // Mint an anonymous guest user, as the Anonymous provider would.
  const guestUserId = await t.run((ctx) =>
    ctx.db.insert("users", { isAnonymous: true }),
  );
  const asGuest = t.withIdentity({
    subject: `${guestUserId}|test-session-guest`,
    tokenIdentifier: `test|${guestUserId}`,
  });

  return { t, ids, guestUserId, asGuest };
}

type InviteOverrides = {
  scope?: "org" | "project" | "cycle";
  scopeId?: string;
  role?:
    | "org_owner"
    | "org_admin"
    | "org_member"
    | "project_owner"
    | "project_editor"
    | "project_evaluator"
    | "cycle_reviewer";
  shareable?: boolean;
  status?: "pending" | "accepted" | "revoked" | "expired";
  expiresAt?: number;
  acceptCount?: number;
  maxAccepts?: number;
  blindMode?: boolean;
  email?: string;
};

async function makeInvite(
  t: Awaited<ReturnType<typeof seedGuestEnv>>["t"],
  ids: Awaited<ReturnType<typeof seedGuestEnv>>["ids"],
  o: InviteOverrides = {},
): Promise<{ id: Id<"invitations">; token: string }> {
  const token = `tok-${Math.round(o.acceptCount ?? 0)}-${o.role ?? "cycle_reviewer"}-${o.scope ?? "cycle"}-${o.status ?? "pending"}`;
  const id = await t.run((ctx) =>
    ctx.db.insert("invitations", {
      scope: o.scope ?? "cycle",
      scopeId: o.scopeId ?? (ids.cycleId as string),
      orgId: ids.orgId,
      role: o.role ?? "cycle_reviewer",
      email: o.email ?? "",
      token,
      shareable: o.shareable ?? true,
      blindMode: o.blindMode ?? true,
      status: o.status ?? "pending",
      invitedById: ids.ownerUserId,
      invitedAt: Date.now(),
      expiresAt: o.expiresAt ?? Date.now() + 1_000_000,
      acceptCount: o.acceptCount ?? 0,
      maxAccepts: o.maxAccepts,
    }),
  );
  return { id, token };
}

describe("acceptInviteAsGuest — provisioning", () => {
  test("cycle_reviewer accept makes exactly one evaluator collaborator + cycle evaluator", async () => {
    const { t, ids, guestUserId, asGuest } = await seedGuestEnv();
    const { token } = await makeInvite(t, ids, {
      scope: "cycle",
      role: "cycle_reviewer",
      shareable: false,
    });

    const res = await asGuest.mutation(api.invitations.acceptInviteAsGuest, {
      token,
      displayName: "Jane",
    });
    expect(res).toMatchObject({
      scope: "cycle",
      scopeId: ids.cycleId,
      role: "cycle_reviewer",
      blindMode: true,
    });

    const { collaborators, cycleEvals, user } = await t.run(async (ctx) => ({
      collaborators: await ctx.db
        .query("projectCollaborators")
        .withIndex("by_project_and_user", (q) =>
          q.eq("projectId", ids.projectId).eq("userId", guestUserId),
        )
        .collect(),
      cycleEvals: await ctx.db
        .query("cycleEvaluators")
        .withIndex("by_cycle_and_user", (q) =>
          q.eq("cycleId", ids.cycleId).eq("userId", guestUserId),
        )
        .collect(),
      user: await ctx.db.get(guestUserId),
    }));

    expect(collaborators).toHaveLength(1);
    expect(collaborators[0]).toMatchObject({ role: "evaluator", blindMode: true });
    expect(cycleEvals).toHaveLength(1);
    expect(cycleEvals[0]?.status).toBe("pending");
    expect(user?.name).toBe("Jane");
  });

  test("project_evaluator accept makes an evaluator collaborator on the project", async () => {
    const { t, ids, guestUserId, asGuest } = await seedGuestEnv();
    const { token } = await makeInvite(t, ids, {
      scope: "project",
      scopeId: ids.projectId as string,
      role: "project_evaluator",
      shareable: true,
    });

    await asGuest.mutation(api.invitations.acceptInviteAsGuest, { token });

    const collaborators = await t.run((ctx) =>
      ctx.db
        .query("projectCollaborators")
        .withIndex("by_project_and_user", (q) =>
          q.eq("projectId", ids.projectId).eq("userId", guestUserId),
        )
        .collect(),
    );
    expect(collaborators).toHaveLength(1);
    expect(collaborators[0]?.role).toBe("evaluator");
  });

  test("shareable accept bumps acceptCount without marking the invite accepted", async () => {
    const { t, ids, asGuest } = await seedGuestEnv();
    const { id, token } = await makeInvite(t, ids, { shareable: true });

    await asGuest.mutation(api.invitations.acceptInviteAsGuest, { token });

    const invite = await t.run((ctx) => ctx.db.get(id));
    expect(invite?.acceptCount).toBe(1);
    expect(invite?.status).toBe("pending");
  });
});

describe("acceptInviteAsGuest — privilege gate", () => {
  test("rejects non-reviewer roles (no escalation to owner/org access)", async () => {
    const { t, ids, asGuest } = await seedGuestEnv();
    for (const role of [
      "org_member",
      "project_owner",
      "project_editor",
    ] as const) {
      const scope = role.startsWith("org") ? "org" : "project";
      const scopeId =
        scope === "org" ? (ids.orgId as string) : (ids.projectId as string);
      const { token } = await makeInvite(t, ids, { role, scope, scopeId });
      await expect(
        asGuest.mutation(api.invitations.acceptInviteAsGuest, { token }),
      ).rejects.toThrow(/requires an account/);
    }
  });

  test("rejects a real (non-anonymous) signed-in user", async () => {
    const { t, ids } = await seedGuestEnv();
    const realUserId = await t.run((ctx) =>
      ctx.db.insert("users", { name: "Real", email: "real@test.com" }),
    );
    const asReal = t.withIdentity({
      subject: `${realUserId}|test-session-real`,
      tokenIdentifier: `test|${realUserId}`,
    });
    const { token } = await makeInvite(t, ids);
    await expect(
      asReal.mutation(api.invitations.acceptInviteAsGuest, { token }),
    ).rejects.toThrow(/account/);
  });

  test("enforces maxAccepts on shareable links", async () => {
    const { t, ids, asGuest } = await seedGuestEnv();
    const { token } = await makeInvite(t, ids, {
      shareable: true,
      maxAccepts: 1,
      acceptCount: 1,
    });
    await expect(
      asGuest.mutation(api.invitations.acceptInviteAsGuest, { token }),
    ).rejects.toThrow(/limit/);
  });

  test("rejects expired invites", async () => {
    const { t, ids, asGuest } = await seedGuestEnv();
    const { token } = await makeInvite(t, ids, { expiresAt: Date.now() - 1 });
    await expect(
      asGuest.mutation(api.invitations.acceptInviteAsGuest, { token }),
    ).rejects.toThrow(/expired/);
  });

  test("rejects revoked invites", async () => {
    const { t, ids, asGuest } = await seedGuestEnv();
    const { token } = await makeInvite(t, ids, { status: "revoked" });
    await expect(
      asGuest.mutation(api.invitations.acceptInviteAsGuest, { token }),
    ).rejects.toThrow(/revoked/);
  });
});

describe("guest review pipeline", () => {
  test("a bare anonymous user (no invite accepted) cannot start a review", async () => {
    const { ids, asGuest } = await seedGuestEnv();
    await expect(
      asGuest.mutation(api.reviewSessions.start, { cycleId: ids.cycleId }),
    ).rejects.toThrow(/Permission denied/);
  });

  test("an accepted guest can start a blind review session as an evaluator", async () => {
    const { t, ids, asGuest } = await seedGuestEnv();
    const { token } = await makeInvite(t, ids, { scope: "cycle" });
    await asGuest.mutation(api.invitations.acceptInviteAsGuest, { token });

    const sessionId = await asGuest.mutation(api.reviewSessions.start, {
      cycleId: ids.cycleId,
    });
    const data = await asGuest.query(api.reviewSessions.get, { sessionId });
    expect(data.session.role).toBe("evaluator");
    // Blind: outputs carry a session-scoped label and content, never the
    // source version/run identity.
    for (const output of data.outputs as Array<Record<string, unknown>>) {
      expect(output).not.toHaveProperty("sourceVersionId");
      expect(output).not.toHaveProperty("promptVersionId");
    }
  });
});
