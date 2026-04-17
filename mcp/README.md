# Blind Bench MCP server

Model Context Protocol server that lets agents (Claude Code, Cursor, custom
runtimes) author prompts, kick off comparison runs, create review cycles,
fetch human + agent feedback, and submit blind evaluations against a
Blind Bench project.

This package wraps the public `/api/v1/*` HTTP surface implemented in
`convex/http.ts`. There is no business logic here — every tool is a thin
client call. Update both this package and `convex/tests/api-contract.test.ts`
when the API shape changes.

## Install

```bash
cd mcp
npm install
npm run build
npm link   # or `npm install -g .`
```

## Get a service token

In the Blind Bench UI, open your project → Settings → Service tokens →
**Mint token**. Copy the plaintext (`bbst_live_…`) immediately — it is shown
only once.

Decide which scopes you need:

| Scope             | Allows                                  |
| ----------------- | --------------------------------------- |
| `runs:read`       | `get_run`                               |
| `runs:write`      | `create_version`, `start_run`           |
| `cycles:read`     | `get_cycle_feedback`                    |
| `cycles:write`    | `create_review_cycle`                   |
| `evaluator:read`  | `get_eval_task`                         |
| `evaluator:write` | `submit_evaluation`                     |

`actorRole` must be `editor` for write scopes; `evaluator` is read+submit only.

## Configure Claude Code

Add to `~/.config/claude-code/mcp.json` (global) or `.mcp.json` in your repo:

```json
{
  "mcpServers": {
    "blind-bench": {
      "command": "blind-bench-mcp",
      "env": {
        "BLINDBENCH_TOKEN": "bbst_live_…",
        "BLINDBENCH_API_BASE": "https://your-deployment.convex.site"
      }
    }
  }
}
```

`BLINDBENCH_API_BASE` is the Convex HTTP base for your deployment — it is the
URL of `convex/http.ts`, not your Vite frontend.

## Tools

| Tool                            | Maps to                            |
| ------------------------------- | ---------------------------------- |
| `blindbench_create_version`     | `POST /api/v1/versions`            |
| `blindbench_start_run`          | `POST /api/v1/runs`                |
| `blindbench_get_run`            | `GET /api/v1/runs/get`             |
| `blindbench_create_review_cycle`| `POST /api/v1/cycles`              |
| `blindbench_get_cycle_feedback` | `GET /api/v1/cycles/feedback`      |
| `blindbench_get_eval_task`      | `GET /api/v1/cycles/eval-task`     |
| `blindbench_submit_evaluation`  | `POST /api/v1/cycles/evaluations`  |

## Typical agent workflow

1. `blindbench_create_version` → returns `versionId`
2. `blindbench_start_run` with that `versionId` → returns `runId`
3. Poll `blindbench_get_run` until `status === "completed"`
4. `blindbench_create_review_cycle` with the run + a list of human evaluator
   user IDs (and/or your own agent token's user) → returns `cycleId`
5. Wait for evaluators (humans, agents using `blindbench_submit_evaluation`,
   or both) to weigh in
6. `blindbench_get_cycle_feedback` to read aggregated ratings + annotations,
   split by source and evaluator type

## Development

```bash
npm run dev   # tsx watch mode
npm run build # compile to dist/
```
