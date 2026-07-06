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
 * Resolve the variable inputs to dispatch for a run. When a snapshot exists it
 * is authoritative for BOTH text and images — a snapshot without `images`
 * means "no image variables were bound at dispatch", so we must not fall back
 * to the live test case's attachments (that would dispatch images added after
 * run creation). Live fallback applies only to pre-#188 runs with no snapshot.
 */
export function resolveDispatchInputs(args: {
  snapshot?: InputSnapshot | null;
  testCase?: {
    variableValues: Record<string, string>;
    variableAttachments?: Record<string, Id<"_storage">>;
  } | null;
  inlineVariables?: Record<string, string>;
}): {
  variableValues: Record<string, string>;
  variableAttachments: Record<string, Id<"_storage">>;
} {
  if (args.snapshot) {
    return {
      variableValues: args.snapshot.text,
      variableAttachments: args.snapshot.images ?? {},
    };
  }
  return {
    variableValues:
      args.testCase?.variableValues ?? args.inlineVariables ?? {},
    variableAttachments: args.testCase?.variableAttachments ?? {},
  };
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
