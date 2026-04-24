import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";

import { api } from "../../convex/_generated/api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { friendlyError } from "@/lib/errors";

type Scope = "org" | "project" | "cycle";

type RoleOption = {
  value:
    | "org_owner"
    | "org_admin"
    | "org_member"
    | "project_owner"
    | "project_editor"
    | "project_evaluator"
    | "cycle_reviewer";
  label: string;
  description?: string;
};

const ROLE_OPTIONS: Record<Scope, RoleOption[]> = {
  org: [
    { value: "org_member", label: "Member", description: "Can access org prompts they're added to" },
    { value: "org_admin", label: "Admin", description: "Can manage members and projects" },
    { value: "org_owner", label: "Owner", description: "Full control including billing" },
  ],
  project: [
    { value: "project_evaluator", label: "Reviewer", description: "Can rate runs and leave feedback. Toggle blind review below." },
    { value: "project_editor", label: "Editor", description: "Can edit prompt versions and test cases" },
    { value: "project_owner", label: "Owner", description: "Can manage collaborators" },
  ],
  cycle: [
    { value: "cycle_reviewer", label: "Reviewer", description: "Can blind-evaluate this cycle's outputs" },
  ],
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: Scope;
  scopeId: string;
  defaultRole?: RoleOption["value"];
  /** Only shown for cycle scope — lets the inviter create a public link. */
  allowShareable?: boolean;
};

export function InviteDialog({
  open,
  onOpenChange,
  scope,
  scopeId,
  defaultRole,
  allowShareable,
}: Props) {
  const create = useMutation(api.invitations.create);
  const roleOptions = ROLE_OPTIONS[scope];
  const [role, setRole] = useState<RoleOption["value"]>(
    defaultRole ?? roleOptions[0]!.value,
  );
  const [emails, setEmails] = useState("");
  const [shareable, setShareable] = useState(false);
  const [blindMode, setBlindMode] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const isReviewerRole =
    role === "project_evaluator" || role === "cycle_reviewer";

  async function handleSubmit() {
    const emailList = emails
      .split(/[\s,;]+/)
      .map((e) => e.trim())
      .filter(Boolean);

    if (!shareable && emailList.length === 0) {
      toast.error("Enter at least one email.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await create({
        scope,
        scopeId,
        role,
        emails: shareable ? [] : emailList,
        shareable,
        ...(isReviewerRole ? { blindMode } : {}),
      });
      if (shareable) {
        toast.success("Shareable link created.");
      } else {
        toast.success(
          `Sent ${res.sent} invitation${res.sent === 1 ? "" : "s"}.`,
        );
      }
      setEmails("");
      setShareable(false);
      setBlindMode(true);
      onOpenChange(false);
    } catch (err) {
      toast.error(friendlyError(err, "Failed to send invitations."));
    } finally {
      setSubmitting(false);
    }
  }

  const title =
    scope === "org"
      ? "Invite to organization"
      : scope === "project"
        ? "Invite to prompt"
        : "Invite reviewers";
  const description =
    scope === "cycle"
      ? "Invitees will blind-evaluate this cycle. They can accept with an account or continue as a guest."
      : "Invitees will get an email with a link to accept.";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {roleOptions.length > 1 && (
            <div className="space-y-1.5">
              <Label className="text-xs">Role</Label>
              <Select
                value={role}
                onValueChange={(v) => setRole(v as RoleOption["value"])}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roleOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      <div className="flex flex-col gap-0.5">
                        <span>{opt.label}</span>
                        {opt.description && (
                          <span className="text-xs text-muted-foreground">
                            {opt.description}
                          </span>
                        )}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {!shareable && (
            <div className="space-y-1.5">
              <Label htmlFor="invite-emails" className="text-xs">
                Emails
              </Label>
              <Textarea
                id="invite-emails"
                placeholder="jane@example.com, john@example.com"
                value={emails}
                onChange={(e) => setEmails(e.target.value)}
                rows={3}
                disabled={submitting}
              />
              <p className="text-[11px] text-muted-foreground">
                Separate multiple emails with commas, spaces, or newlines.
              </p>
            </div>
          )}

          {isReviewerRole && (
            <label className="flex items-start gap-2 rounded-md border p-3 text-xs cursor-pointer">
              <Checkbox
                checked={blindMode}
                onCheckedChange={(v) => setBlindMode(v === true)}
                disabled={submitting}
                className="mt-0.5"
              />
              <div className="space-y-0.5">
                <p className="font-medium">Blind review</p>
                <p className="text-muted-foreground">
                  Hides the prompt, model, and version info. Recommended for
                  unbiased rating. Turn off to invite a stakeholder (e.g. PM,
                  legal) who needs full context.
                </p>
              </div>
            </label>
          )}

          {allowShareable && scope === "cycle" && (
            <label className="flex items-start gap-2 rounded-md border p-3 text-xs cursor-pointer">
              <Checkbox
                checked={shareable}
                onCheckedChange={(v) => setShareable(v === true)}
                disabled={submitting}
                className="mt-0.5"
              />
              <div className="space-y-0.5">
                <p className="font-medium">Create a shareable link instead</p>
                <p className="text-muted-foreground">
                  Anyone with the link can join as a guest reviewer. You'll
                  see who accepted by email.
                </p>
              </div>
            </label>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? "Sending…" : shareable ? "Create link" : "Send"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
