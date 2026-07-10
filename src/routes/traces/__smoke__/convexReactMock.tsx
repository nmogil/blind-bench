/**
 * Playwright component-test mock for `convex/react`, wired in via a Vite alias
 * in playwright-ct.config.ts. Lets the real trace-viewer components render and
 * lazy-expand against deterministic fixture data — no backend, no auth. Only the
 * hooks the trace components import are stubbed.
 */
import { getFunctionName } from "convex/server";

export const FIXTURE_STEPS = [
  { stepIndex: 0, kind: "message", role: "assistant", hasBody: true },
  {
    stepIndex: 1,
    kind: "tool_call",
    toolName: "run_command",
    toolCallId: "call-1",
    privacyClass: "internal",
    hasBody: true,
  },
  { stepIndex: 2, kind: "tool_result", toolName: "run_command", toolCallId: "call-1", hasBody: true },
  { stepIndex: 3, kind: "policy_event", policy: "system", action: "local_command" },
];

// One body object that serves every step kind — StepBody picks its own field.
const FIXTURE_BODY = {
  content: "AGENT_SAID_HELLO",
  args: { command: "run_the_command" },
  result: { ok: true, note: "TOOL_RESULT_NOTE" },
  snapshot: {},
  text: "FINAL_ANSWER_TEXT",
};

// Stable references — real Convex hooks return stable fns; StepBody's effect
// depends on the action fn, so a fresh fn each render would loop forever.
const noop = () => {};
const getBodyFn = async () => FIXTURE_BODY;
const importPairedComparison = async () => ({ campaignId: "campaign-import-test" });
const noopMutation = async () => undefined;
const createVerdictReview = async () => "verdict-review-test";
const createImportProject = async () => ({ orgSlug: "test-org", projectId: "test-project" });
const PAGINATED = {
  results: FIXTURE_STEPS,
  status: "Exhausted" as const,
  isLoading: false,
  loadMore: noop,
};

export function usePaginatedQuery() {
  return PAGINATED;
}

export function useAction(action?: unknown) {
  try {
    if (getFunctionName(action as never) === "comparisonCampaigns:importPairedCsv") {
      return importPairedComparison;
    }
  } catch {
    // Keep unrelated component-test actions on the stable body fixture.
  }
  return getBodyFn;
}

export function useMutation(mutation?: unknown) {
  try {
    const name = getFunctionName(mutation as never);
    if (name === "projects:createForImport") return createImportProject;
    if (name === "verdictReviewCampaigns:create") return createVerdictReview;
  } catch {
    // Keep unrelated component-test mutations as stable no-ops.
  }
  return noopMutation;
}

// Fixture rows for the blind reviewer's discovery list (listReviewableTraces).
export const FIXTURE_REVIEWABLE = [
  {
    token: "opaque-review-token-1",
    kind: "trace",
    projectName: "Support Router",
    status: "ready",
    stepCount: 12,
    createdAt: 2,
  },
  {
    token: "opaque-review-token-2",
    kind: "trace",
    projectName: "Refund Agent",
    status: "ready",
    stepCount: 3,
    createdAt: 1,
  },
];

// A blind reviewer's getTrace payload — provenance stripped by the backend
// (harness/model/product undefined), projectName + usage retained.
export const FIXTURE_BLIND_MATCHUP = {
  projectName: "Support Router",
  divergenceStepIndex: 1,
  firstSide: "right",
  leftBlindLabel: "B",
  rightBlindLabel: "A",
  comparable: true,
  winner: null,
  reasonTags: [],
};

export const FIXTURE_OWNER_TRACES = [
  {
    _id: "trace-owner-1",
    product: "support",
    harnessName: "pi",
    model: "claude-sonnet",
    status: "ready",
    stepCount: 4,
    createdAt: 2,
  },
  {
    _id: "trace-owner-2",
    product: "support",
    harnessName: "native",
    model: "gpt-4o",
    status: "ready",
    stepCount: 1,
    createdAt: 1,
  },
];

export const FIXTURE_VERDICT_REVIEWS = [
  {
    id: "verdict-open",
    mode: "verdict",
    name: "Open run review",
    status: "open",
    itemCount: 5,
    reviewedRuns: 2,
    reviewers: 1,
    judgments: 2,
    createdAt: 3,
  },
  {
    id: "verdict-closed",
    mode: "verdict",
    name: "Closed run review",
    status: "closed",
    itemCount: 3,
    reviewedRuns: 3,
    reviewers: 2,
    judgments: 6,
    createdAt: 2,
  },
];

export const FIXTURE_COMPARISON_REVIEWS = [
  {
    id: "comparison-closed",
    name: "Candidate comparison",
    status: "closed",
    caseCount: 5,
    judgments: 10,
    createdAt: 1,
  },
];

export const FIXTURE_BLIND_TRACE = {
  _id: "trace_review_1",
  projectName: "Support Router",
  traceId: undefined,
  product: undefined,
  module: undefined,
  environment: undefined,
  status: "ready",
  stepCount: 4,
  privacyClass: "internal",
  model: undefined,
  harnessName: undefined,
  harnessVersion: undefined,
  usage: { totalTokens: 900 },
  hasFinalAnswer: true,
};

// Branch by function name so each query gets the right fixture; anything
// unmapped stays undefined (loading), keeping specs independent.
export function useQuery(query: unknown) {
  try {
    switch (getFunctionName(query as never)) {
      case "agentTraceReviewSessions:listMine":
        return FIXTURE_REVIEWABLE;
      case "agentTraces:listTraces":
        return FIXTURE_OWNER_TRACES;
      case "verdictReviewCampaigns:listCampaigns":
        return FIXTURE_VERDICT_REVIEWS;
      case "comparisonCampaigns:listCampaigns":
        return FIXTURE_COMPARISON_REVIEWS;
      case "agentTraces:getTrace":
      case "agentTraceReviewSessions:getTrace":
        return FIXTURE_BLIND_TRACE;
      case "agentTraceReviewSessions:getMatchup":
        return FIXTURE_BLIND_MATCHUP;
      case "agentTraceReview:myVerdict":
      case "agentTraceReviewSessions:myVerdict":
        return null;
      case "agentTraceReview:listComments":
      case "agentTraceReviewSessions:listComments":
        return [];
    }
  } catch {
    // Not a resolvable function reference — treat as loading.
  }
  return undefined;
}
