import { useQuery } from "convex/react";
import { useMemo } from "react";
import { api } from "../../convex/_generated/api";
import { useOrg } from "@/contexts/OrgContext";
import { Id } from "../../convex/_generated/dataModel";

export type OnboardingStepId =
  | "connect_key"
  | "create_prompt"
  | "add_test_case"
  | "run_prompt"
  | "collect_feedback"
  | "optimize";

export interface OnboardingStep {
  id: OnboardingStepId;
  title: string;
  description: string;
  done: boolean;
  locked: boolean;
  lockedReason?: string;
}

export interface OnboardingProgressState {
  loading: boolean;
  role: "owner" | "admin" | "member" | null;
  firstProjectId: Id<"projects"> | null;
  steps: OnboardingStep[];
  doneCount: number;
  totalCount: number;
  isComplete: boolean;
  nextStep: OnboardingStep | null;
}

export function useOnboardingProgress(): OnboardingProgressState {
  const { orgId } = useOrg();
  const progress = useQuery(api.onboarding.getProgress, { orgId });

  return useMemo<OnboardingProgressState>(() => {
    if (progress === undefined) {
      return {
        loading: true,
        role: null,
        firstProjectId: null,
        steps: [],
        doneCount: 0,
        totalCount: 0,
        isComplete: false,
        nextStep: null,
      };
    }

    const isOwner = progress.role === "owner";
    const keyLocked = !progress.hasKey && !isOwner;

    const steps: OnboardingStep[] = [
      {
        id: "connect_key",
        title: "Connect your OpenRouter key",
        description:
          "Blind Bench runs your prompts through your own OpenRouter account — no per-seat pricing, no data routed through us. Your key is encrypted at rest.",
        done: progress.hasKey,
        locked: keyLocked,
        lockedReason: keyLocked
          ? "Your org owner needs to connect this key."
          : undefined,
      },
      {
        id: "create_prompt",
        title: "Create your first prompt",
        description:
          "A prompt holds every version, variable, and test case together. Start from a sample to see the whole loop in under a minute, or paste your own.",
        done: progress.hasProject,
        locked: false,
      },
      {
        id: "add_test_case",
        title: "Add a test case",
        description:
          "Test cases are the inputs you want your prompt to handle well. Running the same prompt against a stable set of inputs is how you tell whether a change is actually an improvement.",
        done: progress.hasTestCase,
        locked: !progress.hasProject,
        lockedReason: !progress.hasProject
          ? "Create a prompt first."
          : undefined,
      },
      {
        id: "run_prompt",
        title: "Run your prompt",
        description:
          "Generate three outputs labeled A, B, C with no version info. That's the blind comparison — no one knows which output came from which version until after they've judged it.",
        done: progress.hasRun,
        locked: !progress.hasProject || !progress.hasKey,
        lockedReason:
          !progress.hasKey
            ? "Connect an OpenRouter key first."
            : !progress.hasProject
              ? "Create a prompt first."
              : undefined,
      },
      {
        id: "collect_feedback",
        title: "Collect blind feedback",
        description:
          "Share the blind outputs with experts, teammates, or customers — no account required. Every comment stays attached to its blind label until the round closes.",
        done: progress.hasCycleOrSoloEval,
        locked: !progress.hasRun,
        lockedReason: !progress.hasRun ? "Run your prompt first." : undefined,
      },
      {
        id: "optimize",
        title: "Optimize from real feedback",
        description:
          "The optimizer rewrites your prompt using the feedback you just collected and cites every comment it applied. Review the diff, accept or reject, repeat.",
        done: progress.hasAcceptedOptimization,
        locked: !progress.hasCycleOrSoloEval,
        lockedReason: !progress.hasCycleOrSoloEval
          ? "Collect feedback first."
          : undefined,
      },
    ];

    const doneCount = steps.filter((s) => s.done).length;
    const totalCount = steps.length;
    const isComplete = doneCount === totalCount;
    const nextStep =
      steps.find((s) => !s.done && !s.locked) ??
      steps.find((s) => !s.done) ??
      null;

    return {
      loading: false,
      role: progress.role,
      firstProjectId: progress.firstProjectId,
      steps,
      doneCount,
      totalCount,
      isComplete,
      nextStep,
    };
  }, [progress]);
}
