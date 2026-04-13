import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";

export function useOnboardingCallout(
  calloutKey: string,
  prerequisiteDismissed?: string,
) {
  const prefs = useQuery(api.userPreferences.get);
  const dismiss = useMutation(api.userPreferences.dismissCallout);

  // Default to hidden while loading to prevent flash
  const isDismissed = prefs?.dismissedCallouts?.includes(calloutKey) ?? true;
  const prerequisiteMet = prerequisiteDismissed
    ? (prefs?.dismissedCallouts?.includes(prerequisiteDismissed) ?? false)
    : true;

  return {
    show: prefs !== undefined && !isDismissed && prerequisiteMet,
    dismiss: () => dismiss({ calloutKey }),
  };
}
