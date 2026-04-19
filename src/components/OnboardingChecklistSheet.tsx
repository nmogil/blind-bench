import { createContext, useContext, useState, useCallback, ReactNode } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { OnboardingChecklist } from "@/components/OnboardingChecklist";

interface OnboardingChecklistContextValue {
  openChecklist: () => void;
  closeChecklist: () => void;
  isOpen: boolean;
}

const OnboardingChecklistContext =
  createContext<OnboardingChecklistContextValue | null>(null);

export function useOnboardingChecklist(): OnboardingChecklistContextValue {
  const ctx = useContext(OnboardingChecklistContext);
  if (!ctx) {
    throw new Error(
      "useOnboardingChecklist must be used within OnboardingChecklistProvider",
    );
  }
  return ctx;
}

export function OnboardingChecklistProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);

  const openChecklist = useCallback(() => setIsOpen(true), []);
  const closeChecklist = useCallback(() => setIsOpen(false), []);

  return (
    <OnboardingChecklistContext.Provider
      value={{ openChecklist, closeChecklist, isOpen }}
    >
      {children}
      <Sheet open={isOpen} onOpenChange={setIsOpen}>
        <SheetContent className="w-[440px] sm:max-w-[440px]">
          <SheetHeader>
            <SheetTitle>Setup guide</SheetTitle>
            <SheetDescription>
              Finish these steps to get the full Blind Bench loop running.
            </SheetDescription>
          </SheetHeader>
          <OnboardingChecklist
            variant="sheet"
            onStepNavigate={closeChecklist}
          />
        </SheetContent>
      </Sheet>
    </OnboardingChecklistContext.Provider>
  );
}
