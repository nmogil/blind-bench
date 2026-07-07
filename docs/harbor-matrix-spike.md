# Harbor matrix integration spike (M31.5 / #268)

**Status: EXECUTED 2026-07-07.** Ran a real 3-combo matrix on Daytona, converted
the trajectories, imported them through the M31 spine, and proved they're
blind-reviewable side-by-side. Real cost numbers below — nothing here is a
placeholder.

## 1. Aim

Run the **same task across N model+harness combos**, import all trajectories
through the spine, and **blind-review them side-by-side** — proving "model+harness
combo" is a reviewable unit. Harbor is an **integration only**: we orchestrate
`harbor run` and import its output; we build **zero** sandbox infra (permanent
non-goal — in-house execution is the "second product" trap).

## 2. What was run

- **Task:** `terminal-bench@2.0` / `fix-git` (difficulty easy, version-control).
- **Provider:** Daytona sandboxes (`--env daytona`).
- **Harness:** Claude Code, three models. Same task pinned across all three via
  `-i fix-git -l 1` (deterministic single task).
- **Commands** (each ~45–90s wall-clock):
  ```
  harbor run -d terminal-bench@2.0 -i fix-git -l 1 -a claude-code \
    -m anthropic/claude-opus-4-1   -e daytona --env-file ~/.harbor.env -o ~/harbor-jobs/opus   -y
  harbor run -d terminal-bench@2.0 -i fix-git -l 1 -a claude-code \
    -m anthropic/claude-sonnet-4-5 -e daytona --env-file ~/.harbor.env -o ~/harbor-jobs/sonnet -y
  harbor run -d terminal-bench@2.0 -i fix-git -l 1 -a claude-code \
    -m anthropic/claude-haiku-4-5  -e daytona --env-file ~/.harbor.env -o ~/harbor-jobs/haiku  -y
  ```

## 3. Results — real numbers

| Combo | Model | Cost (USD) | Wall-clock | Tokens (in/out) | `fix-git` solved? | CC steps |
|---|---|---|---|---|---|---|
| Claude Code × Opus | claude-opus-4-1 | **$0.2279** | 87s | 166,455 / 3,000 | ✅ reward 1.0 | 26 |
| Claude Code × Sonnet | claude-sonnet-4-5 | $0.0844 | 45s | 117,000 / 818 | ❌ **reward 0.0** | 24 |
| Claude Code × Haiku | claude-haiku-4-5 | **$0.0405** | 44s | 190,612 / 1,635 | ✅ reward 1.0 | 32 |

**Total spend: ~$0.35** for the 3 runs. **Cost spread: 5.6×** (Haiku → Opus).

**The headline finding is non-monotonic:** the *mid-tier* combo (Sonnet) **failed
the task**, while the *cheapest* (Haiku) and *priciest* (Opus) both solved it. Cost
and success did not track model tier. This is exactly the "the combo is the unit,
not the model" point (Harness-Bench, arXiv 2605.27922) — and a genuinely good
blind-review case: **one failed trajectory against two successful ones, same task,
provenance hidden.** A reviewer judging "which approach is better" without knowing
which model produced it is the product in miniature.

## 4. Format mapping (verified against real output)

Harbor's claude-code agent writes, per trial (`<jobs>/<ts>/<trial>/`):

| Harbor output file | Content | Used? |
|---|---|---|
| `agent/sessions/projects/<slug>/<uuid>.jsonl` | **the real Claude Code session transcript** | ✅ — fed straight to the M31.2 parser (`parseClaudeCodeSession`); **zero new parser** |
| `agent/trajectory.json` | Harbor's own normalized format `{schema_version, session_id, agent, steps, final_metrics}` | alt path, not needed given the CC session |
| `result.json` (run + trial) | `stats.cost_usd`, `stats.n_input/output_tokens`, `stats.evals[…].reward_stats` | ✅ — combo cost/reward overlay |

**Key result: the converter is trivial because Harbor runs the *real* agent.** A
claude-code trajectory *is* a Claude Code session, which #265 already parses.
`scripts/harbor-import.ts` walks the jobs dir, parses each combo's CC session, and
overlays `{model, cost_usd, reward, task}` from `result.json`. Verified: it parsed
24–32 steps per real session. Codex CLI / OpenHands adapters remain TODO (each
would need its own native-transcript adapter — a few hours, not days).

## 5. Pipeline proof

`convex/tests/harborMatrix.test.ts` uses the three **real** converted trajectories
(trimmed fixtures in `convex/tests/fixtures/harbor-{opus,sonnet,haiku}.json`) and
proves the full path: all three `persistTrace` into the spine → a blind reviewer
discovers all three with **provenance stripped** (no model/harness) → the
Opus-vs-Sonnet A/B matchup is created and decided with **no provenance in the
payload**. So "≥3 combos of the same task, blind-reviewable side-by-side" holds at
the data layer; the browser side-by-side is the same surface M31.4/M31.6 ship.

## 6. Operational pain points (recorded)

1. **`daytona` extra is not in the base package.** `pip install harbor` / `uv tool
   install harbor` omits it → `MissingExtraError: 'daytona' package required` at
   trial init (before any sandbox spins up — **caught at zero cost**). Fix:
   `uv tool install 'harbor[daytona]'` (or `harbor[cloud]`). *Document this in any
   onboarding.*
2. **Two credentials per run:** `DAYTONA_API_KEY` (sandbox) + `ANTHROPIC_API_KEY`
   (the agent's model calls). Both via `--env-file`. BYOK holds — we never hold
   the customer's keys; here they were the operator's.
3. **Deterministic single task:** `-i <task> -l 1` pins the same task across
   combos (confirmed via `--print-config` before spending).
4. **Model ids:** `anthropic/claude-{opus-4-1,sonnet-4-5,haiku-4-5}` all resolved
   against a standard Anthropic key. No surprises.
5. **Speed:** runs are fast (~45–90s for an easy task) and cheap; a 3-combo matrix
   is a coffee-break operation, not a batch job.

## 7. Go / no-go recommendation

**Lean GO on a *thin* integration; the spike cleared its kill signals.**

- **GO signals hit:** 3 combos imported cleanly with **zero converter effort**
  (reused #265); per-combo cost is trivial (~$0.12 avg on an easy task); the
  blind side-by-side is genuinely informative (the Sonnet failure vs. two
  successes is a real judgment case, not a synthetic one).
- **What a productized version needs (small):** a "launch matrix" UI that shells
  `harbor run` for N combos on one task → auto-imports via `harbor-import.ts` →
  drops the reviewer into a matchup. That's orchestration + the existing spine,
  **no new infra**.
- **NO-GO / defer signals — none triggered**, but watch: converter churn if we add
  Codex/OpenHands (per-harness native formats); cost on *hard* tasks (this was
  easy — a hard task could be 10–50× the tokens); and whether reviewers actually
  prefer matrix review over single-trace review at scale.
- **Permanent non-goal upheld:** we ran Harbor and imported. We built no sandbox
  runner, queue, or execution service. If productized, the product stays
  "orchestrate Harbor + import + review," never our own runner.

## 8. Artifacts

- `scripts/harbor-import.ts` — Harbor jobs dir → `AgentRunTrace` JSON (reuses the
  #265 CC parser; `--selfcheck` passes; verified on real output).
- `convex/tests/harborMatrix.test.ts` + `convex/tests/fixtures/harbor-*.json` —
  the three real trajectories, proving import + blind review + matchup.
- This document: real cost/reward table, verified format mapping, pain points,
  go/no-go.
