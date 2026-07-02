# Preview typecheck builds (no Convex deploy key)

## The problem

Vercel runs `npm run build:deploy` for **both** production and preview
(PR) environments. That script used to start with `npx convex deploy`, but
`CONVEX_DEPLOY_KEY` is scoped to Production only. So every preview build died
in ~5s at `convex deploy` ("no Convex deployment configuration found") —
**before either TypeScript gate ran**. PRs therefore carried no type signal:
the June 26–July 2, 2026 production outage (25 type errors — 18 from the
convex-side typecheck, 7 from `tsc -b`) was mergeable behind green-looking
checks and went a week undetected.

## What the stub build does

`scripts/vercel-build.mjs` is the build entrypoint (`build:deploy`):

- **Deploy key present** (production, or preview if a Convex Pro preview key
  is added later): behaves exactly as before — `npx convex deploy && tsc -b &&
  vite build`.
- **No deploy key** (preview today): prints a note, runs
  `scripts/generate-convex-stubs.mjs` to reconstruct `convex/_generated`, then
  runs **both** type gates (`tsc -p convex` — what `convex deploy` would have
  typechecked — and `tsc -b`) plus `vite build`.

The generated stubs are deterministic (module list walked from `convex/`,
sorted) and reproduced Vercel's `convex deploy` typecheck output byte-for-byte
on 2026-07-02.

## Skip-if-exists guarantee

`generate-convex-stubs.mjs` exits immediately without writing anything if
`convex/_generated/api.d.ts` already exists. Real codegen — locally, or after
a genuine `convex deploy` — is never clobbered. Production behavior is
unchanged.

## Local use

On a machine with no Convex deployment, run:

```bash
node scripts/generate-convex-stubs.mjs
```

to unblock `tsc -b`, `npm run test:convex`, and `npm run test:evals` without
needing a live backend. (`convex/_generated` is gitignored; the stubs are
never committed.)

## Upgrade path: real isolated preview deployments

Previews auto-upgrade to real Convex preview deployments — no code change — as
soon as a preview deploy key exists:

1. Mint a Convex **preview** deploy key: Convex dashboard → project Settings →
   URL & Deploy Keys (requires Convex Pro).
2. `vercel env add CONVEX_DEPLOY_KEY preview`.

`scripts/vercel-build.mjs` then takes the deploy branch for previews too.

Until then, note that a preview URL is a **CI artifact, not a usable app**:
the bundle is built against the stub `api` at runtime and previews have no
`VITE_CONVEX_URL`. The value of the preview build is the type signal, not a
clickable deployment.
