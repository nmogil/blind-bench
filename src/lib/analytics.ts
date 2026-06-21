import { posthog } from "@/lib/posthog";
import { Sentry } from "@/lib/sentry";
import type { CopilotTarget } from "@/components/copilot/NextActionRing";

/**
 * Product + GTM analytics for the main app.
 *
 * PostHog is the funnel/activation source of truth; Sentry gets a parallel
 * `product` breadcrumb so health/error triage has the same context without a
 * second pipeline. See `docs/observability-events.md`.
 *
 * Props are deliberately closed and low-cardinality. Never pass raw Convex IDs,
 * prompt/output text, emails, API keys, tokenized URLs, or free-form user input
 * — only booleans, counts, and enums.
 */

type Scope = "run" | "cycle";

/** Closed schema: event name → its allowed props. */
export interface ProductEventProps {
  review_session_started: {
    scope: Scope;
    role: string;
    outputCount: number;
    requirePhase1: boolean;
    requirePhase2: boolean;
  };
  review_phase1_submitted: {
    scope: Scope;
    role: string;
    outputCount: number;
    matchupCount: number;
    advancedTo: "phase2" | "complete";
  };
  review_phase2_matchup_recorded: {
    scope: Scope;
    role: string;
    selectedWinner: "left" | "right" | "tie" | "skip";
    reasonTagCount: number;
  };
  review_session_completed: {
    scope: Scope;
    role: string;
    outputCount: number;
  };
  invite_landing_viewed: {
    scope: "org" | "project" | "cycle";
    role: string;
    guestAllowed: boolean;
    status: "pending" | "accepted" | "revoked" | "expired";
    blindMode: boolean | null;
  };
  next_action_clicked: {
    target: CopilotTarget;
  };
  copilot_panel_opened: {
    source: "expand";
  };
}

export type ProductEvent = keyof ProductEventProps;

export function track<E extends ProductEvent>(
  event: E,
  props: ProductEventProps[E],
): void {
  // No-op safely when PostHog never initialized (no key/host in this env).
  if (posthog.__loaded) {
    posthog.capture(event, props);
  }
  Sentry.addBreadcrumb({
    category: "product",
    level: "info",
    message: event,
    data: props,
  });
}
