import * as Sentry from "@sentry/browser";

let initialized = false;

/**
 * Conservative, error-only Sentry init for the Astro landing site.
 *
 * - No-op when `PUBLIC_SENTRY_DSN` is unset (Astro only exposes PUBLIC_-prefixed
 *   vars to the client bundle).
 * - Tracing disabled (`tracesSampleRate: 0`); no Replay instrumentation.
 * - `ignoreErrors`/`denyUrls` drop noise from visitors' browser extensions
 *   (e.g. `runtime.sendMessage` rejections) that never originates in our code.
 * - `beforeSend` strips request headers/cookies/body and the user object to
 *   reduce PII risk.
 */

/**
 * Error messages thrown by browser extensions injected into the page, surfaced
 * via `onunhandledrejection`. These are not our bugs — a visitor's extension is.
 */
const EXTENSION_NOISE = [
  // WebExtensions messaging errors (chrome.runtime / browser.runtime)
  /runtime\.sendMessage/i,
  /Tab not found/i,
  /Extension context invalidated/i,
  /message channel closed/i,
  /Could not establish connection\. Receiving end does not exist/i,
];

export function initSentry(): void {
  if (initialized) return;
  const dsn = import.meta.env.PUBLIC_SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    tracesSampleRate: 0,
    sendDefaultPii: false,
    ignoreErrors: EXTENSION_NOISE,
    denyUrls: [
      /^chrome-extension:\/\//,
      /^moz-extension:\/\//,
      /^safari-(web-)?extension:\/\//,
    ],
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
