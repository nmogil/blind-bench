import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { friendlyError } from "@/lib/errors";
import { toast } from "sonner";
import { Mail, X } from "lucide-react";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface SendEvaluationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: Id<"projects">;
  preselectedCycleId?: Id<"reviewCycles">;
  showTargetPicker?: boolean;
}

export function SendEvaluationDialog({
  open,
  onOpenChange,
  projectId,
  preselectedCycleId,
  showTargetPicker,
}: SendEvaluationDialogProps) {
  const sendInvitations = useMutation(api.evalInvitations.sendInvitations);

  const cycles = useQuery(
    api.reviewCycles.list,
    showTargetPicker ? { projectId } : "skip",
  );

  const [selectedTarget, setSelectedTarget] = useState<string>(
    preselectedCycleId ? `cycle:${preselectedCycleId}` : "",
  );
  const [emails, setEmails] = useState<string[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const openCycles = cycles?.filter((c) => c.status === "open") ?? [];

  const handleAddEmail = (raw: string) => {
    const email = raw.trim().toLowerCase();
    if (!email) return;
    if (!EMAIL_REGEX.test(email)) {
      setError(`Invalid email: ${email}`);
      return;
    }
    if (emails.includes(email)) {
      setError(`${email} already added`);
      return;
    }
    setError("");
    setEmails((prev) => [...prev, email]);
    setInputValue("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "," || e.key === "Tab") {
      e.preventDefault();
      handleAddEmail(inputValue);
    }
    if (e.key === "Backspace" && inputValue === "" && emails.length > 0) {
      setEmails((prev) => prev.slice(0, -1));
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text");
    const parts = text.split(/[,;\s\n]+/).filter(Boolean);
    for (const part of parts) {
      handleAddEmail(part);
    }
  };

  const removeEmail = (email: string) => {
    setEmails((prev) => prev.filter((e) => e !== email));
  };

  const resolveTarget = (): {
    cycleId?: Id<"reviewCycles">;
    runId?: Id<"promptRuns">;
  } => {
    const target = preselectedCycleId
      ? `cycle:${preselectedCycleId}`
      : selectedTarget;
    if (!target) return {};
    const [type, id] = target.split(":");
    if (type === "cycle") return { cycleId: id as Id<"reviewCycles"> };
    if (type === "run") return { runId: id as Id<"promptRuns"> };
    return {};
  };

  const handleSubmit = async () => {
    const target = resolveTarget();
    if (!target.cycleId && !target.runId) {
      setError("Select what to evaluate");
      return;
    }
    if (emails.length === 0) {
      setError("Add at least one email address");
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      const result = await sendInvitations({
        emails,
        ...target,
      });
      const parts: string[] = [];
      if (result.sent > 0)
        parts.push(
          `Sent to ${result.sent} ${result.sent === 1 ? "person" : "people"}`,
        );
      if (result.skipped > 0)
        parts.push(`${result.skipped} already responded`);
      toast.success(parts.join(", ") || "Invitations sent");
      setEmails([]);
      setInputValue("");
      setSelectedTarget(preselectedCycleId ? `cycle:${preselectedCycleId}` : "");
      onOpenChange(false);
    } catch (err) {
      setError(friendlyError(err, "Failed to send invitations."));
    } finally {
      setSubmitting(false);
    }
  };

  const hasTarget = preselectedCycleId || selectedTarget;
  const canSubmit = hasTarget && emails.length > 0 && !submitting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send Evaluation</DialogTitle>
          <DialogDescription>
            Invite people to evaluate outputs. No account needed.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {showTargetPicker && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">What to evaluate</label>
              <Select
                value={selectedTarget}
                onValueChange={(v) => {
                  if (v) setSelectedTarget(v);
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a cycle or run" />
                </SelectTrigger>
                <SelectContent>
                  {openCycles.length > 0 && (
                    <SelectGroup>
                      <SelectLabel>Open Cycles</SelectLabel>
                      {openCycles.map((c) => (
                        <SelectItem
                          key={c._id}
                          value={`cycle:${c._id}`}
                          className="text-sm"
                        >
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Email addresses</label>
            <div className="rounded-md border border-input bg-transparent px-3 py-2 min-h-[42px] flex flex-wrap gap-1.5 items-center focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
              {emails.map((email) => (
                <span
                  key={email}
                  className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs"
                >
                  {email}
                  <button
                    type="button"
                    onClick={() => removeEmail(email)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <Input
                type="email"
                placeholder={
                  emails.length === 0 ? "name@example.com" : "Add another..."
                }
                value={inputValue}
                onChange={(e) => {
                  setInputValue(e.target.value);
                  setError("");
                }}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onBlur={() => {
                  if (inputValue.trim()) handleAddEmail(inputValue);
                }}
                className="flex-1 min-w-[140px] border-0 p-0 h-auto text-sm shadow-none focus-visible:ring-0"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Separate multiple emails with commas or Enter
            </p>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            <Mail className="mr-1.5 h-3.5 w-3.5" />
            {submitting
              ? "Sending..."
              : `Send ${emails.length > 0 ? `(${emails.length})` : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
