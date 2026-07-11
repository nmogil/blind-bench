/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import producerFixture from "./fixtures/mogil-harbor-evidence-v1.json";

// Sanitized static fixture generated through the authoritative Mogil Bench
// HarborEvidence Pydantic model; copied here so BlindBench has no runtime
// dependency on the producer repository.
function artifact(runId = "mogil-producer-fixture-v1", attempt = "attempt-fixture-001") {
  const value = JSON.parse(JSON.stringify(producerFixture)) as Record<string, unknown>;
  object(value.run).id = runId;
  object(value.run).attempt = attempt;
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object expected");
  return value as Record<string, unknown>;
}
function reviewer(value: Record<string, unknown>): Record<string, unknown> { return object(value.reviewer); }
function envelope(runs: ReadonlyArray<unknown>): string { return JSON.stringify({ runs }); }
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}
async function fingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableStringify(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function reservation(stableRunId: string, attempt: string) {
  return {
    stableRunId,
    attempt,
    fingerprint: `fingerprint-${stableRunId}`,
    runQualification: "quality_eligible" as const,
    evidenceCompleteness: "complete" as const,
    canJudgeTaskSuccess: true,
    processOutcome: { status: "succeeded" as const },
    verifierOutcome: { status: "passed" as const },
    infrastructureOutcome: { status: "succeeded" as const },
    evidenceMissing: [],
    rewards: { reward: 1, command_exit: 1, stdout_assertion: 1 },
    startedAt: "2026-07-11T00:00:00Z",
    completedAt: "2026-07-11T00:00:01Z",
    terminationStatus: "quality_eligible",
    terminationReason: "completed",
  };
}

afterEach(() => {
  vi.useRealTimers();
});

async function setup() {
  const t = convexTest(schema);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Owner" });
    const guest = await ctx.db.insert("users", { name: "Guest", isAnonymous: true });
    const org = await ctx.db.insert("organizations", { name: "Org", slug: "org", createdById: owner });
    const project = await ctx.db.insert("projects", { organizationId: org, name: "Project", createdById: owner });
    const other = await ctx.db.insert("projects", { organizationId: org, name: "Other", createdById: owner });
    await ctx.db.insert("projectCollaborators", { projectId: project, userId: owner, role: "owner", invitedById: owner, invitedAt: 1 });
    await ctx.db.insert("projectCollaborators", { projectId: other, userId: owner, role: "owner", invitedById: owner, invitedAt: 1 });
    return { owner, guest, project, other };
  });
  return {
    t,
    ids,
    owner: t.withIdentity({ subject: `${ids.owner}|s`, tokenIdentifier: `t|${ids.owner}` }),
    guest: t.withIdentity({ subject: `${ids.guest}|s`, tokenIdentifier: `t|${ids.guest}` }),
  };
}
const headers = (token: string) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
async function responseBody(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  return object(value);
}

async function issueAutomation(
  owner: Awaited<ReturnType<typeof setup>>["owner"],
  projectId: Awaited<ReturnType<typeof setup>>["ids"]["project"],
) {
  return await owner.mutation(api.ingestTokens.issueIngestToken, {
    projectId,
    label: "automation",
    scopes: ["traces:write", "reviews:write", "reviews:read"],
  });
}

