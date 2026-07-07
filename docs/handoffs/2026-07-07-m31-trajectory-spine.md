# Handoff: M31 Trajectory Spine kickoff (2026-07-07)

## Goal
Implement M31 per `project-docs/Blind Bench - Agent Trace Strategy.md`
(approved by Noah 2026-07-07) — issues #264–#268, starting with #264.

## State
- Done + verified: strategy doc, Build Plan M31 section, Positioning addendum
  committed as `4840c98` on local main; M31 milestone + issues #264–#268
  created; #130/#131/#133/#136/#209/#219 closed; #263/#261/#53 re-scoped via
  comments (verified via `gh issue list`).
- Not started: all implementation. Order: #264 (spine schema — gates the
  rest) → #265 (CC JSONL importer) ∥ #268 (Harbor spike) → #266 → #267.
- **Unpushed:** `4840c98` is local-only. Issue comments link the strategy doc
  path on GitHub — push first or the links 404.

## Next action
Push `4840c98` (Noah runs `git push origin main`, or via PR branch), then
`gh issue edit 264 --add-label "in-progress"` and start the schema on a
branch per CLAUDE.md workflow.

## Landmines
- Auto-mode permission classifier blocks: subagents closing GH issues,
  closing issues after a user "hold" without fresh explicit confirmation, and
  pushing to main. Ask Noah directly (AskUserQuestion) rather than retrying.
- Noah kept **#55 open** (deprioritized, not closed) — don't re-close it.
- #264 constraints: full trace must NEVER be one Convex doc (~1MiB cap);
  step bodies → file storage (`rawPayloadStorageId` pattern); paginated
  queries only. `src/lib/evals/agentTrace.ts` is the type source but is
  duplicated-by-design vs `convex/*` (zod-free runtime) — resolve for this
  module, see header comments in `convex/lib/scorecardScoring.ts`.
- Blind projection must be precomputed + enforced at the function boundary;
  copy frames trace blinding as bias reduction, NOT anonymity (Codex review,
  recorded in strategy doc).
- Noah's standing prefs: subagents on Opus for delegated work; Reviewr pane
  for manual review before handoff (a pane may still be open from this
  session, w5:p4).

## Verify
- `git log --oneline -1` → `4840c98 docs: agent trace strategy…` (passes)
- `gh issue list --milestone "M31 — Trajectory Spine"` → #264–#268 (passes)
- `git status --short` → clean except this handoff file
