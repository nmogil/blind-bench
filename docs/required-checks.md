# Required main-branch checks

The pull-request workflow in `.github/workflows/required-checks.yml` runs the release checks that do not require customer credentials:

- `npm run build`
- `npm run test:evals`
- `npm run test:convex`
- `npm run test:ct` in Chromium

Run all four locally with `npm run test:all` after Convex generated types are available. CI generates offline Convex type stubs because it does not connect to a deployment.

Repository administrators should require both workflow jobs before merging to `main`:

- **Required checks / build-and-tests**
- **Required checks / browser-components**

These checks cover parsing, persistence, blind projection/session boundaries, independent decisions, export exclusions, and browser component behavior. They do **not** prove a deployed authenticated two-account journey.

Before claiming customer production readiness, also run a deployed browser E2E with synthetic data across two principals:

1. owner imports CSV, OTLP, Pi, and Claude Code fixtures;
2. blind reviewer opens only an opaque session URL and submits a verdict/comment and matchup decision;
3. owner reveals provenance and generates reuse/export artifacts;
4. browser network payloads and DOM are inspected against the 13 blind-eval rules.

Until that deployed check and real external approval records are present, `readiness:customer-testing` must remain blocked and a green CI run must not be described as customer-production approval.
