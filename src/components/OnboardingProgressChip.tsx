import { useOnboardingProgress } from "@/hooks/useOnboardingProgress";
import { useOnboardingCallout } from "@/hooks/useOnboardingCallout";
import { useOnboardingChecklist } from "@/components/OnboardingChecklistSheet";
import { ONBOARDING_CHECKLIST_KEY } from "@/components/OnboardingChecklist";
import { Sparkles } from "lucide-react";

export function OnboardingProgressChip() {
  const progress = useOnboardingProgress();
  const { openChecklist } = useOnboardingChecklist();
  const { show } = useOnboardingCallout(ONBOARDING_CHECKLIST_KEY);

  if (progress.loading) return null;
  if (progress.isComplete) return null;
  if (!show) return null;

  return (
    <button
      onClick={openChecklist}
      className="hidden sm:flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/5 px-2 py-1 text-xs text-foreground hover:bg-primary/10 transition-colors"
      title="Finish onboarding"
    >
      <Sparkles className="h-3.5 w-3.5 text-primary" />
      <span>
        Get started{" "}
        <span className="tabular-nums text-muted-foreground">
          · {progress.doneCount}/{progress.totalCount}
        </span>
      </span>
    </button>
  );
}
