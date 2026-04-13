import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { useProject } from "@/contexts/ProjectContext";
import { PromptDiff } from "@/components/PromptDiff";
import { ChangesPanel } from "@/components/ChangesPanel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { friendlyError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  Check,
  X,
  Pencil,
  RotateCcw,
  AlertCircle,
  CheckCircle2,
  XCircle,
} from "lucide-react";

export function OptimizationReview() {
  const { projectId } = useProject();
  const { orgSlug, requestId } = useParams<{
    orgSlug: string;
    requestId: string;
  }>();

  const optimization = useQuery(
    api.optimize.getOptimization,
    requestId
      ? { requestId: requestId as Id<"optimizationRequests"> }
      : "skip",
  );

  const sourceVersion = useQuery(
    api.versions.get,
    optimization
      ? { versionId: optimization.promptVersionId }
      : "skip",
  );

  // Loading
  if (optimization === undefined) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-6 w-64" />
        <div className="grid grid-cols-2 gap-4">
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
      </div>
    );
  }

  // Not found
  if (optimization === null) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">
          Optimization request not found.
        </p>
        <Link
          to={`/orgs/${orgSlug}/projects/${projectId}/versions`}
          className="text-sm text-primary hover:underline mt-2 inline-block"
        >
          Back to versions
        </Link>
      </div>
    );
  }

  // Route to correct sub-view
  if (
    optimization.status === "pending" ||
    optimization.status === "processing"
  ) {
    return (
      <WaitingView
        optimization={optimization}
        orgSlug={orgSlug!}
        projectId={projectId}
      />
    );
  }

  if (optimization.status === "failed") {
    return (
      <ErrorView
        optimization={optimization}
        orgSlug={orgSlug!}
        projectId={projectId}
      />
    );
  }

  // Completed
  if (optimization.reviewStatus === "pending") {
    return (
      <ReviewView
        optimization={optimization}
        sourceVersion={sourceVersion}
        orgSlug={orgSlug!}
        projectId={projectId}
      />
    );
  }

  // Already reviewed
  return (
    <ResolvedView
      optimization={optimization}
      orgSlug={orgSlug!}
      projectId={projectId}
    />
  );
}

// --- Waiting View ---

