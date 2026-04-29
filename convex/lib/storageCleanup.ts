import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

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
