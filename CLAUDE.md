# Blind Bench

Collaborative prompt engineering platform — "Git meets Google Docs" for prompts.
React + Vite + Convex + Tiptap, deployed on Vercel.

## Architecture & Specs

Read these before making changes:
- `project-docs/Blind Bench - Architecture.md` — system design, data model, auth model
- `project-docs/Blind Bench - UX Spec.md` — every screen, interaction, blind eval rules
- `project-docs/Blind Bench - Build Plan.md` — milestone definitions + acceptance criteria
- `project-docs/Blind Bench - Glossary.md` — locked vocabulary
- `project-docs/Blind Bench - Optimizer Meta-Prompt.md` — optimizer scaffolding

## Project Status

GH issues are the source of truth: `gh issue list --state all`
Each issue maps to a milestone (M0-M7) with acceptance criteria.

## Issue Workflow

```bash
gh issue edit <N> --add-label "in-progress"
git checkout -b issue-<N>-short-description
# ... work ...
git checkout main && git merge issue-<N>-short-description
gh issue close <N> --comment "Completed. <summary>"
gh issue edit <N> --remove-label "in-progress"
```

## Convex Conventions

- Every query/mutation/action starts with auth check via `getAuthUserId(ctx)` from `@convex-dev/auth/server`
- Role checks use helpers from `convex/lib/auth.ts`: `requireAuth`, `requireOrgRole`, `requireProjectRole`
- Async LLM pattern: mutation creates row + schedules action → action streams + calls internal mutations → client subscribes reactively via `useQuery`
- Internal functions use `internalMutation`/`internalAction` — never exposed to clients
- API keys never in query responses — `hasKey` returns boolean only
- Schema built incrementally — add tables per milestone

## Frontend Conventions

- UI primitives: shadcn/ui components in `src/components/ui/`
- Route components: `src/routes/` mirror URL structure
- Custom components: `src/components/` PascalCase
- Hooks: `src/hooks/` with `use` prefix
- Class merging: `cn()` from `src/lib/utils.ts`
- Loading: skeleton shimmers, never spinners (except auth redirect)
- Empty states: always actionable copy, never "No X found"
- Error messages: name the resource, give the next action, never "Something went wrong"

## Blind Eval Security Surface

- Evaluator functions return ONLY `{ blindLabel, outputContent, annotations }[]`
- No `data-version-id`, `data-run-id` attributes anywhere in DOM
- Eval routes use opaque tokens, never real IDs
- Test every change against the 13 rules in UX Spec Section 10

## Do Not

- Import Convex internal modules directly from frontend code
- Store API keys in client-accessible state or query responses
- Use `any` type — Convex schemas provide full type safety
- Add npm dependencies without checking existing coverage first
- Skip auth checks in Convex functions — even for queries
- Use red/green for diffs — use blue/purple (color-blind safe)

## Commands

```bash
npm run dev          # Start Vite dev server
npx convex dev       # Start Convex dev server (watches for changes)
npm run build        # Type-check + build for production
npx convex deploy    # Deploy Convex functions to production
```

### Pre-launch wipe (M25 no-backfill policy)

Wipe utilities in `convex/admin.ts` are gated by two server-side checks; see the JSDoc there for the full rationale.

1. In the Convex dashboard, set `WIPE_ENABLED=true` on the target deployment.
2. `npx convex run admin:wipeAll '{"confirm":"WIPE-YYYY-MM-DD"}'` — the date must be today's UTC date.
3. **Unset `WIPE_ENABLED` immediately after.** It is sticky; leaving it set leaves the gate open.

Claude Code denies these commands by default (`.claude/settings.json`); approve the prompt only when you genuinely intend to wipe.

## Environment Variables (Convex Dashboard)

- `GOOGLE_CLIENT_ID` — Google OAuth client ID
- `GOOGLE_CLIENT_SECRET` — Google OAuth client secret
- `RESEND_API_KEY` — Resend API key for magic link emails
- `OPENROUTER_KEY_ENCRYPTION_SECRET` — AES-GCM key for BYOK encryption (M3)
- `OPTIMIZER_META_PROMPT` — Override for optimizer prompt (M5, optional)
- `OPTIMIZER_META_PROMPT_VERSION` — Version tag for optimizer prompt (M5)

## Landing Page Design Context

See `.impeccable.md` for full design context. Key points:

- **Visual direction:** Scientific elegance — Linear.app-inspired. Clean, precise, restrained.
- **Brand personality:** Rigorous. Direct. Precise.
- **Primary emotion:** "I need this" — pain recognition then solution.
- **Color:** OKLch blue-purple primary. Monochromatic grays. Color for emphasis only.
- **Typography:** Geist Variable, hierarchy through weight/size, tight tracking on display.
- **Anti-references:** Playful SaaS, gradient-heavy Web3, cartoon illustrations, generic AI particles.
- **Constraints:** Astro static, < 100KB, Lighthouse > 90, WCAG AA, `prefers-reduced-motion`.

<!-- convex-ai-start -->
This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read `convex/_generated/ai/guidelines.md` first** for important guidelines on how to correctly use Convex APIs and patterns. The file contains rules that override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running `npx convex ai-files install`.
<!-- convex-ai-end -->
