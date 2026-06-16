# Blind Bench

Collaborative prompt engineering, structured around blind human evaluation. Think Git meets Google Docs, but for prompts.

## How it works

1. Write a prompt with variables.
2. Run it against a test case (3x by default).
3. Collaborators review the outputs blind, with no version or run IDs visible, and leave feedback.
4. The optimizer rewrites the prompt using the collected feedback.
5. Repeat.

## Stack

React + Vite, Convex backend, Tiptap editor, Tailwind + shadcn/ui, deployed on Vercel. Auth via Convex Auth (Google OAuth + Resend magic links). LLM calls go through OpenRouter using BYOK keys, encrypted with AES-GCM in Convex.

## Local development

```bash
npm install
npm run dev          # Vite dev server
npx convex dev       # Convex backend (run in a second terminal)
```

Build for production with `npm run build`. To deploy Convex functions and build the frontend together, use `npm run build:deploy`.

## Required env vars (Convex dashboard)

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — Google OAuth
- `RESEND_API_KEY` — magic link emails
- `OPENROUTER_KEY_ENCRYPTION_SECRET` — encrypts user-supplied OpenRouter keys

## Client/build env vars (Vercel)

These are read at build time by Vite (root app) / Astro (`landing/`):

- `VITE_CONVEX_URL` — Convex deployment URL (root app)
- `VITE_POSTHOG_KEY`, `VITE_POSTHOG_HOST` / `PUBLIC_POSTHOG_KEY`, `PUBLIC_POSTHOG_HOST` — PostHog analytics
- `VITE_SENTRY_DSN` (root app) / `PUBLIC_SENTRY_DSN` (`landing/`) — Sentry error monitoring. Optional; when unset, Sentry is a no-op. Error capture only — tracing and Replay are disabled, and request headers/cookies/body plus user data are stripped before send.

## Project docs

The real specs live in `project-docs/`:

- `Architecture.md` — data model, auth, BYOK key handling
- `UX Spec.md` — every screen and the 13 blind-eval rules
- `Build Plan.md` — milestones M0 through M7
- `Glossary.md` — locked vocabulary

GitHub issues track milestone progress: `gh issue list --state all`.

## Conventions

See `CLAUDE.md` for the full set. The short version: every Convex query and mutation runs an auth check, API keys never leave the server, blind-eval responses never leak version or run IDs, and diffs use blue/purple instead of red/green.
