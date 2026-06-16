import * as Sentry from "@sentry/react";

let initialized = false;

/**
 * Conservative, error-only Sentry init for the Vite React app.
 *
 * - No-op when `VITE_SENTRY_DSN` is unset (local dev, previews without the var).
 * - Tracing disabled (`tracesSampleRate: 0`); no Replay/Session instrumentation.
 * - `beforeSend` strips request headers/cookies/body and the user object to
 *   reduce PII and free-form prompt content leaking into events. Blind-eval
 *   routes already use opaque tokens, so the bare URL is retained for triage.
 */
export function initSentry(): void {
  if (initialized) return;
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
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

export { Sentry };
