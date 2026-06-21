# Observability & Events

Three tools, three jobs. Keep them separate.

| Tool | Job | Where |
| --- | --- | --- |
| **PostHog** | GTM + product funnel (acquisition → activation → usage). Source of truth for "what did users do." | App: `src/lib/posthog.ts` + `src/lib/analytics.ts`. Landing: inline snippet in `Base.astro` + `landing/src/lib/analytics.ts`. |
| **Sentry** | Product health: errors and `product` breadcrumbs for triage. **Not** a funnel — `tracesSampleRate: 0` in both app and landing, no replay. | App: `src/lib/sentry.ts`. Landing: `landing/src/lib/sentry.ts`. |
| **Vercel Analytics** | Traffic + web vitals (page views, Core Web Vitals). Zero-config, no custom events. | Landing: `<Analytics />` in `Base.astro`. |

Every product event goes through the `track()` / `trackLandingEvent()` wrappers, which fire PostHog **and** drop a matching Sentry breadcrumb. Don't call `posthog.capture` directly.

## Privacy rules (non-negotiable)

Props must be closed and low-cardinality. **Never** put any of these in an event:

- Raw Convex IDs (`sessionId`, run/result/output IDs, etc.)
- Prompt text, model outputs, annotation comments, or any free-form user input
- Emails, names, API keys
- URLs containing invite tokens or other opaque secrets

Allowed: booleans, counts, and closed enums — `scope`, `role`, `phase`, `outputCount`, `matchupCount`, `reasonTagCount`, `selectedWinner`, `guestAllowed`, `blindMode`, `target`, `source`, etc. The TypeScript schemas in the two `analytics.ts` files enforce this at the call site; if you need a new field, add it to the schema first.

## Naming conventions

- Event names: `snake_case`, `noun_verb` past tense for completed actions (`review_session_completed`), `noun_noun` for surfaces (`invite_landing_viewed`).
- Prop keys: `camelCase`.
- One closed schema per surface (`ProductEventProps` in the app, `LandingEventProps` on the landing). Adding an event = adding a key to the interface.

## Initial event list

### App (`src/lib/analytics.ts`)

| Event | Fired from | Key props |
| --- | --- | --- |
| `review_session_started` | `SessionDeck` (once per session load) | `scope`, `role`, `outputCount`, `requirePhase1`, `requirePhase2` |
| `review_phase1_submitted` | `SessionDeck` | `scope`, `role`, `outputCount`, `matchupCount`, `advancedTo` |
| `review_phase2_matchup_recorded` | `SessionDeck` | `scope`, `role`, `selectedWinner`, `reasonTagCount` |
| `review_session_completed` | `SessionDeck` | `scope`, `role`, `outputCount` |
| `invite_landing_viewed` | `InviteLanding` (once per resolved invite) | `scope`, `role`, `guestAllowed`, `status`, `blindMode` |
| `next_action_clicked` | `NextActionRing` | `target` |
| `copilot_panel_opened` | `CopilotPanel` (expand from collapsed) | `source` |

### Landing (`landing/src/lib/analytics.ts`)

| Event | Fired from | Key props |
| --- | --- | --- |
| `hero_cta_click` | `Hero.astro` | `ctaLabel`, `rotatorPersona` |
