import * as Sentry from "@sentry/browser";

let initialized = false;

/**
 * Conservative, error-only Sentry init for the Astro landing site.
 *
 * - No-op when `PUBLIC_SENTRY_DSN` is unset (Astro only exposes PUBLIC_-prefixed
 *   vars to the client bundle).
 * - Tracing disabled (`tracesSampleRate: 0`); no Replay instrumentation.
 * - `beforeSend` strips request headers/cookies/body and the user object to
 *   reduce PII risk.
 */
export function initSentry(): void {
  if (initialized) return;
  const dsn = import.meta.env.PUBLIC_SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeSend(event) {
      delete event.user;
      if (event.request) {
        delete event.request.cookies;
        delete event.request.headers;
        delete event.request.data;
      }
      return event;
    },
  });
  initialized = true;
}
