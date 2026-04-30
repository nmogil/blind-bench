import { useNavigate } from "react-router-dom";
import { Key } from "lucide-react";
import { useOrg } from "@/contexts/OrgContext";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ByokGateModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * M28.6: single-purpose forced modal that fires only when the user attempts a
 * key-requiring action (today: Run) and the org has no OpenRouter key.
 *
 * Replaces the deleted M27.8 OnboardingTour modal. Single screen, single CTA.
 * Owners get a button that drops them on the key-entry settings page; non-owners
 * see a read-only ask-your-admin variant.
 */
export function ByokGateModal({ open, onOpenChange }: ByokGateModalProps) {
  const { org, role } = useOrg();
  const navigate = useNavigate();
  const isOwner = role === "owner";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={true}>
        <DialogHeader>
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10">
            <Key className="h-4 w-4 text-primary" />
          </div>
          <DialogTitle>Add your OpenRouter key to run prompts</DialogTitle>
          <DialogDescription>
            Blind Bench runs against your own OpenRouter key — no per-seat
            pricing, no data routed through us. The key is encrypted at rest
            and never visible after saving.
          </DialogDescription>
        </DialogHeader>

        <div className="flex justify-end gap-2 pt-2">
          {isOwner ? (
            <Button
              onClick={() => {
                onOpenChange(false);
                navigate(`/orgs/${org.slug}/settings/openrouter-key`);
              }}
            >
              Add key
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">
              Ask your workspace owner to add a key.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
