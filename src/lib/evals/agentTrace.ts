/**
 * Agent run trace normalization — lab/CLI entry point.
 *
 * The implementation now lives in `./agentTrace.core` so the exact same code
 * runs inside the Convex bundle (which cannot import zod or node:*). This file
 * is a thin re-export for existing lab/CLI/test imports; add lab-only helpers
 * (e.g. zod validation of untrusted input) here, never in the shared core.
 */
export * from "./agentTrace.core";
