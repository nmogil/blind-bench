import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { useProject } from "@/contexts/ProjectContext";
import { VersionStatusPill } from "@/components/VersionStatusPill";
import { RollbackConfirmationDialog } from "@/components/RollbackConfirmationDialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { friendlyError } from "@/lib/errors";
import {
  MessageSquare,
  Play,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";

export function Versions() {
  const { projectId } = useProject();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const navigate = useNavigate();
  const versions = useQuery(api.versions.list, { projectId });
  const createVersion = useMutation(api.versions.create);
  const deleteVersion = useMutation(api.versions.deleteVersion);

  const [error, setError] = useState("");
  const [rollbackTarget, setRollbackTarget] = useState<{
    versionId: Id<"promptVersions">;
    versionNumber: number;
  } | null>(null);

  const headVersion = versions?.[0]; // Sorted desc by versionNumber

  async function handleNewDraft() {
    setError("");
    try {
      const id = await createVersion({
        projectId,
        userMessageTemplate: "",
        parentVersionId: headVersion?._id,
      });
      navigate(
        `/orgs/${orgSlug}/projects/${projectId}/versions/${id}`,
      );
    } catch (err) {
      setError(friendlyError(err, "Failed to create draft."));
    }
  }

  // M28.5: empty Versions list pre-opens the editor — the user lands directly
  // in a fresh draft without an extra click. Guarded by a ref so the auto-draft
  // fires at most once per mount even if React re-runs the effect.
  const autoDraftStarted = useRef(false);
  useEffect(() => {
    if (versions === undefined) return;
    if (versions.length > 0) return;
    if (autoDraftStarted.current) return;
    autoDraftStarted.current = true;
    void handleNewDraft();
    // handleNewDraft is stable enough for this one-shot effect; deps would
    // re-trigger the auto-draft and double-create.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versions]);

  async function handleDelete(versionId: Id<"promptVersions">) {
    setError("");
    try {
      await deleteVersion({ versionId });
    } catch (err) {
      setError(friendlyError(err, "Failed to delete version."));
    }
  }

  if (versions === undefined) {
    return (
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-9 w-32" />
        </div>
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-20 w-full max-w-lg" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Versions</h1>
        <Button onClick={handleNewDraft} size="sm">
          <Plus className="mr-1.5 h-4 w-4" />
          New draft
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {versions.length === 0 ? (
        // M28.5: auto-draft useEffect above is mid-flight. Show a minimal
        // hand-off so the screen isn't blank during the create + navigate
        // round-trip. The `Write your first prompt` copy lives as the
        // editor's placeholder once the user lands there.
        <div className="max-w-lg space-y-3" role="status" aria-live="polite">
          <p className="text-sm text-muted-foreground">
            Opening the editor…
          </p>
          <Skeleton className="h-32 w-full" />
        </div>
      ) : (
        <div className="max-w-2xl">
          {versions.map((version, index) => {
            const isHead = index === 0;
            const isLast = index === versions.length - 1;

            // Find source version for rollback label
            const sourceVersion = version.sourceVersionId
              ? versions.find((v) => v._id === version.sourceVersionId)
              : null;

            return (
              <div key={version._id} className="relative flex gap-4">
                {/* Timeline line */}
                <div className="flex flex-col items-center">
                  <div
                    className={cn(
                      "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold",
                      version.status === "current"
                        ? "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300"
                        : version.status === "draft"
                          ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                          : "bg-slate-100 text-slate-600 dark:bg-slate-800/40 dark:text-slate-400",
                    )}
                  >
                    v{version.versionNumber}
                  </div>
                  {!isLast && (
                    <div className="w-px flex-1 bg-border min-h-[16px]" />
                  )}
                </div>

                {/* Version card */}
                <div
                  className={cn(
                    "flex-1 mb-3 rounded-md border p-3 cursor-pointer hover:bg-muted/50 transition-colors",
                    version.status === "draft" && "border-dashed",
                  )}
                  onClick={() =>
                    navigate(
                      `/orgs/${orgSlug}/projects/${projectId}/versions/${version._id}`,
                    )
                  }
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <VersionStatusPill status={version.status} />
                      {sourceVersion && (
                        <span className="text-xs text-muted-foreground italic">
                          rolled back from v{sourceVersion.versionNumber}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      {!isHead && (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setRollbackTarget({
                                    versionId: version._id,
                                    versionNumber: version.versionNumber,
                                  });
                                }}
                              />
                            }
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                          </TooltipTrigger>
                          <TooltipContent>
                            Roll back to v{version.versionNumber}
                          </TooltipContent>
                        </Tooltip>
                      )}
                      {version.status === "draft" && (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDelete(version._id);
                                }}
                              />
                            }
                          >
                            <Trash2 className="h-3.5 w-3.5 text-destructive" />
                          </TooltipTrigger>
                          <TooltipContent>Delete draft</TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                  </div>
                  <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
                    <Avatar className="h-4 w-4">
                      <AvatarImage src={version.creatorImage ?? undefined} />
                      <AvatarFallback className="text-[8px]">
                        {(version.creatorName ?? "?")[0]}
                      </AvatarFallback>
                    </Avatar>
                    <span>{version.creatorName ?? "Unknown"}</span>
                    <span>·</span>
                    <span>
                      {new Date(version._creationTime).toLocaleDateString()}
                    </span>
                  </div>
                  {version.userMessageTemplate && (
                    <p className="mt-1.5 text-xs text-muted-foreground truncate max-w-md">
                      {version.userMessageTemplate.slice(0, 100)}
                      {version.userMessageTemplate.length > 100 ? "..." : ""}
                    </p>
                  )}
                  {(version.runCount > 0 || version.feedbackCount > 0) && (
                    <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
                      {version.runCount > 0 && (
                        <Link
                          to={`/orgs/${orgSlug}/projects/${projectId}/versions/${version._id}?tab=runs`}
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
                        >
                          <Play className="h-3 w-3" />
                          {version.runCount} run
                          {version.runCount === 1 ? "" : "s"}
                        </Link>
                      )}
                      {version.feedbackCount > 0 && (
                        <Link
                          to={`/orgs/${orgSlug}/projects/${projectId}/versions/${version._id}?tab=feedback`}
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
                        >
                          <MessageSquare className="h-3 w-3" />
                          {version.feedbackCount} feedback
                        </Link>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {rollbackTarget && headVersion && (
        <RollbackConfirmationDialog
          open={!!rollbackTarget}
          onOpenChange={(open) => !open && setRollbackTarget(null)}
          targetVersionNumber={rollbackTarget.versionNumber}
          targetVersionId={rollbackTarget.versionId}
          currentHeadNumber={headVersion.versionNumber}
        />
      )}
    </div>
  );
}

