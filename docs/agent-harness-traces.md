# Agent harness trace capture

Blind Bench needs to evaluate agentic Pennie workflows such as Jeeves / Pennie Systems AI, not only single chat-completion calls. This document defines the first normalized agent-run trace shape and the first concrete ingest path.

## First source path: Jeeves / Clog run export

The first supported input is a permissive JSON export from a Clog-managed Jeeves-style run:

```ts
normalizeJeevesClogRun(raw)
```

Expected fields are intentionally simple:

```json
{
  "run_id": "JEEVES-RUN-TEST-001",
  "product": "jeeves",
  "module": "systems_agent",
  "harness": { "name": "jeeves_clog", "version": "TEST-v1", "sdk": "clog" },
  "model": "claude-sonnet-4-0",
  "messages": [{ "role": "user", "content": "..." }],
  "steps": [
    { "type": "tool_call", "id": "tool-1", "name": "lookup_account", "args": {} },
    { "type": "tool_result", "id": "tool-1", "name": "lookup_account", "result": {} },
    { "type": "policy_event", "policy": "no_destructive_action", "action": "allow" }
  ],
  "final_answer": "...",
  "usage": { "cost_usd": 0.01, "duration_ms": 2100, "total_tokens": 900 }
}
```

No SDK integration is required yet. The capture path is intentionally export/import first.

## Normalized shape

`AgentRunTrace` captures:

- source trace/run IDs
- harness name/version/SDK
- product/module/environment/model
- ordered steps
- messages
- tool calls
- tool results
- policy events
- state snapshots
- final answer
- cost/latency/tokens
- privacy class and redaction notes

## Privacy and redaction

Tool arguments, tool results, and state snapshots may contain sensitive payloads. The normalizer creates both raw and redacted variants for sensitive step types.

Default reviewer/scorer projection uses:

```ts
toScorerVisibleAgentRun(trace, "blind_view")
```

This redacts keys matching sensitive categories such as:

- SSN / social
- phone
- email
- address
- token / secret / password
- account number
- card
- DOB

Internal view is explicit:

```ts
toScorerVisibleAgentRun(trace, "internal_view")
```

Only use internal view in controlled Pennie-scoped debugging. Blind/evaluator views should not expose raw tool payloads by default.

## Scorer-visible projection

Scorers should read the projected view, not the raw trace:

```ts
{
  trace_id,
  harness,
  product,
  model,
  messages,
  tool_calls: [{ tool_call_id, name, args, index }],
  tool_results: [{ tool_call_id, name, result, index }],
  policy_events: [{ policy, action, reason, index }],
  final_answer
}
```

This preserves enough evidence for:

- expected tool use
- forbidden tool use
- escalation / handoff behavior
- cross-context leakage checks
- policy event checks
- final answer quality review

## Eval-case seed

Agent runs can be turned into replay eval-case seeds:

```ts
agentTraceToEvalCase(trace)
```

The eval case stores messages and scorer-visible tool/policy context while keeping raw sensitive payloads out of the default review surface.

## Non-goals

- No LangGraph/LangSmith/Phoenix replacement.
- No sandboxed agent execution yet.
- No automatic capture from production Jeeves agents yet.
- No Pennie production data committed to the repo.
