import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useOrg } from "@/contexts/OrgContext";

// Step keys mirror CopilotPanel's STEPS — kept as a string union so callers
// get autocomplete and so accidental typos break at the type level.
//
// M29.7: the M28 setup-checklist keys (add_key, leave_feedback,
// accept_optimizer) are retained in the union so existing call sites
// type-check during the cutover; they no longer appear in the active step
// order, so their rings simply never pulse. M29.8 deletes the dead call
// sites along with the deprecated members.
export type CopilotTarget =
  | "write_prompt"
  | "run_eval"
  | "compare_model"
  | "promote_test_case"
  | "add_key"
  | "leave_feedback"
  | "accept_optimizer";

const PULSE_DECAY_MS = 4000;

interface NextActionRingProps {
  target: CopilotTarget;
  // When true (e.g. on a sample-project surface), suppress the ring entirely.
  // The sample is a demo, not an action — pulsing on it would mislead.
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * M28.4: single-target pulse on the actual button the user needs to click next.
 *
 * Reads the co-pilot panel's current step and renders a CSS-only pulsing ring
 * around `children` only when `target === nextStep`. Decays from animated to
 * static after 4s, and once the user clicks anywhere inside the wrapper the
 * step key is appended to `userPreferences.copilotDismissedRings` and the ring
 * never returns for that user/step.
 */
export function NextActionRing({
  target,
  disabled,
  className,
  children,
}: NextActionRingProps) {
  const { orgId } = useOrg();
  const progress = useQuery(api.onboarding.copilotProgress, { orgId });
  const prefs = useQuery(api.userPreferences.get);
  const dismissRing = useMutation(api.userPreferences.dismissCopilotRing);
  const [decayed, setDecayed] = useState(false);

  const nextStepId = useMemo(() => {
    if (!progress) return null;
    // M29.7: matches CopilotPanel.STEPS. Deprecated targets (add_key,
    // leave_feedback, accept_optimizer) are intentionally omitted so their
    // rings never pulse without breaking existing call sites at compile time.
    const order: CopilotTarget[] = [
      "write_prompt",
      "run_eval",
      "compare_model",
      "promote_test_case",
    ];
    return order.find((id) => !(progress.steps as Record<string, boolean | undefined>)[id]) ?? null;
  }, [progress]);

  const dismissedRings = prefs?.copilotDismissedRings ?? [];
  const alreadyDismissed = dismissedRings.includes(target);

  const shouldShow =
    !disabled &&
    !alreadyDismissed &&
    nextStepId === target &&
    progress !== undefined &&
    prefs !== undefined;

  // Reset decay timer whenever the ring (re-)mounts as the active target.
  useEffect(() => {
    if (!shouldShow) {
      setDecayed(false);
      return;
    }
    setDecayed(false);
    const t = window.setTimeout(() => setDecayed(true), PULSE_DECAY_MS);
    return () => window.clearTimeout(t);
  }, [shouldShow, target]);

  const handleClickCapture = () => {
    if (!shouldShow) return;
    void dismissRing({ target });
  };

  // Always render the host span so layout doesn't shift when the ring appears.
  // We only paint the ring overlay when `shouldShow` is true.
  return (
    <span
      className={
        className
          ? `bb-next-action-ring-host ${className}`
          : "bb-next-action-ring-host"
      }
      data-copilot-target={target}
      data-decayed={decayed ? "true" : "false"}
      onClickCapture={handleClickCapture}
    >
      {children}
      {shouldShow && <span aria-hidden className="bb-next-action-ring" />}
    </span>
  );
}
