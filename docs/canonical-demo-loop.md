# Canonical demo loop — Claude Code trace → blind review → Fireworks-usable export

This is the dogfood path we run end to end: import an internal Claude Code
session, blind-review the agent's trajectory, and export a fine-tuning dataset
whose **manifest** makes it a trustworthy Fireworks handoff. It exercises the
whole flywheel as one continuous flow.

```
Claude Code JSONL import → blind trace review → verdict / comment / preference
  → export SFT / DPO dataset → inspect manifest/report for Fireworks compatibility
```

Nothing here calls Fireworks. The output is **JSONL + a manifest/report** you
hand to a fine-tuning job later; there is no training run in this loop.

## The loop, step by step

1. **Import a Claude Code session.** In-app: **Import an agent session**
   (`/orgs/{slug}/traces/import`). Upload or paste a Claude Code session
   `.jsonl` (`~/.claude/projects/…/*.jsonl`), pick a project. The page returns a
   **summary only** — step counts, models, time bounds — never session content.
   Re-importing the same session is idempotent (`deduped`).

   > Use an **internal** Claude Code trace. No customer or design-partner data.

2. **Blind-review the trajectory.** Open **Review imported traces**
   (`/eval/traces`). A reviewer sees the trace with no provider/harness
   provenance: ordered steps, tool calls, tool results, policy events, final
   answer — with sensitive tool payloads key-redacted. They:
   - **comment** on a step (`praise` / `concern` / …),
   - set a **verdict** on the trajectory (`best` / `acceptable` / `weak`),
   - and/or decide an **A/B matchup** between two trajectories of the same task
     aligned at their divergence step (the DPO-shaped preference signal).

3. **Export a dataset.** Open **Export training data**
   (`/orgs/{slug}/projects/{projectId}/export`). Pick:
   - **Source** — Agent trajectories (step-level) or Prompt outputs (best/weak).
   - **Format** — **SFT** (best-only chat) or **DPO** (preference pairs).

   Generate. You get the JSONL blob (1-hour download link) **and** a manifest.

4. **Inspect the manifest/report.** The export card renders the manifest inline
   (raw JSON in the collapsible). This is the Fireworks handoff report — see
   below for what to check.

## What counts as success

- **SFT** produces at least one `{ "messages": [{ role, content }, …] }` row.
- **DPO** produces `{ prompt, chosen, rejected, metadata }` rows **only** when
  comparable chosen/rejected pairs exist. If there are none, DPO output is
  **empty with an explicit note in the manifest** — never a silently empty file.
- The exported JSONL carries **real reviewed content** and **no provenance leak**
  (no `claude-opus`/harness/provider strings, no org names, emails, or API keys).
- The manifest reports counts, exclusions (by reason), the sensitivity gate,
  aggregate source/reviewer counts, and a schema/version stamp.

The Convex test `convex/tests/dogfoodFlow.test.ts` runs steps 1–4 on real
Harbor trajectory fixtures and asserts the DPO pair carries real content, the
SFT export is non-empty, and the manifest is present and Fireworks-shaped.

## The export manifest (Fireworks handoff report)

Every export ships an `ExportManifest`
(`convex/lib/trainingExport.ts` · `buildExportManifest`):

| Field | Meaning |
| --- | --- |
| `schema` / `version` | `"blindbench.training-export"` / `1` — the report contract. |
| `source` / `format` | `trajectory` \| `output_preference` / `dpo` \| `sft`. |
| `row_count` / `excluded_count` | Rows written / rows dropped by the gate. |
| `excluded_by_reason` | Breakdown: `prod_sensitive`, `pii_leak`, `empty`, `degenerate`. |
| `sensitivity_gate` | `allow_sensitive` + the default-deny classes (confidential/PII/PHI). |
| `source_units` / `reviewers` | Aggregate provenance — how much reviewed signal fed the export. **No raw trace/run ids** (anonymized by construction). |
| `fireworks` | `{ compatible, row_shape }`. |
| `notes` | Human-readable notes on DPO comparability and exclusions. |

## Fireworks compatibility expectations

- **SFT JSONL** is the OpenAI/Fireworks chat shape — one row per line,
  `{ "messages": [{ "role", "content" }, …] }`. Directly usable for
  chat-completion fine-tuning.
- **Tool-call compatibility.** Trajectory steps (tool calls, tool results,
  policy events) are rendered into the transcript text of a turn; the current
  SFT/DPO rows are text-only `messages`/`prompt`. Native `tool_calls` structured
  fields are **not** emitted yet — the native ingest schema
  ([`native-ingest.md`](./native-ingest.md)) preserves them upstream, so a future
  serializer can pass them through when needed.
- **DPO** only emits comparable pairs; degenerate (identical chosen/rejected)
  pairs are excluded, not written.
- **No training here.** This loop stops at "download JSONL + read manifest." Feed
  the JSONL to a Fireworks fine-tuning job out of band; use the manifest to
  document row counts, exclusions, and the sensitivity gate for that job.

## Related

- [`training-dataset-compiler.md`](./training-dataset-compiler.md) — the local,
  deterministic synthetic compiler (`npm run dataset:demo`) with its own manifest
  and train/validation/test splits. Same data-boundary posture, different (offline)
  source.
- [`agent-harness-traces.md`](./agent-harness-traces.md) — the normalized agent
  trace shape reviewers see.
- [`native-ingest.md`](./native-ingest.md) — the live push path (`/ingest/v1/traces`).
