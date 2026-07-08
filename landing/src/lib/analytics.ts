import * as Sentry from '@sentry/browser';

/**
 * Landing-site analytics. PostHog is the GTM funnel source of truth; Sentry
 * gets a parallel `product` breadcrumb for health/error triage. See
 * `docs/observability-events.md`.
 *
 * Props are closed and low-cardinality — never raw IDs, emails, or free-form
 * input. PostHog is loaded inline in Base.astro and exposed on `window`;
 * `addBreadcrumb` is a safe no-op when Sentry has no DSN.
 */

/** Closed schema: event name → its allowed props. */
export interface LandingEventProps {
  hero_cta_click: {
    ctaLabel: 'get_started' | 'see_how';
    rotatorPersona: 'engineers' | 'legal' | 'support' | 'PMs' | 'experts' | 'unknown';
  };
}

export type LandingEvent = keyof LandingEventProps;

export function trackLandingEvent<E extends LandingEvent>(
  event: E,
  props: LandingEventProps[E],
): void {
  window.posthog?.capture(event, props);
  Sentry.addBreadcrumb({
    category: 'product',
    level: 'info',
    message: event,
    data: props,
  });
}
