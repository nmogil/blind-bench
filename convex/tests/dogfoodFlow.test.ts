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
  test("ingest → blind review → A/B → real DPO + SFT export", async () => {
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
    const list = await asBlind.query(api.agentTraces.listReviewableTraces, {});
    expect(list).toHaveLength(3);
    const steps = await asBlind.query(api.agentTraces.listSteps, {
      agentTraceId: traces.opus!,
      paginationOpts: { numItems: 50, cursor: null },
    });
    expect(steps.page.length).toBeGreaterThan(0);
    await asBlind.mutation(api.agentTraceReview.addComment, {
      agentTraceId: traces.opus!,
      target: { kind: "step", stepIndex: steps.page[1]!.stepIndex },
      comment: "Reasonable first move.",
      label: "praise",
    });
    await asBlind.mutation(api.agentTraceReview.setVerdict, { agentTraceId: traces.haiku!, rating: "best" });
    await asBlind.mutation(api.agentTraceReview.setVerdict, { agentTraceId: traces.opus!, rating: "acceptable" });

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
    await asBlind.mutation(api.agentTraceReview.decideMatchup, { matchupId, winner: "left", reasonTags: ["accuracy"] });

    // 4. EXPORT — the flywheel payoff: a real DPO pair falls out of the matchup.
    const dpo = await asOwner.action(api.exports.generateExport, {
      projectId: ids.projectId, source: "trajectory", format: "dpo",
    });
    expect(dpo.rowCount).toBeGreaterThanOrEqual(1);
    const dpoJsonl = await t.run(async (ctx) => {
      const row = await ctx.db.query("trainingExports").order("desc").first();
      const blob = row ? await ctx.storage.get(row.storageId) : null;
      return blob ? await blob.text() : "";
    });
    const pair = JSON.parse(dpoJsonl.split("\n")[0]!);
    // The DPO pair carries real content: a prompt (shared prefix), and distinct
    // chosen (winner) vs rejected (loser) next actions.
    expect(pair).toHaveProperty("prompt");
    expect(pair).toHaveProperty("chosen");
    expect(pair).toHaveProperty("rejected");
    expect(pair.chosen).not.toBe(pair.rejected);
    expect(typeof pair.prompt).toBe("string");
    expect(pair.prompt.length).toBeGreaterThan(0);
    // No provider/harness provenance leaks into the training data.
    expect(dpoJsonl).not.toContain("claude-opus");

    // SFT from the best-verdict trajectory.
    const sft = await asOwner.action(api.exports.generateExport, {
      projectId: ids.projectId, source: "trajectory", format: "sft",
    });
    expect(sft.rowCount).toBeGreaterThanOrEqual(1);

    // Surface the real artifact so a dogfood run shows what shipped.
    // eslint-disable-next-line no-console
    console.log(
      `\n[dogfood] DPO pair from real Harbor A/B (Opus✓ vs Sonnet✗):\n` +
        `  prompt : ${String(pair.prompt).slice(0, 90).replace(/\n/g, " ")}…\n` +
        `  chosen : ${String(pair.chosen).slice(0, 90).replace(/\n/g, " ")}…\n` +
        `  reject : ${String(pair.rejected).slice(0, 90).replace(/\n/g, " ")}…\n` +
        `  → dpo rows=${dpo.rowCount} excluded=${dpo.excludedCount}, sft rows=${sft.rowCount}`,
    );
  });
});
