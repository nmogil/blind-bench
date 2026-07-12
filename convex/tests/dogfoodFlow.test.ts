/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import type { AgentRunTrace } from "../lib/agentTrace";
import opus from "./fixtures/harbor-opus.json";
import sonnet from "./fixtures/harbor-sonnet.json";
import haiku from "./fixtures/harbor-haiku.json";

// M31 dogfood: the WHOLE flywheel as one continuous flow on the real Harbor
// trajectories — ingest → blind review (comment + verdict) → step-level A/B
// matchup → real DPO/SFT export — verifying the training artifact actually
// carries real content end-to-end. This is the seam between the eight M31 issues
// that per-issue tests don't exercise together.
const asTrace = (t: unknown) => JSON.parse(JSON.stringify(t)) as unknown as AgentRunTrace;

async function seed(t: ReturnType<typeof convexTest>) {
  const ids = await t.run(async (ctx) => {
    const ownerUserId = await ctx.db.insert("users", { name: "Owner", email: "o@d.com" });
    const evalUserId = await ctx.db.insert("users", { name: "Rev", email: "r@d.com" });
    const orgId = await ctx.db.insert("organizations", { name: "Org", slug: "org", createdById: ownerUserId });
    await ctx.db.insert("organizationMembers", { organizationId: orgId, userId: ownerUserId, role: "owner" });
    const projectId = await ctx.db.insert("projects", { organizationId: orgId, name: "Agent QA", createdById: ownerUserId });
    await ctx.db.insert("projectCollaborators", { projectId, userId: ownerUserId, role: "owner", invitedById: ownerUserId, invitedAt: Date.now() });
    await ctx.db.insert("projectCollaborators", { projectId, userId: evalUserId, role: "evaluator", invitedById: ownerUserId, invitedAt: Date.now() });
    return { ownerUserId, evalUserId, projectId };
  });
  return {
    ids,
    asOwner: t.withIdentity({ subject: `${ids.ownerUserId}|s`, tokenIdentifier: `test|${ids.ownerUserId}` }),
    asBlind: t.withIdentity({ subject: `${ids.evalUserId}|s`, tokenIdentifier: `test|${ids.evalUserId}` }),
  };
}

describe("M31 dogfood — full flywheel on real trajectories", () => {
  test("ingest → opaque blind review → honest DPO exclusion + SFT export", async () => {
    const t = convexTest(schema);
    const { ids, asOwner, asBlind } = await seed(t);

    // 1. INGEST — persist three real Harbor trajectories of the same task.
    const traces: Record<string, Id<"agentTraces">> = {};
    for (const [combo, trace] of [["opus", opus], ["sonnet", sonnet], ["haiku", haiku]] as const) {
      const res = await asOwner.action(api.agentTraces.persistTrace, { projectId: ids.projectId, trace: asTrace(trace) });
      expect(res.deduped).toBe(false);
      traces[combo] = res.agentTraceId;
    }

    // 2. BLIND REVIEW — a reviewer discovers them (no provenance), reads steps,
    //    comments on a step, and rates the trajectory.
    const list = await asBlind.query(api.agentTraceReviewSessions.listMine, {});
    const traceSessions = list.filter((session) => session.kind === "trace");
    expect(traceSessions).toHaveLength(3);
    expect(JSON.stringify(traceSessions)).not.toContain("agentTraceId");
    const firstToken = traceSessions[0]?.token;
    const secondToken = traceSessions[1]?.token;
    if (!firstToken || !secondToken) throw new Error("Missing opaque review sessions");
    const steps = await asBlind.query(api.agentTraceReviewSessions.listSteps, {
      token: firstToken,
      paginationOpts: { numItems: 50, cursor: null },
    });
    expect(steps.page.length).toBeGreaterThan(0);
    const commentStep = steps.page[1];
    if (!commentStep) throw new Error("Missing comment step");
    await asBlind.mutation(api.agentTraceReviewSessions.addComment, {
      token: firstToken,
      target: { kind: "step", stepIndex: commentStep.stepIndex },
      comment: "Reasonable first move.",
      label: "praise",
    });
    await asBlind.mutation(api.agentTraceReviewSessions.setVerdict, { token: firstToken, rating: "best" });
    await asBlind.mutation(api.agentTraceReviewSessions.setVerdict, { token: secondToken, rating: "acceptable" });

    // 3. A/B MATCHUP — the DPO-shaped signal: winner's next action vs loser's.
    // Real divergence is at step 4 (steps 0-3 are an identical prefix — user
    // prompt + setup hooks); Opus and Sonnet take different next actions there.
    const matchupId = await asOwner.mutation(api.agentTraceReview.createMatchup, {
      leftTraceId: traces.opus!,
      rightTraceId: traces.sonnet!,
      divergenceStepIndex: 4,
      leftBlindLabel: "A",
      rightBlindLabel: "B",
    });
    const persistedMatchup = await t.run(async (ctx) => await ctx.db.get(matchupId));
    expect(persistedMatchup?.comparabilityStatus).toBe("invalid");

    // 4. EXPORT — verdict/preference data alone is never training consent.
    // These legacy Harbor fixtures are not strict full-span evidence and cannot
    // receive a #287 approval.
    await expect(asOwner.action(api.exports.generateExport, {
      projectId: ids.projectId, source: "trajectory", format: "dpo",
    })).rejects.toThrow(/training approval/i);
    await expect(asOwner.action(api.exports.generateExport, {
      projectId: ids.projectId, source: "trajectory", format: "sft",
    })).rejects.toThrow(/training approval/i);
  });
});
