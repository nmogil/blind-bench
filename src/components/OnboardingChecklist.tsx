import { useNavigate } from "react-router-dom";
import { useOrg } from "@/contexts/OrgContext";
import { useOrgLayout } from "@/components/layouts/OrgLayout";
import { useOnboardingProgress, type OnboardingStepId, type OnboardingStep } from "@/hooks/useOnboardingProgress";
import { useOnboardingCallout } from "@/hooks/useOnboardingCallout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Check, Lock, X, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

export const ONBOARDING_CHECKLIST_KEY = "onboarding_checklist";

interface OnboardingChecklistProps {
  variant?: "inline" | "sheet";
  onStepNavigate?: () => void;
  onDismissed?: () => void;
}

export function OnboardingChecklist({
  variant = "inline",
  onStepNavigate,
  onDismissed,
}: OnboardingChecklistProps) {
  const { org } = useOrg();
  const navigate = useNavigate();
  const { openNewProjectDialog } = useOrgLayout();
  const { show, dismiss } = useOnboardingCallout(ONBOARDING_CHECKLIST_KEY);
  const progress = useOnboardingProgress();

  const isInline = variant === "inline";

  // Inline variant: respect dismiss state and hide when complete.
  // Sheet variant: always visible when the sheet is open (user explicitly opened it).
  if (isInline && !show) return null;
  if (isInline && progress.isComplete) return null;

  if (progress.loading) {
    return isInline ? (
      <Card>
        <CardContent className="pt-6 space-y-3">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-72" />
          <div className="space-y-2 pt-3">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    ) : (
      <div className="space-y-2 p-4">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  const handleStepClick = (step: OnboardingStep) => {
    if (step.locked) return;
    const id = step.id satisfies OnboardingStepId;
    switch (id) {
      case "connect_key":
        navigate(`/orgs/${org.slug}/settings/openrouter-key`);
        break;
      case "create_prompt":
        openNewProjectDialog();
        break;
      case "add_test_case":
        if (progress.firstProjectId)
          navigate(
            `/orgs/${org.slug}/projects/${progress.firstProjectId}/test-cases`,
          );
        break;
      case "run_prompt":
        if (progress.firstProjectId)
          navigate(`/orgs/${org.slug}/projects/${progress.firstProjectId}/run`);
        break;
      case "collect_feedback":
        if (progress.firstProjectId)
          navigate(
            `/orgs/${org.slug}/projects/${progress.firstProjectId}/cycles/new`,
          );
        break;
      case "optimize":
        if (progress.firstProjectId)
          navigate(
            `/orgs/${org.slug}/projects/${progress.firstProjectId}/versions`,
          );
        break;
    }
    onStepNavigate?.();
  };

  const handleDismiss = () => {
    dismiss();
    onDismissed?.();
  };

  const nextStepId = progress.nextStep?.id;
  const percent = progress.totalCount
    ? Math.round((progress.doneCount / progress.totalCount) * 100)
    : 0;

  const header = (
    <div>
      <div className="flex items-center justify-between gap-2">
        <h2
          className={cn(
            "font-semibold",
            isInline ? "text-lg" : "text-base",
          )}
        >
          {progress.isComplete ? "You're all set up" : "Get started with Blind Bench"}
        </h2>
        {isInline && (
          <button
            onClick={handleDismiss}
            className="rounded p-0.5 text-muted-foreground hover:text-foreground"
            aria-label="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Collect honest feedback on your prompts from experts, teammates, or customers — and turn it into a better prompt.
      </p>

      <div className="mt-4 flex items-center gap-3">
        <div
          className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={progress.doneCount}
          aria-valuemin={0}
          aria-valuemax={progress.totalCount}
        >
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${percent}%` }}
          />
        </div>
        <span className="text-xs tabular-nums text-muted-foreground">
          {progress.doneCount}/{progress.totalCount}
        </span>
      </div>
    </div>
  );

  const list = (
    <ol className="mt-5 space-y-2">
      {progress.steps.map((step, index) => {
        const isNext = step.id === nextStepId;
        return (
          <li
            key={step.id}
            className={cn(
              "rounded-lg border transition-colors",
              step.done
                ? "border-border/50 bg-muted/30"
                : isNext
                  ? "border-primary/30 bg-primary/5"
                  : "border-border",
              step.locked && !step.done && "opacity-60",
            )}
          >
            <div className="flex items-start gap-3 p-3">
              <StepIcon step={step} index={index} />
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    "text-sm font-medium",
                    step.done && "text-muted-foreground line-through",
                  )}
                >
                  {step.title}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {step.locked && step.lockedReason
                    ? step.lockedReason
                    : step.description}
                </p>
              </div>
              {!step.done && !step.locked && (
                <Button
                  size="sm"
                  variant={isNext ? "default" : "outline"}
                  onClick={() => handleStepClick(step)}
                  className="shrink-0"
                >
                  {isNext ? "Start" : "Open"}
                  <ArrowRight className="ml-1 h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );

  if (isInline) {
    return (
      <Card>
        <CardContent className="pt-6">
          {header}
          {list}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-4">
      {header}
      {list}
    </div>
  );
}

function StepIcon({
  step,
  index,
}: {
  step: OnboardingStep;
  index: number;
}) {
  if (step.done) {
    return (
      <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
        <Check className="h-3 w-3" />
      </div>
    );
  }
  if (step.locked) {
    return (
      <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground">
        <Lock className="h-3 w-3" />
      </div>
    );
  }
  return (
    <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground">
      <span className="text-[10px] font-medium tabular-nums">{index + 1}</span>
    </div>
  );
}
