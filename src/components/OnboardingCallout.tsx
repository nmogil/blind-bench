import { useOnboardingCallout } from "@/hooks/useOnboardingCallout";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

interface OnboardingCalloutProps {
  calloutKey: string;
  children: React.ReactNode;
  className?: string;
  prerequisiteDismissed?: string;
}

export function OnboardingCallout({
  calloutKey,
  children,
  className,
  prerequisiteDismissed,
}: OnboardingCalloutProps) {
  const { show, dismiss } = useOnboardingCallout(calloutKey, prerequisiteDismissed);

  if (!show) return null;

  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-foreground",
        className,
      )}
    >
      <p className="flex-1">{children}</p>
      <button
        type="button"
        onClick={dismiss}
        className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
        aria-label="Dismiss"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