describe("POST /ingest/v1/eval-runs authoritative batch contract", () => {
  test("requires traces:write and ingests a three-run Pydantic-compatible envelope with complete counts", async () => {
    const { t, ids, owner } = await setup();
    expect((await t.fetch("/ingest/v1/eval-runs", { method: "POST", body: envelope([artifact()]) })).status).toBe(401);
    const readOnly = await owner.mutation(api.ingestTokens.issueIngestToken, { projectId: ids.project, label: "read", scopes: ["reviews:read"] });
    expect((await t.fetch("/ingest/v1/eval-runs", { method: "POST", headers: headers(readOnly.token), body: envelope([artifact()]) })).status).toBe(403);
    const automation = await issueAutomation(owner, ids.project);
    const runs = [
      artifact("activation-run-1", "activation-attempt-1"),
      artifact("activation-run-2", "activation-attempt-2"),
      artifact("activation-run-3", "activation-attempt-3"),
    ];
    const response = await t.fetch("/ingest/v1/eval-runs", { method: "POST", headers: headers(automation.token), body: envelope(runs) });
    expect(response.status).toBe(200);
    expect(await responseBody(response)).toEqual({ complete: 3, imported: 3, deduped: 0, invalid: 0 });
    const stored = await t.run(async (ctx) => ({
      spans: await ctx.db.query("fullSpanEvalRuns").collect(),
      traces: await ctx.db.query("agentTraces").collect(),
    }));
    expect(stored.spans).toHaveLength(3);
    expect(stored.traces).toHaveLength(3);
    expect(stored.spans.every((row) => row.status === "ready" && row.runQualification === "quality_eligible" && row.canJudgeTaskSuccess)).toBe(true);
    expect(stored.spans.every((row) => row.rawEvidenceStorageId && row.reviewerProjectionStorageId && row.rawEvidenceStorageId !== row.reviewerProjectionStorageId)).toBe(true);
  });

  test("replays and mixed batches deterministically, while conflicts reserve nothing", async () => {
    const { t, ids, owner } = await setup();
    const automation = await issueAutomation(owner, ids.project);
    const post = (runs: ReadonlyArray<unknown>) => t.fetch("/ingest/v1/eval-runs", { method: "POST", headers: headers(automation.token), body: envelope(runs) });
    const first = artifact("stable-1", "attempt-1");
    expect(await responseBody(await post([first]))).toEqual({ complete: 1, imported: 1, deduped: 0, invalid: 0 });
    expect(await responseBody(await post([first]))).toEqual({ complete: 1, imported: 0, deduped: 1, invalid: 0 });
    expect(await responseBody(await post([first, artifact("stable-2", "attempt-2")]))).toEqual({ complete: 2, imported: 1, deduped: 1, invalid: 0 });

    const conflict = artifact("stable-1", "attempt-1");
    object(reviewer(conflict).task).prompt = "Changed evidence under the same stable id.";
    const conflicted = await post([conflict, artifact("must-not-import", "attempt-3")]);
    expect(conflicted.status).toBe(409);
    expect(await responseBody(conflicted)).toMatchObject({ complete: 0, imported: 0, deduped: 0, invalid: 0 });
    expect(await t.run(async (ctx) => (await ctx.db.query("fullSpanEvalRuns").collect()).map((row) => row.stableRunId).sort())).toEqual(["stable-1", "stable-2"]);

    const reusedAttempt = await post([artifact("stable-3", "attempt-1")]);
    expect(reusedAttempt.status).toBe(409);
  });

  test("rejects a malformed member consistently and performs no partial import", async () => {
    const { t, ids, owner } = await setup();
    const automation = await issueAutomation(owner, ids.project);
    const malformed = artifact("bad", "bad-attempt");
    object(malformed.run).ended_at = undefined;
    const response = await t.fetch("/ingest/v1/eval-runs", {
      method: "POST",
      headers: headers(automation.token),
      body: envelope([artifact("good-1", "a1"), malformed, artifact("good-2", "a2")]),
    });
    expect(response.status).toBe(400);
    expect(await responseBody(response)).toEqual({ complete: 2, imported: 0, deduped: 0, invalid: 1 });
    expect(await t.run(async (ctx) => (await ctx.db.query("fullSpanEvalRuns").collect()).length)).toBe(0);

    const wrongEnvelope = await t.fetch("/ingest/v1/eval-runs", { method: "POST", headers: headers(automation.token), body: JSON.stringify({ records: [artifact()] }) });
    expect(wrongEnvelope.status).toBe(400);
    expect(await responseBody(wrongEnvelope)).toMatchObject({ complete: 0, imported: 0, deduped: 0, invalid: 1 });
  });

  test("rejects chunked bodies immediately after the hard 8 MiB cutoff", async () => {
    const { t, ids, owner } = await setup();
    const automation = await issueAutomation(owner, ids.project);
    let chunks = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunks++ < 9) controller.enqueue(new Uint8Array(1024 * 1024));
        else controller.close();
      },
    });
    const response = await t.fetch("/ingest/v1/eval-runs", {
      method: "POST",
      headers: headers(automation.token),
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(response.status).toBe(413);
    expect(await responseBody(response)).toMatchObject({ complete: 0, imported: 0, deduped: 0, invalid: 1 });
  });

  test("cleanup covers crashes after top-level storage, trace parent, and step creation", async () => {
    const { t, ids } = await setup();
    const created = await t.run(async (ctx) => {
      const inserted: Array<{ spanId: string; traceId?: string; storageIds: string[] }> = [];
      for (const stage of ["storage", "parent", "steps"] as const) {
        const raw = await ctx.storage.store(new Blob([stage]));
        const projection = await ctx.storage.store(new Blob([stage]));
        let traceId;
        const storageIds = [String(raw), String(projection)];
        if (stage !== "storage") {
          const final = stage === "steps" ? await ctx.storage.store(new Blob(["final"])) : undefined;
          traceId = await ctx.db.insert("agentTraces", {
            projectId: ids.project,
            traceId: `full-span:crash-${stage}`,
            source: "agent_harness",
            harnessName: "harbor/pi",
            product: "coding-task",
            stepCount: stage === "steps" ? 1 : 0,
            status: "pending",
            privacyClass: "internal",
            finalAnswerStorageId: final,
            importedById: ids.owner,
          });
          if (final) storageIds.push(String(final));
          if (stage === "steps") {
            const body = await ctx.storage.store(new Blob(["step"]));
            storageIds.push(String(body));
            await ctx.db.insert("agentTraceSteps", {
              agentTraceId: traceId,
              stepIndex: 0,
              prefixHash: "hash",
              kind: "message",
              role: "assistant",
              fullBodyStorageId: body,
            });
          }
        }
        const spanId = await ctx.db.insert("fullSpanEvalRuns", {
          projectId: ids.project,
          stableRunId: `crash-${stage}`,
          attempt: `attempt-${stage}`,
          fingerprint: `fingerprint-${stage}`,
          status: "pending",
          leaseId: `lease-${stage}`,
          leaseExpiresAt: 1,
          pendingAgentTraceId: traceId,
          pendingStorageIds: [raw, projection],
          runQualification: "insufficient",
          evidenceCompleteness: "insufficient",
          canJudgeTaskSuccess: false,
          processOutcome: { status: "failed" },
          verifierOutcome: { status: "not_run" },
          infrastructureOutcome: { status: "failed" },
          evidenceMissing: ["crash"],
          rewards: { reward: 0, command_exit: 0, stdout_assertion: 0 },
          startedAt: "2026-07-11T00:00:00Z",
          completedAt: "2026-07-11T00:00:00Z",
          terminationStatus: "insufficient",
          terminationReason: "crashed",
          importedById: ids.owner,
        });
        inserted.push({ spanId: String(spanId), traceId: traceId ? String(traceId) : undefined, storageIds });
      }
      return inserted;
    });
    expect(await t.mutation(internal.fullSpanIngest.cleanupRecoverableForProject, { projectId: ids.project, now: 2 })).toEqual({ cleaned: 3 });
    await t.run(async (ctx) => {
      expect(await ctx.db.query("agentTraceSteps").collect()).toEqual([]);
      expect(await ctx.db.query("agentTraces").collect()).toEqual([]);
      for (const item of created) {
        const spanId = ctx.db.normalizeId("fullSpanEvalRuns", item.spanId);
        if (!spanId) throw new Error("span id expected");
        expect(await ctx.db.get(spanId)).toMatchObject({ status: "failed" });
        for (const value of item.storageIds) {
          const storageId = ctx.db.system.normalizeId("_storage", value);
          if (!storageId) throw new Error("storage id expected");
          expect(await ctx.storage.get(storageId)).toBeNull();
        }
      }
    });
  });

  test("cleans stale storage, parent, steps, and final blobs before retrying the same fingerprint", async () => {
    const { t, ids, owner } = await setup();
    const automation = await issueAutomation(owner, ids.project);
    const source = artifact("recoverable-run", "recoverable-attempt");
    const post = () => t.fetch("/ingest/v1/eval-runs", { method: "POST", headers: headers(automation.token), body: envelope([source]) });
    expect(await responseBody(await post())).toEqual({ complete: 1, imported: 1, deduped: 0, invalid: 0 });
    const orphan = await t.run(async (ctx) => {
      const span = await ctx.db.query("fullSpanEvalRuns").unique();
      if (!span?.agentTraceId || !span.rawEvidenceStorageId || !span.reviewerProjectionStorageId) throw new Error("ready span expected");
      const trace = await ctx.db.get(span.agentTraceId);
      const steps = await ctx.db.query("agentTraceSteps").withIndex("by_trace_and_index", (q) => q.eq("agentTraceId", span.agentTraceId!)).collect();
      const storageIds = [
        span.rawEvidenceStorageId,
        span.reviewerProjectionStorageId,
        trace?.finalAnswerStorageId,
        trace?.finalAnswerBlindStorageId,
        ...steps.flatMap((step) => [step.fullBodyStorageId, step.blindBodyStorageId]),
      ].filter((id): id is NonNullable<typeof id> => id !== undefined);
      await ctx.db.patch(span._id, {
        status: "pending",
        leaseId: "crashed-owner",
        leaseExpiresAt: 1,
        pendingAgentTraceId: span.agentTraceId,
        pendingStorageIds: [span.rawEvidenceStorageId, span.reviewerProjectionStorageId],
        agentTraceId: undefined,
        rawEvidenceStorageId: undefined,
        reviewerProjectionStorageId: undefined,
      });
      return { spanId: span._id, traceId: span.agentTraceId, storageIds };
    });
    expect(await t.mutation(internal.fullSpanIngest.cleanupRecoverableForProject, { projectId: ids.project, now: 2 })).toEqual({ cleaned: 1 });
    await t.run(async (ctx) => {
      expect(await ctx.db.get(orphan.traceId)).toBeNull();
      expect(await ctx.db.query("agentTraceSteps").withIndex("by_trace_and_index", (q) => q.eq("agentTraceId", orphan.traceId)).collect()).toEqual([]);
      for (const storageId of orphan.storageIds) expect(await ctx.storage.get(storageId)).toBeNull();
      expect(await ctx.db.get(orphan.spanId)).toMatchObject({ status: "failed" });
    });
    expect(await responseBody(await post())).toEqual({ complete: 1, imported: 1, deduped: 0, invalid: 0 });
    expect(await t.run(async (ctx) => (await ctx.db.query("fullSpanEvalRuns").collect()).length)).toBe(1);
  });

  test("keeps a batch unpublished when run 2 of 3 fails, cleans every new artifact, and retries cleanly", async () => {
    const { t, ids, owner } = await setup();
    const automation = await issueAutomation(owner, ids.project);
    const existing = artifact("existing-ready", "existing-attempt");
    const post = (runs: ReadonlyArray<unknown>) => t.fetch("/ingest/v1/eval-runs", {
      method: "POST",
      headers: headers(automation.token),
      body: envelope(runs),
    });
    expect(await responseBody(await post([existing]))).toEqual({ complete: 1, imported: 1, deduped: 0, invalid: 0 });

    const baseline = await t.run(async (ctx) => ({
      traces: (await ctx.db.query("agentTraces").collect()).length,
      steps: (await ctx.db.query("agentTraceSteps").collect()).length,
      existing: await ctx.db
        .query("fullSpanEvalRuns")
        .withIndex("by_project_and_stable_id", (q) =>
          q.eq("projectId", ids.project).eq("stableRunId", "existing-ready"),
        )
        .unique(),
    }));
    if (!baseline.existing) throw new Error("existing full-span run expected");
    const existingReservation = reservation("existing-ready", "existing-attempt");
    existingReservation.fingerprint = baseline.existing.fingerprint;
    const newArtifacts = [
      artifact("atomic-new-1", "atomic-attempt-1"),
      artifact("atomic-new-2", "atomic-attempt-2"),
      artifact("atomic-new-3", "atomic-attempt-3"),
    ];
    const newReservations = await Promise.all(newArtifacts.map(async (value, index) => {
      const input = reservation(`atomic-new-${index + 1}`, `atomic-attempt-${index + 1}`);
      input.fingerprint = await fingerprint(value);
      return input;
    }));
    const leaseId = "atomic-batch-lease";
    const reserved = await t.mutation(internal.fullSpanIngest.reserveBatch, {
      projectId: ids.project,
      importedById: ids.owner,
      leaseId,
      leaseExpiresAt: 10_000,
      runs: [
        existingReservation,
        ...newReservations,
      ],
    });
    if (reserved.kind !== "reserved") throw new Error("batch reservation expected");
    const created = reserved.rows.filter((row) => !row.deduped);
    const stagedIds: Array<{
      spanId: Id<"fullSpanEvalRuns">;
      traceId: Id<"agentTraces">;
      storageIds: string[];
    }> = [];

    for (const [index, row] of created.entries()) {
      if (index === 1) break; // Inject the storage failure on run 2/3 after run 1 is fully staged.
      const staged = await t.run(async (ctx) => {
        const raw = await ctx.storage.store(new Blob(["raw"]));
        const projection = await ctx.storage.store(new Blob(["projection"]));
        const stepBody = await ctx.storage.store(new Blob(["step"]));
        const finalBody = await ctx.storage.store(new Blob(["final"]));
        const traceId = await ctx.db.insert("agentTraces", {
          projectId: ids.project,
          traceId: `full-span:${row.stableRunId}`,
          source: "agent_harness",
          harnessName: "harbor/pi",
          product: "coding-task",
          stepCount: 1,
          status: "pending",
          privacyClass: "internal",
          finalAnswerStorageId: finalBody,
          importedById: ids.owner,
        });
        await ctx.db.insert("agentTraceSteps", {
          agentTraceId: traceId,
          stepIndex: 0,
          prefixHash: "hash",
          kind: "message",
          role: "assistant",
          fullBodyStorageId: stepBody,
        });
        return { raw, projection, stepBody, finalBody, traceId };
      });
      await t.mutation(internal.fullSpanIngest.trackPendingArtifacts, {
        fullSpanRunId: row.fullSpanRunId,
        leaseId,
        storageIds: [staged.raw, staged.projection],
        agentTraceId: staged.traceId,
      });
      await t.mutation(internal.fullSpanIngest.stage, {
        fullSpanRunId: row.fullSpanRunId,
        leaseId,
        agentTraceId: staged.traceId,
        rawEvidenceStorageId: staged.raw,
        reviewerProjectionStorageId: staged.projection,
      });
      stagedIds.push({
        spanId: row.fullSpanRunId,
        traceId: staged.traceId,
        storageIds: [staged.raw, staged.projection, staged.stepBody, staged.finalBody].map(String),
      });
    }

    await expect(t.mutation(internal.fullSpanIngest.commitBatch, {
      rows: created.map((row) => ({ fullSpanRunId: row.fullSpanRunId, leaseId })),
    })).rejects.toThrow(/staged|lease/i);
    await t.mutation(internal.fullSpanIngest.failBatch, {
      rows: created.map((row) => ({ fullSpanRunId: row.fullSpanRunId, leaseId })),
    });

    await t.run(async (ctx) => {
      const spans = await ctx.db.query("fullSpanEvalRuns").collect();
      expect(spans.filter((row) => row.status === "ready")).toHaveLength(1);
      expect(spans.find((row) => row.status === "ready")?.stableRunId).toBe("existing-ready");
      expect(await ctx.db.query("agentTraces").collect()).toHaveLength(baseline.traces);
      expect(await ctx.db.query("agentTraceSteps").collect()).toHaveLength(baseline.steps);
      for (const staged of stagedIds) {
        expect(await ctx.db.get(staged.traceId)).toBeNull();
        expect(await ctx.db.get(staged.spanId)).toMatchObject({ status: "failed" });
        for (const value of staged.storageIds) {
          const storageId = ctx.db.system.normalizeId("_storage", value);
          if (!storageId) throw new Error("storage id expected");
          expect(await ctx.storage.get(storageId)).toBeNull();
        }
      }
    });

    const retry = await post([existing, ...newArtifacts]);
    expect(retry.status).toBe(200);
    expect(await responseBody(retry)).toEqual({ complete: 4, imported: 3, deduped: 1, invalid: 0 });
  });

  test("renews an owned staged lease beyond five minutes and reclaims it only after heartbeats stop", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-07-11T12:00:00Z");
    vi.setSystemTime(startedAt);
    const { t, ids } = await setup();
    const leaseId = "heartbeating-owner";
    const reserved = await t.mutation(internal.fullSpanIngest.reserveBatch, {
      projectId: ids.project,
      importedById: ids.owner,
      leaseId,
      leaseExpiresAt: Date.now() + 5 * 60_000,
      runs: [reservation("heartbeat-run", "heartbeat-attempt")],
    });
    if (reserved.kind !== "reserved") throw new Error("batch reservation expected");
    const run = reserved.rows[0];
    if (!run) throw new Error("reserved run expected");

    vi.setSystemTime(new Date(startedAt.getTime() + 4 * 60_000));
    await t.mutation(internal.fullSpanIngest.renewLease, {
      fullSpanRunId: run.fullSpanRunId,
      leaseId,
      leaseExpiresAt: Date.now() + 5 * 60_000,
    });
    vi.setSystemTime(new Date(startedAt.getTime() + 6 * 60_000));
    expect(await t.mutation(internal.fullSpanIngest.cleanupRecoverableForProject, {
      projectId: ids.project,
      now: Date.now(),
    })).toEqual({ cleaned: 0 });

    await t.run(async (ctx) => {
      const row = await ctx.db.get(run.fullSpanRunId);
      if (!row) throw new Error("reserved row expected");
      await ctx.db.patch(row._id, { status: "staged" });
    });
    vi.setSystemTime(new Date(startedAt.getTime() + 8 * 60_000));
    await t.mutation(internal.fullSpanIngest.renewLease, {
      fullSpanRunId: run.fullSpanRunId,
      leaseId,
      leaseExpiresAt: Date.now() + 5 * 60_000,
    });
    vi.setSystemTime(new Date(startedAt.getTime() + 10 * 60_000));
    expect(await t.mutation(internal.fullSpanIngest.cleanupRecoverableForProject, {
      projectId: ids.project,
      now: Date.now(),
    })).toEqual({ cleaned: 0 });

    vi.setSystemTime(new Date(startedAt.getTime() + 14 * 60_000));
    expect(await t.mutation(internal.fullSpanIngest.cleanupRecoverableForProject, {
      projectId: ids.project,
      now: Date.now(),
    })).toEqual({ cleaned: 1 });
    expect(await t.run(async (ctx) => ctx.db.get(run.fullSpanRunId))).toMatchObject({ status: "failed" });
  });

  test("rejects legacy and namespaced trace collisions without attaching full-span evidence", async () => {
    const { t, ids, owner } = await setup();
    const automation = await issueAutomation(owner, ids.project);
    await t.run(async (ctx) => {
      await ctx.db.insert("agentTraces", {
        projectId: ids.project,
        traceId: "legacy-collision",
        source: "agent_harness",
        harnessName: "legacy",
        product: "legacy",
        stepCount: 0,
        status: "ready",
        privacyClass: "internal",
        importedById: ids.owner,
      });
      await ctx.db.insert("agentTraces", {
        projectId: ids.project,
        traceId: "full-span:namespaced-collision",
        source: "agent_harness",
        harnessName: "legacy",
        product: "legacy",
        stepCount: 0,
        status: "ready",
        privacyClass: "internal",
        importedById: ids.owner,
      });
    });
    for (const [runId, attempt] of [["legacy-collision", "collision-a"], ["namespaced-collision", "collision-b"]] as const) {
      const response = await t.fetch("/ingest/v1/eval-runs", { method: "POST", headers: headers(automation.token), body: envelope([artifact(runId, attempt)]) });
      expect(response.status).toBe(409);
      expect(await responseBody(response)).toMatchObject({ complete: 0, imported: 0, deduped: 0, invalid: 0 });
    }
    expect(await t.run(async (ctx) => (await ctx.db.query("fullSpanEvalRuns").collect()).length)).toBe(0);
  });

  test("stable ids and attempts are isolated by project tenancy", async () => {
    const { t, ids, owner } = await setup();
    const first = await issueAutomation(owner, ids.project);
    const second = await owner.mutation(api.ingestTokens.issueIngestToken, { projectId: ids.other, label: "other", scopes: ["traces:write"] });
    const body = envelope([artifact("same-id", "same-attempt")]);
    expect((await t.fetch("/ingest/v1/eval-runs", { method: "POST", headers: headers(first.token), body })).status).toBe(200);
    expect((await t.fetch("/ingest/v1/eval-runs", { method: "POST", headers: headers(second.token), body })).status).toBe(200);
    expect(await t.run(async (ctx) => (await ctx.db.query("fullSpanEvalRuns").collect()).length)).toBe(2);
  });

  test("creates reviews by producer run id, never projects private metadata, and gates fixture-only verdicts", async () => {
    const { t, ids, owner, guest } = await setup();
    const automation = await issueAutomation(owner, ids.project);
    const quality = artifact("quality-run", "quality-attempt");
    const fixtureOnly = artifact("fixture-run", "fixture-attempt");
    object(fixtureOnly.run).status = "fixture_complete";
    const ingest = await t.fetch("/ingest/v1/eval-runs", { method: "POST", headers: headers(automation.token), body: envelope([quality, fixtureOnly]) });
    expect(await responseBody(ingest)).toEqual({ complete: 2, imported: 2, deduped: 0, invalid: 0 });

    const createReview = async (name: string, stableId: string, key: string) => {
      const response = await t.fetch("/api/v1/reviews", {
        method: "POST",
        headers: headers(automation.token),
        body: JSON.stringify({ name, trace_ids: [stableId], idempotency_key: key }),
      });
      expect(response.status).toBe(200);
      return await t.run(async (ctx) => ctx.db.query("verdictReviewCampaigns").filter((q) => q.eq(q.field("name"), name)).unique());
    };

    const qualityCampaign = await createReview("Quality review", "quality-run", "quality-review");
    if (!qualityCampaign) throw new Error("quality campaign missing");
    const qualitySession = await guest.mutation(api.verdictReviewCampaigns.joinCampaign, { shareToken: qualityCampaign.shareToken, displayName: "Reviewer" });
    const trace = await guest.query(api.agentTraceReviewSessions.getTrace, { token: qualitySession.sessionToken });
    expect(trace.fullSpan).toMatchObject({ runQualification: "quality_eligible", canJudgeTaskSuccess: true });
    const projection = await guest.action(api.agentTraceReviewSessions.getFullSpanEvidence, { token: qualitySession.sessionToken });
    expect(projection).toMatchObject({ finalOutput: "Implemented and verified fictional widget arithmetic.", runQualification: "quality_eligible" });
    expect(projection?.events[projection.events.length - 1]).toMatchObject({ kind: "termination", reason: "completed" });
    expect(projection?.events.find((event) => event.kind === "tool_call")?.callId).toBe("operation-1");
    const serialized = JSON.stringify(projection);
    const rawSha = String(object(quality.raw).sha256);
    for (const hidden of ["analysis_metadata", "fictional-provider", "fictional-model", "harbor/pi", "agent/pi.txt", "call-1", "attempt-fixture", "raw_sha256", rawSha]) {
       expect(serialized).not.toContain(hidden);
     }
    const storedBoundaries = await t.run(async (ctx) => {
      const span = await ctx.db.query("fullSpanEvalRuns").withIndex("by_project_and_stable_id", (q) => q.eq("projectId", ids.project).eq("stableRunId", "quality-run")).unique();
      if (!span?.rawEvidenceStorageId || !span.reviewerProjectionStorageId) throw new Error("stored evidence expected");
      return {
        raw: await (await ctx.storage.get(span.rawEvidenceStorageId))!.text(),
        projection: await (await ctx.storage.get(span.reviewerProjectionStorageId))!.text(),
      };
    });
    expect(storedBoundaries.raw).toContain("analysis_metadata");
    expect(storedBoundaries.raw).toContain("fictional-provider");
    expect(storedBoundaries.projection).not.toContain("analysis_metadata");
    expect(storedBoundaries.projection).not.toContain("fictional-provider");
    await guest.mutation(api.agentTraceReviewSessions.setVerdict, { token: qualitySession.sessionToken, rating: "acceptable" });

    const fixtureCampaign = await createReview("Fixture review", "fixture-run", "fixture-review");
    if (!fixtureCampaign) throw new Error("fixture campaign missing");
    const fixtureSession = await guest.mutation(api.verdictReviewCampaigns.joinCampaign, { shareToken: fixtureCampaign.shareToken, displayName: "Reviewer" });
    const fixtureTrace = await guest.query(api.agentTraceReviewSessions.getTrace, { token: fixtureSession.sessionToken });
    expect(fixtureTrace.fullSpan).toMatchObject({ runQualification: "fixture_only", evidenceCompleteness: "complete", canJudgeTaskSuccess: false });
    await expect(guest.mutation(api.agentTraceReviewSessions.setVerdict, { token: fixtureSession.sessionToken, rating: "best" })).rejects.toThrow(/insufficient evidence|task-success/i);
    await guest.mutation(api.agentTraceReviewSessions.addComment, { token: fixtureSession.sessionToken, target: { kind: "trace" }, comment: "Useful fixture behavior, but not real quality evidence.", label: "thought" });
    await guest.mutation(api.agentTraceReviewSessions.setVerdict, { token: fixtureSession.sessionToken, rating: "insufficient_evidence", note: "Fixture only." });
  });
});
