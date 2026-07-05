import type { Id } from "../_generated/dataModel";

/**
 * #188: The frozen inputs dispatched with a run. `text` holds the resolved
 * text-variable values; `images` maps image-variable name → the _storage blob
 * that was sent. Mirrors the `promptRuns.inputSnapshot` schema shape.
 */
export type InputSnapshot = {
  text: Record<string, string>;
  images?: Record<string, Id<"_storage">>;
};

/**
 * Build the snapshot to freeze onto a run at dispatch time.
 *
 * - Quick runs (no test case) snapshot the inline variables as `text`.
 * - Test-case runs snapshot `variableValues` as `text` and any
 *   `variableAttachments` (image variables) as `images`.
 *
 * The returned object is a shallow copy so later edits to the source test case
 * can never mutate the frozen snapshot.
 */
export function buildInputSnapshot(args: {
  inlineVariables?: Record<string, string>;
  testCase?: {
    variableValues: Record<string, string>;
    variableAttachments?: Record<string, Id<"_storage">>;
  } | null;
}): InputSnapshot {
  if (args.inlineVariables) {
    return { text: { ...args.inlineVariables } };
  }
  const tc = args.testCase;
  const text = { ...(tc?.variableValues ?? {}) };
  const images = tc?.variableAttachments;
  if (images && Object.keys(images).length > 0) {
    return { text, images: { ...images } };
  }
  return { text };
}

/**
 * Pure blob-retention predicate: is `storageId` referenced by the
 * `inputSnapshot.images` of any of the given runs? Used to decide whether a
 * test-case blob is safe to delete when the test case is edited or removed —
 * blobs still referenced by a past run's snapshot must survive so the run's
 * "what we sent" history stays intact.
 */
export function isStorageIdReferencedBySnapshots(
  runs: ReadonlyArray<{ inputSnapshot?: InputSnapshot | null }>,
  storageId: Id<"_storage">,
): boolean {
  for (const run of runs) {
    const images = run.inputSnapshot?.images;
    if (!images) continue;
    for (const id of Object.values(images)) {
      if (id === storageId) return true;
    }
  }
  return false;
}
