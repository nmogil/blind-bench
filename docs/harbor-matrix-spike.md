# Harbor matrix integration spike (M31.5 / #268)

**Status: PARTIAL — converter + plan built; the actual matrix run and its cost
numbers are PENDING sandbox credentials (Daytona or Modal).** This document is
honest about what was executed vs. what requires an account we don't have in the
build environment. Nothing below is a fabricated cost figure; the run table has
explicit `TBD (needs run)` cells to be filled by executing the plan in §4.

## 1. Aim (unchanged from the strategy doc)

Run **one task across N model+harness combos**, import all trajectories through
the M31.1 spine, and **blind-review them side-by-side** via M31.4. Prove that
"model+harness combo" is a reviewable unit — Harness-Bench (arXiv 2605.27922)
found ~32× cost variance for the same model across harnesses, so the combo is a
legitimate comparison unit and nobody pairs matrix execution with human
judgment.

**Hard boundary (Codex review, locked):** Harbor is an *integration*. We
orchestrate `harbor run` and import its output. We build **zero** sandbox
infra — no runner service, no queue, no sandbox management. In-house execution
is "the clearest path to becoming a second product." This spike's converter is
the only new code; everything else is scripts + this write-up.

## 2. What Harbor is (confirmed)

- Harbor (github.com/harbor-framework/harbor) is the Terminal-Bench team's
  official harness for Terminal-Bench 2.0. One CLI runs multiple agents across
  cloud sandbox providers.
- CLI shape (from the repo README):
  ```
  harbor run --dataset terminal-bench@2.0 \
             --agent claude-code \
             --model anthropic/claude-opus-4-1 \
             --n-concurrent 4 \
             --env <daytona|modal|e2b|…>
  ```
- Supported agents include **Claude Code, Codex CLI, OpenHands** ("and more").
- **Not yet confirmed (needs a real run or a cookbook read):** the exact output
  directory layout and per-trial trajectory schema. The README + landing docs
  don't specify it. Terminal-Bench lineage strongly implies a `runs/<run-id>/`
  tree with per-task/per-trial directories containing a `results.json` plus the
  agent's own logs. **Action to confirm on first run:** `harbor run … && find
  ./runs -maxdepth 3 -type f | head` and record the real layout in §3.

## 3. Format-mapping table (Harbor/agent output → `AgentRunTrace`)

The spine's interchange type is `AgentRunTrace` (`src/lib/evals/agentTrace.core.ts`),
steps = `message | tool_call | tool_result | state | policy_event`.

The load-bearing insight that shrinks this spike: **Harbor doesn't invent a
trajectory format — it runs the real agent, so each combo's trajectory is that
agent's NATIVE transcript.** So per agent:

| Harbor `--agent` | Native trajectory format | Converter |
|---|---|---|
| `claude-code` | Claude Code session `.jsonl` (the exact format M31.2 already parses) | **Reuse `parseClaudeCodeSession` / the #265 importer as-is.** Zero new parser. |
| `codex-cli` | Codex CLI session log (rollout JSONL / `~/.codex/sessions`) | TODO adapter — needs one real sample. Maps 1:1: user/assistant messages → `message`, `function_call`/`local_shell_call` → `tool_call`, their outputs → `tool_result`. |
| `openhands` | OpenHands event stream (`events/*.json`: `MessageAction`, `CmdRunAction`/`CmdOutputObservation`, `IPythonRunCellAction`, …) | TODO adapter — action→`tool_call`, observation→`tool_result`, agent message→`message`, `AgentDelegate*`→`policy_event`. |

Harbor **run metadata** (task id, agent, model, resolved sandbox, cost, duration)
wraps each trajectory and maps to the `AgentRunTrace` envelope:

| Harbor run field (expected) | `AgentRunTrace` field |
|---|---|
| task / dataset id | `product` or `metadata.task` |
| `--agent` | `harness.name` |
| `--model` | `model` |
| trial/run id | `run_id`, `trace_id` (`harbor-<runid>`) |
| reported cost (USD) | `usage.cost_usd` |
| wall-clock | `usage.duration_ms` |
| token totals | `usage.total_tokens` |
| sandbox provider | `environment` |

`scripts/harbor-import.ts` implements the `claude-code` row today (reusing the
verified CC parser) and stubs the other two with a clear error naming the
missing adapter.

## 4. Run plan (execute when Daytona/Modal creds are available)

Pick ONE scoped task — recommendation: a small, self-contained BlindBench issue
from this repo (e.g. a well-specified bugfix) turned into a Terminal-Bench-style
task, or an existing terminal-bench@2.0 task for zero task-authoring.

≥3 combos, one provider:
```
harbor run --dataset terminal-bench@2.0 --agent claude-code --model anthropic/claude-opus-4-1 --env daytona
harbor run --dataset terminal-bench@2.0 --agent claude-code --model anthropic/claude-sonnet-4-5 --env daytona
harbor run --dataset terminal-bench@2.0 --agent codex-cli   --model openai/gpt-5.4            --env daytona
```
Then, per produced trajectory:
```
npx tsx scripts/harbor-import.ts <runs-dir> --project <projectId> --out ./harbor-traces
# → writes one normalized AgentRunTrace JSON per combo; import via the spine
#   (importClaudeCodeSession for CC, or persistTrace for pre-normalized traces)
```
Finally, in the app: create an `agentTraceMatchups` pairing of two combos at
their divergence point and blind-review side-by-side (M31.4).

## 5. Findings table — **PENDING REAL RUN**

| Combo | Cost (USD) | Wall-clock | Trajectory steps | Imported? | Blind-reviewable? |
|---|---|---|---|---|---|
| claude-code × opus-4-1 | TBD (needs run) | TBD | TBD | — | — |
| claude-code × sonnet-4-5 | TBD (needs run) | TBD | TBD | — | — |
| codex-cli × gpt-5.4 | TBD (needs run) | TBD | TBD | — | — |

Operational pain points: **TBD** — to record after the run (auth/setup friction,
provider quota, output-format surprises vs. §3, converter gaps).

## 6. Go/no-go framework (decision criteria, not a pre-judged verdict)

Productize the matrix (build a "launch runs" product surface) **only if**, after
the run above:

- **GO signals:** ≥3 combos import cleanly and a reviewer completes a
  side-by-side blind pick that feels *more* informative than reviewing one
  trace; per-run cost is bounded enough to offer as a demo/service; converter
  effort per new harness is small (hours, not days).
- **NO-GO / defer signals:** converter churn per harness is high (formats drift
  fast); reviewers say the matrix adds nothing over single-trace review (the
  A-vs-D kill signal in the strategy doc); provider ops (quota, flakiness, cost)
  make even a manual demo painful.
- **Permanent non-goal regardless:** in-house sandbox execution. If GO, the
  product is still "orchestrate Harbor + import + review," never our own runner.

## 7. What this spike delivered without a run

- `scripts/harbor-import.ts` — Harbor run dir → normalized `AgentRunTrace`
  JSON, implementing the `claude-code` path by reusing the M31.2 parser; other
  agents stubbed with a named-adapter error.
- This document: confirmed CLI + agents, the format-mapping table, the exact run
  plan, and the go/no-go criteria — everything needed to execute in one sitting
  once creds exist.
- Honest gap: the trajectory-schema cells and all cost/wall-clock numbers
  require an actual `harbor run`, which needs a Daytona or Modal account this
  build environment does not have.
