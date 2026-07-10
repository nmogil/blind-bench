# Claude Code session preflight

Use this local preflight before uploading an internal Claude Code session transcript through the authenticated Trace Import screen.

```bash
npm run preflight:claude-code -- /path/to/session.jsonl
npm run preflight:claude-code -- /path/to/session.jsonl --json
# Machine-readable stdout without npm's command banner:
npm run --silent preflight:claude-code -- /path/to/session.jsonl --json
# Equivalent direct invocation:
npx tsx scripts/claude-code-session-preflight.ts /path/to/session.jsonl --json
```

The preflight is intentionally local-only:

- reads one `.jsonl` transcript from disk;
- reuses the existing `parseClaudeCodeSession` parser;
- does not import into Convex;
- does not call Cloudflare, Fireworks, model providers, or other network services;
- prints only a management-safe summary.

## What the summary includes

- safe trace/session reference suffixes;
- event and reviewable-step counts;
- malformed-line count and capped line numbers;
- model names;
- earliest/latest timestamps;
- privacy class and whether parser redaction occurred;
- step-kind counts;
- readiness status and caveats.

It deliberately does **not** print raw prompts, raw model outputs, raw tool results, credentials, account identifiers, or transcript content.

## Phase 0 dogfood loop

1. Pick an internal Claude Code session transcript from disk.
2. Run this preflight locally.
3. If `status: ready`, upload the same `.jsonl` through the authenticated Trace Import app surface.
4. Review the normalized trajectory in BlindBench.
5. Export approved review outputs through the existing Fireworks-ready handoff paths.

If the preflight reports `status: blocked`, pick another transcript or inspect the local source file outside BlindBench. Do not paste raw transcript content into GitHub issues, PRs, or public docs.
