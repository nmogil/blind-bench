/**
 * Playwright component-test mock for `convex/react`, wired in via a Vite alias
 * in playwright-ct.config.ts. Lets the real trace-viewer components render and
 * lazy-expand against deterministic fixture data — no backend, no auth. Only the
 * hooks the trace components import are stubbed.
 */
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
const noopMutation = async () => undefined;
const PAGINATED = {
  results: FIXTURE_STEPS,
  status: "Exhausted" as const,
  isLoading: false,
  loadMore: noop,
};

export function usePaginatedQuery() {
  return PAGINATED;
}

export function useAction() {
  return getBodyFn;
}

export function useMutation() {
  return noopMutation;
}

export function useQuery() {
  return undefined;
}
