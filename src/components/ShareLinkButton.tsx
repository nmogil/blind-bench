import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { Share2, Copy, Check, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { friendlyError } from "@/lib/errors";

export function ShareLinkButton({ runId }: { runId: Id<"promptRuns"> }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const link = useQuery(api.shareableLinks.getShareableLinkForRun, { runId });
  const createLink = useMutation(api.shareableLinks.createShareableLink);
  const deactivateLink = useMutation(api.shareableLinks.deactivateShareableLink);

  async function handleCreate() {
    try {
      await createLink({ runId });
      setOpen(true);
    } catch (err) {
      toast.error(friendlyError(err, "Failed to create shareable link."));
    }
  }

  async function handleDeactivate() {
    if (!link) return;
    try {
      await deactivateLink({ linkId: link._id });
      setOpen(false);
      toast.success("Link deactivated");
    } catch (err) {
      toast.error(friendlyError(err, "Failed to deactivate link."));
    }
  }

  function handleCopy() {
    if (!link) return;
    const url = `${window.location.origin}/s/${link.token}`;
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast.success("Link copied to clipboard");
  }

  const shareableUrl = link
    ? `${window.location.origin}/s/${link.token}`
    : null;

  const expiresIn = link
    ? Math.max(0, Math.round((link.expiresAt - Date.now()) / (60 * 60 * 1000)))
    : 0;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={link ? () => setOpen(!open) : handleCreate}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium",
          "hover:bg-muted/50 transition-colors",
        )}
      >
        <Share2 className="h-3.5 w-3.5" />
        Share
      </button>

      {open && link && (
        <div className="absolute right-0 top-full z-50 mt-2 w-80 rounded-lg border border-border bg-popover p-4 shadow-md">
          <div className="space-y-3">
            <div className="text-sm font-medium">Shareable blind eval link</div>

            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={shareableUrl ?? ""}
                className="flex-1 truncate rounded-md border border-input bg-muted/50 px-2.5 py-1.5 text-xs font-mono"
              />
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex shrink-0 items-center rounded-md border border-border px-2 py-1.5 text-xs hover:bg-muted/50"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-green-600" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </button>
            </div>

            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {link.responseCount} response{link.responseCount !== 1 && "s"}
              </span>
              <span>
                {expiresIn > 0
                  ? `Expires in ${expiresIn}h`
                  : "Expired"}
              </span>
            </div>

            <button
              type="button"
              onClick={handleDeactivate}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive"
            >
              <XCircle className="h-3 w-3" />
              Deactivate link
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
