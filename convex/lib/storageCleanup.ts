import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { isStorageIdReferencedBySnapshots } from "./inputSnapshot";

/**
 * Idempotent ctx.storage.delete — swallows "not found" errors so cascade
 * deletes don't blow up on already-deleted blobs (re-runs, partial prior
 * cleanup, etc). Anything else propagates.
 */
export async function safeDeleteStorage(
  ctx: MutationCtx,
  storageId: Id<"_storage">,
): Promise<void> {
  try {
    await ctx.storage.delete(storageId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found|does not exist|no such/i.test(msg)) return;
    throw err;
  }
}

/**
 * #188: Delete a test-case image blob unless a past run's `inputSnapshot`
 * still references it. Snapshots freeze "what we sent", so editing or deleting
 * a test case must not garbage-collect a blob that a completed run's history
 * depends on. When still referenced, we keep the blob (it is retained for the
 * life of the referencing run(s)).
 *
 * ponytail: scans every promptRuns row in the project per blob delete, scoped
 * via the `by_project_and_status` index prefix (projectId only). Fine at
 * current volumes; if run counts per project grow large, add a dedicated
 * reverse index (storageId → runs) or a snapshot-blob table to avoid the scan.
 */
export async function safeDeleteTestCaseBlob(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  storageId: Id<"_storage">,
): Promise<void> {
  const runs = await ctx.db
    .query("promptRuns")
    .withIndex("by_project_and_status", (q) => q.eq("projectId", projectId))
    .collect();
  if (isStorageIdReferencedBySnapshots(runs, storageId)) return;
  await safeDeleteStorage(ctx, storageId);
}
