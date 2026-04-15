import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { useProject } from "@/contexts/ProjectContext";
import { useOrg } from "@/contexts/OrgContext";
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
  ArrowRight,
  CheckCircle2,
  Circle,
  FlaskConical,
  FileText,
  Key,
  Lightbulb,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";

export function Versions() {
  const { projectId } = useProject();
  const { orgId, role: orgRole } = useOrg();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const navigate = useNavigate();
  const versions = useQuery(api.versions.list, { projectId });
  const createVersion = useMutation(api.versions.create);
  const deleteVersion = useMutation(api.versions.deleteVersion);

  // Setup checklist queries (only needed when versions list is empty)
  const keyStatus = useQuery(api.openRouterKeys.hasKey, { orgId });
  const testCases = useQuery(api.testCases.list, { projectId });

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
        <SetupChecklist
          orgSlug={orgSlug!}
          projectId={projectId}
          isOwner={orgRole === "owner"}
          hasKey={keyStatus?.hasKey ?? false}
          hasTestCases={(testCases?.length ?? 0) > 0}
          testCaseCount={testCases?.length ?? 0}
          onCreateDraft={handleNewDraft}
        />
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
                        ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-400"
                        : version.status === "draft"
                          ? "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-400"
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

// ---------------------------------------------------------------------------
// Setup checklist — shown when the project has no versions yet
// ---------------------------------------------------------------------------

function SetupChecklist({
  orgSlug,
  projectId,
  isOwner,
  hasKey,
  hasTestCases,
  testCaseCount,
  onCreateDraft,
}: {
  orgSlug: string;
  projectId: string;
  isOwner: boolean;
  hasKey: boolean;
  hasTestCases: boolean;
  testCaseCount: number;
  onCreateDraft: () => void;
}) {
  const steps = [
    ...(isOwner
      ? [{ key: "api-key", done: hasKey }]
      : []),
    { key: "prompt", done: false },
    { key: "test-cases", done: hasTestCases },
  ];
  const nextStep = steps.find((s) => !s.done)?.key ?? null;

  return (
    <div className="max-w-lg space-y-4">
      <p className="text-sm text-muted-foreground">
        Get started by setting up your prompt:
      </p>

      <div className="space-y-1">
        {isOwner && (
          <SetupStep
            done={hasKey}
            isNext={nextStep === "api-key"}
            icon={Key}
            label="Set up your OpenRouter API key"
            sublabel="Required to run prompts against LLM models"
            to={`/orgs/${orgSlug}/settings/openrouter-key`}
            doneLabel="API key configured"
          />
        )}
        <button
          onClick={onCreateDraft}
          className={cn(
            "flex w-full items-start gap-3 rounded-lg border px-4 py-3 text-left transition-colors",
            nextStep === "prompt"
              ? "border-primary/30 bg-primary/5 hover:bg-primary/10"
              : "border-border hover:bg-muted/50",
          )}
        >
          <div className="mt-0.5">
            <Circle
              className={cn(
                "h-5 w-5",
                nextStep === "prompt"
                  ? "text-primary"
                  : "text-muted-foreground/40",
              )}
            />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="text-sm font-medium">
                Write your first prompt
              </span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Create a prompt template with {"{{variables}}"} for dynamic parts
            </p>
          </div>
          {nextStep === "prompt" && (
            <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          )}
        </button>
        <SetupStep
          done={hasTestCases}
          isNext={nextStep === "test-cases"}
          icon={FlaskConical}
          label="Add test cases"
          sublabel="Provide input values to test your prompt with"
          to={`/orgs/${orgSlug}/projects/${projectId}/run`}
          doneLabel={`${testCaseCount} test case${testCaseCount === 1 ? "" : "s"}`}
        />
      </div>

      <HowItWorks />
    </div>
  );
}

function SetupStep({
  done,
  isNext,
  icon: Icon,
  label,
  sublabel,
  to,
  doneLabel,
}: {
  done: boolean;
  isNext: boolean;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  sublabel: string;
  to: string;
  doneLabel: string;
}) {
  return (
    <Link
      to={to}
      className={cn(
        "flex items-start gap-3 rounded-lg border px-4 py-3 transition-colors",
        done
          ? "border-green-200 bg-green-50/50 dark:border-green-900/40 dark:bg-green-950/10"
          : isNext
            ? "border-primary/30 bg-primary/5 hover:bg-primary/10"
            : "border-border hover:bg-muted/50",
      )}
    >
      <div className="mt-0.5">
        {done ? (
          <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" />
        ) : (
          <Circle
            className={cn(
              "h-5 w-5",
              isNext ? "text-primary" : "text-muted-foreground/40",
            )}
          />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <Icon
            className={cn(
              "h-4 w-4 shrink-0",
              done
                ? "text-green-600 dark:text-green-400"
                : "text-muted-foreground",
            )}
          />
          <span
            className={cn(
              "text-sm font-medium",
              done && "text-green-700 dark:text-green-400",
            )}
          >
            {done ? doneLabel : label}
          </span>
        </div>
        {!done && (
          <p className="mt-0.5 text-xs text-muted-foreground">{sublabel}</p>
        )}
      </div>
      {isNext && !done && (
        <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      )}
    </Link>
  );
}

function HowItWorks() {
  return (
    <div className="rounded-lg border border-dashed p-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Lightbulb className="h-4 w-4 text-muted-foreground" />
        How it works
      </div>
      <ol className="mt-2 space-y-1.5 text-xs text-muted-foreground list-decimal list-inside">
        <li>Write a prompt template with {"{{variables}}"}</li>
        <li>Select test cases and models on the Run page, then execute</li>
        <li>Evaluate outputs blind, get feedback, iterate</li>
      </ol>
    </div>
  );
}