function WaitingView({
  optimization,
  orgSlug,
  projectId,
}: {
  optimization: NonNullable<ReturnType<typeof useQuery<typeof api.optimize.getOptimization>>>;
  orgSlug: string;
  projectId: Id<"projects">;
}) {
  const cancelOptimization = useMutation(api.optimize.cancelOptimization);
  const [cancelling, setCancelling] = useState(false);

  const handleCancel = async () => {
    setCancelling(true);
    try {
      await cancelOptimization({
        requestId: optimization._id,
      });
    } catch {
      setCancelling(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-3">
          <Link
            to={`/orgs/${orgSlug}/projects/${projectId}/versions/${optimization.promptVersionId}`}
            className="text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <span className="text-sm font-medium">
            Optimizing version v{optimization.versionNumber ?? "?"}
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleCancel}
          disabled={cancelling || optimization.status !== "pending"}
        >
          <X className="mr-1.5 h-3.5 w-3.5" />
          Cancel
        </Button>
      </div>

      {/* Pulsing status */}
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-md w-full space-y-6 text-center">
          <div
            className={cn(
              "mx-auto rounded-xl border bg-card p-8 space-y-4",
              "animate-pulse",
            )}
            style={{
              animationDuration: "2s",
              animationTimingFunction: "ease-in-out",
            }}
          >
            <div className="mx-auto h-12 w-12 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
              <div className="h-6 w-6 rounded-full bg-blue-500 dark:bg-blue-400" />
            </div>
            <div>
              <p className="text-sm font-medium capitalize">
                {optimization.status === "pending"
                  ? "Queued"
                  : "Analyzing feedback..."}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                The optimizer is reading your feedback and proposing changes.
              </p>
            </div>
          </div>

          <div className="text-xs text-muted-foreground">
            <p>
              Requested by {optimization.requesterName ?? "—"} &middot;{" "}
              Model: {optimization.optimizerModel}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Error View ---

function ErrorView({
  optimization,
  orgSlug,
  projectId,
}: {
  optimization: NonNullable<ReturnType<typeof useQuery<typeof api.optimize.getOptimization>>>;
  orgSlug: string;
  projectId: Id<"projects">;
}) {
  const requestOptimization = useMutation(api.optimize.requestOptimization);
  const navigate = useNavigate();
  const [retrying, setRetrying] = useState(false);

  const handleRetry = async () => {
    setRetrying(true);
    try {
      const newId = await requestOptimization({
        versionId: optimization.promptVersionId,
      });
      navigate(
        `/orgs/${orgSlug}/projects/${projectId}/optimizations/${newId}`,
        { replace: true },
      );
    } catch (err) {
      setRetrying(false);
      // Error will be shown by the new request's error state
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <Link
          to={`/orgs/${orgSlug}/projects/${projectId}/versions/${optimization.promptVersionId}`}
          className="text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <span className="text-sm font-medium">
          Optimization failed &middot; Version v
          {optimization.versionNumber ?? "?"}
        </span>
      </div>

      {/* Error content */}
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-md w-full space-y-4 text-center">
          <div className="mx-auto h-12 w-12 rounded-full bg-destructive/10 flex items-center justify-center">
            <AlertCircle className="h-6 w-6 text-destructive" />
          </div>
          <p className="text-sm font-medium">Optimization failed</p>
          <p className="text-sm text-muted-foreground">
            {optimization.errorMessage ?? "An unknown error occurred."}
          </p>
          <Button onClick={handleRetry} disabled={retrying}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            {retrying ? "Retrying..." : "Try again"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// --- Review View ---

function ReviewView({
  optimization,
  sourceVersion,
  orgSlug,
  projectId,
}: {
  optimization: NonNullable<ReturnType<typeof useQuery<typeof api.optimize.getOptimization>>>;
  sourceVersion: ReturnType<typeof useQuery<typeof api.versions.get>>;
  orgSlug: string;
  projectId: Id<"projects">;
}) {
  const navigate = useNavigate();
  const acceptOptimization = useMutation(api.optimize.acceptOptimization);
  const rejectOptimization = useMutation(api.optimize.rejectOptimization);
  const editAndAccept = useMutation(
    api.optimize.editAndAcceptOptimization,
  );

  const [saving, setSaving] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editedSystem, setEditedSystem] = useState(
    optimization.generatedSystemMessage ?? "",
  );
  const [editedTemplate, setEditedTemplate] = useState(
    optimization.generatedUserTemplate ?? "",
  );
  const [error, setError] = useState<string | null>(null);

  const handleAccept = async () => {
    setSaving(true);
    setError(null);
    try {
      const newVersionId = await acceptOptimization({
        requestId: optimization._id,
      });
      navigate(
        `/orgs/${orgSlug}/projects/${projectId}/versions/${newVersionId}`,
      );
    } catch (err) {
      setError(friendlyError(err));
      setSaving(false);
    }
  };

  const handleReject = async () => {
    setSaving(true);
    setError(null);
    try {
      await rejectOptimization({ requestId: optimization._id });
      navigate(`/orgs/${orgSlug}/projects/${projectId}/versions`);
    } catch (err) {
      setError(friendlyError(err));
      setSaving(false);
    }
  };

  const handleEditAndAccept = async () => {
    setSaving(true);
    setError(null);
    try {
      const newVersionId = await editAndAccept({
        requestId: optimization._id,
        systemMessage: editedSystem || undefined,
        userTemplate: editedTemplate,
      });
      navigate(
        `/orgs/${orgSlug}/projects/${projectId}/versions/${newVersionId}`,
      );
    } catch (err) {
      setError(friendlyError(err));
      setSaving(false);
    }
  };

  const oldSystem = sourceVersion?.systemMessage ?? "";
  const oldTemplate = sourceVersion?.userMessageTemplate ?? "";
  const newSystem = optimization.generatedSystemMessage ?? "";
  const newTemplate = optimization.generatedUserTemplate ?? "";

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <Link
          to={`/orgs/${orgSlug}/projects/${projectId}/versions/${optimization.promptVersionId}`}
          className="text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <span className="text-sm font-medium">
          Review optimization &middot; Version v
          {optimization.versionNumber ?? "?"}
        </span>
      </div>

      {/* Two-column content */}
      <div className="flex-1 overflow-auto">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 p-6 h-full">
          {/* Left: Diff */}
          <div className="lg:col-span-2 space-y-6 overflow-auto">
            {editMode ? (
              <EditView
                editedSystem={editedSystem}
                editedTemplate={editedTemplate}
                onSystemChange={setEditedSystem}
                onTemplateChange={setEditedTemplate}
              />
            ) : (
              <>
                {(oldSystem || newSystem) && (
                  <PromptDiff
                    oldText={oldSystem}
                    newText={newSystem}
                    label="System message"
                  />
                )}
                <PromptDiff
                  oldText={oldTemplate}
                  newText={newTemplate}
                  label="User template"
                />
              </>
            )}
          </div>

          {/* Right: Changes panel */}
          <div className="overflow-auto">
            <ChangesPanel
              changesSummary={optimization.changesSummary ?? ""}
              changesReasoning={optimization.changesReasoning ?? ""}
            />
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="px-6 py-2 bg-destructive/10 border-t">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {/* Action bar */}
      <div className="flex items-center justify-end gap-3 border-t px-6 py-3">
        <Button
          variant="outline"
          onClick={handleReject}
          disabled={saving}
        >
          <X className="mr-1.5 h-3.5 w-3.5" />
          Reject
        </Button>
        {editMode ? (
          <>
            <Button
              variant="outline"
              onClick={() => setEditMode(false)}
              disabled={saving}
            >
              Cancel edit
            </Button>
            <Button onClick={handleEditAndAccept} disabled={saving}>
              <Check className="mr-1.5 h-3.5 w-3.5" />
              {saving ? "Saving..." : "Save and accept"}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              onClick={() => setEditMode(true)}
              disabled={saving}
            >
              <Pencil className="mr-1.5 h-3.5 w-3.5" />
              Edit and accept
            </Button>
            <Button onClick={handleAccept} disabled={saving}>
              <Check className="mr-1.5 h-3.5 w-3.5" />
              {saving ? "Accepting..." : "Accept"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function EditView({
  editedSystem,
  editedTemplate,
  onSystemChange,
  onTemplateChange,
}: {
  editedSystem: string;
  editedTemplate: string;
  onSystemChange: (v: string) => void;
  onTemplateChange: (v: string) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label className="text-sm">System message</Label>
        <Textarea
          value={editedSystem}
          onChange={(e) => onSystemChange(e.target.value)}
          placeholder="Optional system message..."
          className="min-h-[120px] font-mono text-sm"
        />
      </div>
      <div className="space-y-2">
        <Label className="text-sm">User template</Label>
        <Textarea
          value={editedTemplate}
          onChange={(e) => onTemplateChange(e.target.value)}
          placeholder="User message template..."
          className="min-h-[200px] font-mono text-sm"
        />
      </div>
    </div>
  );
}

// --- Resolved View ---

function ResolvedView({
  optimization,
  orgSlug,
  projectId,
}: {
  optimization: NonNullable<ReturnType<typeof useQuery<typeof api.optimize.getOptimization>>>;
  orgSlug: string;
  projectId: Id<"projects">;
}) {
  const reviewStatusConfig: Record<
    string,
    {
      label: string;
      icon: React.ComponentType<{ className?: string }>;
      style: string;
    }
  > = {
    accepted: {
      label: "Accepted",
      icon: CheckCircle2,
      style: "text-green-700 dark:text-green-400",
    },
    rejected: {
      label: "Rejected",
      icon: XCircle,
      style: "text-red-600 dark:text-red-400",
    },
    edited: {
      label: "Edited and accepted",
      icon: Pencil,
      style: "text-blue-600 dark:text-blue-400",
    },
  };

  const status = optimization.reviewStatus ?? "pending";
  const config = reviewStatusConfig[status];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <Link
          to={`/orgs/${orgSlug}/projects/${projectId}/versions/${optimization.promptVersionId}`}
          className="text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <span className="text-sm font-medium">
          Optimization &middot; Version v{optimization.versionNumber ?? "?"}
        </span>
        {config && (
          <Badge variant="outline" className={cn("gap-1", config.style)}>
            <config.icon className="h-3 w-3" />
            {config.label}
          </Badge>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-2xl mx-auto space-y-6">
          <div className="text-sm text-muted-foreground">
            <p>
              Reviewed{" "}
              {optimization.reviewedAt
                ? new Date(optimization.reviewedAt).toLocaleString()
                : "—"}
            </p>
            {optimization.reviewNotes && (
              <p className="mt-2 italic">{optimization.reviewNotes}</p>
            )}
          </div>

          {optimization.changesSummary && (
            <ChangesPanel
              changesSummary={optimization.changesSummary}
              changesReasoning={optimization.changesReasoning ?? ""}
            />
          )}

          <div className="flex gap-3">
            {optimization.resultingVersionId && (
              <Link
                to={`/orgs/${orgSlug}/projects/${projectId}/versions/${optimization.resultingVersionId}`}
                className="inline-flex items-center rounded-md border px-3 py-1.5 text-sm hover:bg-muted/50 transition-colors"
              >
                View resulting version
              </Link>
            )}
            <Link
              to={`/orgs/${orgSlug}/projects/${projectId}/versions`}
              className="inline-flex items-center rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted/50 transition-colors"
            >
              Back to versions
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
