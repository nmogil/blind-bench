/**
 * Agent run trace normalization — Convex bundle entry point.
 *
 * Re-exports the shared isomorphic core (`src/lib/evals/agentTrace.core`), the
 * SAME implementation the lab/CLI uses. The core is deliberately zod-free and
 * node-free so it bundles cleanly here; this is the one place in `convex/` that
 * imports across the `../src` boundary, and it is safe precisely because the
 * core has no runtime-incompatible imports. Decided in #264 (M31) over the
 * "port, not import" pattern used by scorecardScoring.ts / cloudflareAiGateway.ts
 * — chosen to eliminate normalizer drift for the trajectory spine.
 */
export * from "../../src/lib/evals/agentTrace.core";
