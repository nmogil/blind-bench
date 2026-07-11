# Mogil Harbor/Pi full-span evidence ingest

This endpoint consumes the artifact produced by Mogil Bench's authoritative `HarborEvidence` Pydantic model (`mogil_bench/evidence.py`). BlindBench does not import Mogil Bench at runtime; a sanitized Pydantic-generated fixture is pinned at `convex/tests/fixtures/mogil-harbor-evidence-v1.json`.

## Endpoint, auth, and envelope

```http
POST https://{deployment}.convex.site/ingest/v1/eval-runs
Authorization: Bearer {project Automation token}
Content-Type: application/json
```

The token must include `traces:write`. This is a server-to-server bearer-token endpoint and does not advertise browser CORS.

The body is exactly one bounded batch envelope:

```json
{
  "runs": [
    { "schema": "mogil.harbor-evidence", "version": "1.0", "...": "artifact" }
  ]
}
```

- 1–50 runs per request.
- 8 MiB hard request limit, enforced while streaming the body.
- Unknown envelope or artifact fields are rejected.
- Every member is validated before any member is reserved. A malformed batch writes nothing.

A successful response is the producer's complete-count contract:

```json
{ "complete": 3, "imported": 3, "deduped": 0, "invalid": 0 }
```

For success, `complete === imported + deduped === runs.length` and `invalid === 0`. Validation errors return counts identifying valid versus invalid intended members without importing any. Stable-ID/attempt conflicts return HTTP 409 with `complete: 0`; they never masquerade as a complete batch.

## Artifact shape

Each `runs[]` member has exactly these top-level fields:

```json
{
  "schema": "mogil.harbor-evidence",
  "version": "1.0",
  "run": {
    "id": "stable logical run id",
    "attempt": "unique attempt id",
    "started_at": "2026-07-11T00:00:00Z",
    "ended_at": "2026-07-11T00:01:00Z",
    "status": "quality_eligible | fixture_complete | insufficient",
    "termination_reason": "completed"
  },
  "harness": { "name": "harbor/pi", "schema": "0.18.0" },
  "raw": { "path": "agent/pi.txt", "sha256": "64 lowercase hex characters" },
  "usage": {
    "input_tokens": 0,
    "output_tokens": 0,
    "cache_read_tokens": 0,
    "cache_write_tokens": 0,
    "total_tokens": 0,
    "cost_usd": 0
  },
  "outcomes": {
    "process": "succeeded",
    "verifier": "passed",
    "infrastructure": "succeeded",
    "evidence_completeness": "complete"
  },
  "rewards": { "reward": 1, "command_exit": 1, "stdout_assertion": 1 },
  "analysis_metadata": { "provider": "private", "model": "private" },
  "reviewer": {
    "task": { "id": "task", "revision": "1", "privacy_class": "internal", "prompt": "Reviewer-safe prompt" },
    "environment_class": "docker",
    "harness_schema": "harbor/pi-jsonl@0.18.0",
    "events": [],
    "outcomes": {},
    "rewards": {},
    "evidence": {}
  }
}
```

`reviewer.outcomes` and `reviewer.rewards` have the same strict shapes as their top-level counterparts and must agree with them.

### Canonical events

Each event has a stable `evt-{32 lowercase hex}` ID, contiguous zero-based `sequence`, one canonical kind, and an optional producer-canonical UTC ISO-8601 `timestamp` ending in `+00:00`.

- Message, `final_output`, and `termination`: `content`; producer `stop_reason` is accepted only on assistant reasoning/messages/final output and is omitted from the reviewer projection
- `tool_call`: `call_id`, `tool_name`, `arguments`
- `tool_result` / `tool_error`: `call_id`, `tool_name`, `result`

Every call must have exactly one later result/error. Event IDs must be unique, available timestamps chronological, one final output must exist, and termination must be last. Termination `content` must match `run.termination_reason`.

### Reviewer evidence

`reviewer.evidence` contains:

- `changed_files[]` plus `changed_files_reference`
- bounded `patch`, truncation flag, and `patch_reference`
- verifier command summary, exit code, timeout, bounded stdout/stderr and truncation flags
- verifier references for stdout, stderr, verification JSON, and reward JSON

Reviewer-inline references use safe relative paths and require both lowercase 64-hex fields: private `sha256` for the immutable raw artifact and `reviewer_sha256` for the exact UTF-8 sanitized inline value. BlindBench verifies changed-files canonical JSON, patch, stdout, and stderr against `reviewer_sha256` on every upload, including truncated/redacted previews; redaction markers never bypass binding. Raw `sha256` and paths remain private.

## Eligibility semantics

BlindBench derives eligibility; the sender's status alone is never authoritative.

A real task-success verdict requires all of:

- producer status `quality_eligible`
- complete linked tool activity including meaningful workspace-changing execution
- final output and successful termination
- nonempty changed-file manifest and patch
- process/infrastructure success
- verifier pass with exit 0, no timeout, and retained logs
- consistent all-one reward dimensions
- complete required references and valid/bound hashes

Contradictory `quality_eligible` or `fixture_complete` artifacts are rejected. `fixture_complete` remains inspectable but is explicitly fixture-only and can only receive qualitative feedback plus `insufficient_evidence`, never a real task-success verdict. Minimal final-output/termination evidence remains insufficient.

## Idempotency, cleanup, and storage

`run.id` and `run.attempt` are unique within the token's project. Exact same-fingerprint retries dedupe. Different evidence under either identity conflicts.

Reservations carry an ownership lease that is renewed before each run and throughout storage/step phases. Each newly reserved member is stored as `staged`; neither its full-span row nor trace is published as `ready` until one atomic batch commit validates every staged `(run, lease)` pair. If any member fails, every non-deduped reservation created by that request is cascade-cleaned—including earlier staged traces, steps, final/step blobs, private raw blobs, and reviewer projection blobs—while pre-existing deduped rows remain untouched. The same fingerprint can then retry cleanly. New ingests and the hourly cleanup job reap only failed work or pending/staged work whose renewed lease has actually expired.

Internal trace IDs are namespaced as `full-span:{run.id}`. Review creation resolves full-span runs through `fullSpanEvalRuns.stableRunId`; it does not share the legacy/native/OTLP trace-ID namespace.

The exact producer artifact—including `analysis_metadata`, raw reference, and private harness metadata—is retained only in a private raw storage blob. The separately serialized reviewer projection omits private metadata, raw path/hash, original event/call/source/session IDs, model/provider/harness provenance, credentials, canaries, and absolute host paths. The complete serialized projection is checked against the leakage policy before storage.
