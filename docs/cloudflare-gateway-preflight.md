# Cloudflare Gateway export preflight

Use this local preflight before pasting or uploading a customer-owned Cloudflare AI Gateway JSONL export through the authenticated Gateway Import screen.

```bash
npm run preflight:gateway -- /path/to/gateway-export.jsonl
npm run preflight:gateway -- /path/to/gateway-export.jsonl --sidecar /path/to/metadata-sidecar.json
npm run preflight:gateway -- /path/to/gateway-export.jsonl --json
```

The preflight is intentionally local-only:

- reads a JSONL export from disk;
- optionally reads a metadata sidecar from disk;
- reuses the existing `parseGatewayJsonl`, `parseSidecar`, and `summarizeTraces` parser path;
- does not import into Convex;
- does not call Cloudflare, Fireworks, model providers, or other network services;
- prints only a management-safe summary.

## What the summary includes

- parsed, invalid, and truncated counts;
- capped invalid line numbers;
- model and provider names;
- earliest/latest timestamps;
- redacted or missing request/response counts;
- sidecar entry and match counts when supplied;
- readiness status and caveats.

It deliberately does **not** print raw prompts, raw model outputs, raw tool results, invalid line content, sidecar values, account IDs, credentials, or trace content.

## Live Gateway import loop

1. Export logs from the customer's own Cloudflare AI Gateway account.
2. Run this preflight locally.
3. If `status: ready`, paste/upload the same JSONL through the authenticated Gateway Import app surface.
4. Materialize imported traces into eval cases when ready.
5. Run blind review, scorecards, and export handoff flows from inside BlindBench.

If the preflight reports `status: blocked`, choose a different export or inspect the local source file outside BlindBench. Do not paste raw Gateway log content into GitHub issues, PRs, or public docs.
