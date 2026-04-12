import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { friendlyError } from "@/lib/errors";

interface RollbackConfirmationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targetVersionNumber: number;
  targetVersionId: Id<"promptVersions">;
  currentHeadNumber: number;
  onSuccess?: (newVersionId: Id<"promptVersions">) => void;
}

export function RollbackConfirmationDialog({
  open,
  onOpenChange,
  targetVersionNumber,
  targetVersionId,
  currentHeadNumber,
  onSuccess,
}: RollbackConfirmationDialogProps) {
  const rollback = useMutation(api.versions.rollback);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleRollback() {
    setSaving(true);
    setError("");
    try {
      const newId = await rollback({ versionId: targetVersionId });
      onOpenChange(false);
      onSuccess?.(newId);
    } catch (err) {
      setError(friendlyError(err, "Failed to roll back."));
    } finally {
      setSaving(false);
    }
  }

  const newVersionNumber = currentHeadNumber + 1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Roll back to version {targetVersionNumber}?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          This creates a new version at the head of the timeline with the
          content of v{targetVersionNumber}. The timeline will show: v
          {currentHeadNumber} (current) &rarr; v{newVersionNumber} (rolled back
          from v{targetVersionNumber}).
        </p>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={handleRollback} disabled={saving}>
            {saving ? "Rolling back..." : "Roll back"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
