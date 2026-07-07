/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import type { AgentRunTrace } from "../lib/agentTrace";
// Real trajectories from a live `harbor run … --agent claude-code --env daytona`
// matrix on terminal-bench@2.0 "fix-git" (2026-07-07), converted by
// scripts/harbor-import.ts and trimmed to the first 10 steps. See
// docs/harbor-matrix-spike.md for the full run + cost numbers.
import opus from "./fixtures/harbor-opus.json";
import sonnet from "./fixtures/harbor-sonnet.json";
import haiku from "./fixtures/harbor-haiku.json";

const traces: Record<string, AgentRunTrace> = {
  opus: opus as unknown as AgentRunTrace,
  sonnet: sonnet as unknown as AgentRunTrace,
  haiku: haiku as unknown as AgentRunTrace,
};

async function seed(t: ReturnType<typeof convexTest>) {
  const ids = await t.run(async (ctx) => {
    const ownerUserId = await ctx.db.insert("users", { name: "Owner", email: "o@test.com" });
    const evalUserId = await ctx.db.insert("users", { name: "Rev", email: "r@test.com" });
    const orgId = await ctx.db.insert("organizations", { name: "Org", slug: "org", createdById: ownerUserId });
    await ctx.db.insert("organizationMembers", { organizationId: orgId, userId: ownerUserId, role: "owner" });
    const projectId = await ctx.db.insert("projects", { organizationId: orgId, name: "P", createdById: ownerUserId });
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

describe("#268 Harbor matrix → spine → blind review (real trajectories)", () => {
  test("3 combos of the same task import and are blind-reviewable side-by-side", async () => {
    const t = convexTest(schema);
    const { ids, asOwner, asBlind } = await seed(t);

    const persisted: Record<string, Id<"agentTraces">> = {};
    for (const [combo, trace] of Object.entries(traces)) {
      const res = await asOwner.action(api.agentTraces.persistTrace, {
        projectId: ids.projectId,
        trace: JSON.parse(JSON.stringify(trace)) as unknown as AgentRunTrace,
      });
      expect(res.deduped).toBe(false);
      expect(res.stepCount).toBeGreaterThan(0);
      persisted[combo] = res.agentTraceId;
    }

    // A blind reviewer discovers all 3, provenance stripped (no model/harness).
    const list = await asBlind.query(api.agentTraces.listReviewableTraces, {});
    expect(list).toHaveLength(3);
    expect(JSON.stringify(list)).not.toContain("claude-opus");
    expect(JSON.stringify(list)).not.toContain("claude_code");

    // Blind step read on the winner (Opus solved) — steps render, no provenance.
    const page = await asBlind.query(api.agentTraces.listSteps, {
      agentTraceId: persisted.opus!,
      paginationOpts: { numItems: 50, cursor: null },
    });
    expect(page.page.length).toBeGreaterThan(0);
    expect(JSON.stringify(page.page)).not.toContain("claude-opus");

    // Owner sets up the DPO-shaped A/B: Opus (solved) vs Sonnet (failed).
    const matchupId = await asOwner.mutation(api.agentTraceReview.createMatchup, {
      leftTraceId: persisted.opus!,
      rightTraceId: persisted.sonnet!,
      divergenceStepIndex: 3,
      leftBlindLabel: "Trajectory A",
      rightBlindLabel: "Trajectory B",
    });
    await asBlind.mutation(api.agentTraceReview.decideMatchup, {
      matchupId,
      winner: "left",
      reasonTags: ["accuracy"],
    });
    const m = await asBlind.query(api.agentTraceReview.getMatchup, { matchupId });
    expect(m?.winner).toBe("left");
    // No provenance in the matchup payload — reviewer can't see which model won.
    expect(JSON.stringify(m)).not.toContain("claude");
  });
});
