import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useQuery, useMutation } from "convex/react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { api } from "../../../../convex/_generated/api";
import { Id, Doc } from "../../../../convex/_generated/dataModel";
import { useProject } from "@/contexts/ProjectContext";
import { PromptEditor } from "@/components/tiptap/PromptEditor";
import { AnnotatedEditor } from "@/components/tiptap/AnnotatedEditor";
import { detectVariables } from "@/lib/detectVariables";
import { AddVariableDialog } from "@/components/AddVariableDialog";
import { VersionStatusPill } from "@/components/VersionStatusPill";
import { RunStatusPill } from "@/components/RunStatusPill";
import { OptimizeConfirmationDialog } from "@/components/OptimizeConfirmationDialog";
import { AttachmentCard } from "@/components/AttachmentCard";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { friendlyError } from "@/lib/errors";
import { stripExif } from "@/lib/stripExif";
import {
  ArrowLeft,
  BarChart3,
  ChevronDown,
  ChevronRight,
  GitPullRequestArrow,
  MessageSquare,
  Paperclip,
  Play,
  Plus,
  Save,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { OnboardingCallout } from "@/components/OnboardingCallout";

export function VersionEditor() {
  const { projectId, project, role: projectRole } = useProject();
  const { orgSlug, versionId } = useParams<{
    orgSlug: string;
    versionId: string;
  }>();
  const version = useQuery(
    api.versions.get,
    versionId
      ? { versionId: versionId as Id<"promptVersions"> }
      : "skip",
  );
  const variables = useQuery(api.variables.list, { projectId });
  const recentRuns = useQuery(
    api.runs.list,
    versionId
      ? { versionId: versionId as Id<"promptVersions"> }
      : "skip",
  );
  const attachments = useQuery(
    api.attachments.list,
    versionId
      ? { versionId: versionId as Id<"promptVersions"> }
      : "skip",
  );

  const navigate = useNavigate();
  const updateVersion = useMutation(api.versions.update);
  const forkVersion = useMutation(api.versions.fork);
  const generateUploadUrl = useMutation(api.attachments.generateUploadUrl);
  const registerUploaded = useMutation(api.attachments.registerUploaded);
  const deleteAttachment = useMutation(api.attachments.deleteAttachment);

  const [systemMessage, setSystemMessage] = useState("");
  const [userTemplate, setUserTemplate] = useState("");
  const [systemExpanded, setSystemExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [addVarOpen, setAddVarOpen] = useState(false);

  const [feedbackMode, setFeedbackMode] = useState(false);

  // Optimization queries
  const feedbackCount = useQuery(
    api.optimize.countFeedbackForVersion,
    versionId
      ? { versionId: versionId as Id<"promptVersions"> }
      : "skip",
  );
  const activeOptimization = useQuery(
    api.optimize.getActiveOptimization,
    { projectId },
  );
  const [optimizeDialogOpen, setOptimizeDialogOpen] = useState(false);

  // Meta context
  const metaContext = useQuery(api.projects.getMetaContext, { projectId });
  const setMetaContextMut = useMutation(api.projects.setMetaContext);
  const [metaExpanded, setMetaExpanded] = useState(false);

  // Cycle integration
  const cycleData = useQuery(
    api.reviewCycles.hasDataForVersion,
    versionId
      ? { versionId: versionId as Id<"promptVersions"> }
      : "skip",
  );

  // Prompt feedback queries (only when viewing feedback)
  const promptFeedback = useQuery(
    api.feedback.listPromptFeedback,
    feedbackMode && versionId
      ? { promptVersionId: versionId as Id<"promptVersions"> }
      : "skip",
  );
  const addPromptFeedback = useMutation(api.feedback.addPromptFeedback);
  const updatePromptFeedback = useMutation(api.feedback.updatePromptFeedback);
  const deletePromptFeedback = useMutation(api.feedback.deletePromptFeedback);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const isDraft = version?.status === "draft";
  const isReadOnly = !isDraft;

  // Detect new variables in the editor content
  const existingVarNames = useMemo(
    () => new Set(variables?.map((v) => v.name) ?? []),
    [variables],
  );
  const newVarNames = useMemo(() => {
    const fromUser = detectVariables(userTemplate);
    const fromSystem = detectVariables(systemMessage);
    return [...new Set([...fromUser, ...fromSystem])].filter(
      (name) => !existingVarNames.has(name),
    );
  }, [userTemplate, systemMessage, existingVarNames]);

  // Initialize form state when version loads
  useEffect(() => {
    if (!version) return;
    setSystemMessage(version.systemMessage ?? "");
    setUserTemplate(version.userMessageTemplate ?? "");
    setSystemExpanded(!!version.systemMessage);
  }, [version?._id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = useCallback(async () => {
    if (!versionId || isReadOnly) return;
    setSaving(true);
    setError("");
    setSuccess(false);
    try {
      await updateVersion({
        versionId: versionId as Id<"promptVersions">,
        systemMessage: systemMessage || undefined,
        userMessageTemplate: userTemplate,
      });
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2000);
    } catch (err) {
      setError(friendlyError(err, "Failed to save version."));
    } finally {
      setSaving(false);
    }
  }, [versionId, isReadOnly, systemMessage, userTemplate, updateVersion]);

  // Cmd+S / Cmd+Enter to save, Cmd+R to optimize
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "Enter")) {
        e.preventDefault();
        handleSave();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "r") {
        e.preventDefault();
        if (feedbackCount && feedbackCount.total > 0) {
          setOptimizeDialogOpen(true);
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleSave, feedbackCount]);

  async function handleFork() {
    if (!versionId) return;
    setSaving(true);
    setError("");
    try {
      const newVersionId = await forkVersion({
        sourceVersionId: versionId as Id<"promptVersions">,
      });
      navigate(
        `/orgs/${orgSlug}/projects/${projectId}/versions/${newVersionId}`,
      );
    } catch (err) {
      setError(friendlyError(err, "Failed to create new version."));
    } finally {
      setSaving(false);
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    if (!versionId || !e.target.files?.length) return;
    setError("");

    for (const file of Array.from(e.target.files)) {
      try {
        // Strip EXIF from images
        const blob = await stripExif(file);

        // Get upload URL
        const uploadUrl = await generateUploadUrl({
          versionId: versionId as Id<"promptVersions">,
        });

        // Upload the file
        const res = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": file.type },
          body: blob,
        });
        if (!res.ok) throw new Error("Upload failed");
        const { storageId } = (await res.json()) as {
          storageId: Id<"_storage">;
        };

        // Register
        await registerUploaded({
          versionId: versionId as Id<"promptVersions">,
          storageId,
          filename: file.name,
          mimeType: file.type,
          sizeBytes: blob.size,
        });
      } catch (err) {
        setError(
          friendlyError(err, `Failed to upload ${file.name}.`),
        );
      }
    }

    // Reset file input
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  if (version === undefined || variables === undefined) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-6 w-32" />
        <div className="flex gap-4">
          <Skeleton className="w-[22%] h-96" />
          <Skeleton className="flex-1 h-96" />
        </div>
      </div>
    );
  }

  if (version === null) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">Version not found.</p>
        <Link
          to={`/orgs/${orgSlug}/projects/${projectId}/versions`}
          className="text-sm text-primary hover:underline mt-2 inline-block"
        >
          Back to versions
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Top bar */}
      <div className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-3">
          <Link
            to={`/orgs/${orgSlug}/projects/${projectId}/versions`}
            className="text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <span className="text-sm font-medium">
            Version {version.versionNumber}
          </span>
          <VersionStatusPill status={version.status} />
          {version.sourceVersionId && (
            <ProvenanceBadge sourceVersionId={version.sourceVersionId} />
          )}
        </div>
        <div className="flex items-center gap-2">
          <Link
            to={`/orgs/${orgSlug}/projects/${projectId}/run?versionId=${versionId}`}
            className={cn(buttonVariants({ variant: "default", size: "sm" }), "gap-1.5")}
          >
            <Play className="h-3.5 w-3.5" />
            Run
          </Link>
          {isDraft && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={handleSave}
                disabled={saving}
              >
                <Save className="mr-1.5 h-3.5 w-3.5" />
                {saving ? "Saving..." : "Save"}
                {!saving && (
                  <kbd className="ml-1.5 rounded border bg-background/50 px-1 py-0.5 text-[10px] font-mono opacity-60">
                    ⌘S
                  </kbd>
                )}
              </Button>
            </>
          )}
          {isReadOnly && (
            <>
              <Button
                size="sm"
                onClick={handleFork}
                disabled={saving}
              >
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Edit (creates new version)
              </Button>
              <Button
                variant={feedbackMode ? "secondary" : "outline"}
                size="sm"
                onClick={() => setFeedbackMode(!feedbackMode)}
              >
                <MessageSquare className="mr-1.5 h-3.5 w-3.5" />
                {feedbackMode ? "Back to viewing" : "View feedback"}
              </Button>
              <span className="text-xs text-muted-foreground">
                Read-only
              </span>
            </>
          )}
        </div>
      </div>

      {/* Status messages */}
      {error && (
        <div className="px-4 py-2 bg-destructive/10 border-b">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}
      {success && (
        <div className="px-4 py-2 bg-green-50 dark:bg-green-900/10 border-b">
          <p className="text-sm text-green-600">Saved successfully.</p>
        </div>
      )}

      {/* Blind eval explanation */}
      <OnboardingCallout calloutKey="onboarding_blind_eval" className="mx-4 mt-2">
        Each run generates 3 outputs labeled A, B, C from the same model. The
        variation helps you spot inconsistencies. Share runs with evaluators who
        see only the blind labels — no version info.
      </OnboardingCallout>

      {/* Two-column layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left — Sidebar */}
        <div className="w-[22%] min-w-[220px] border-r overflow-y-auto p-3 space-y-4">
          {/* Variables */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-medium uppercase text-muted-foreground">
                Variables
              </h3>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setAddVarOpen(true)}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
            {variables.length === 0 ? (
              <div className="space-y-1.5">
                <OnboardingCallout calloutKey="onboarding_add_variable">
                  Define a variable like {"{{name}}"} to make your prompt
                  reusable across different test cases.
                </OnboardingCallout>
                <p className="text-xs text-muted-foreground">
                  Variables are placeholders in your prompt. Use {"{{name}}"}
                  syntax in your template.
                </p>
                <Link
                  to={`/orgs/${orgSlug}/projects/${projectId}/variables`}
                  className="text-xs text-primary hover:underline"
                >
                  Manage variables
                </Link>
              </div>
            ) : (
              <div className="space-y-1">
                {variables.map((v) => (
                  <VariableSidebarItem key={v._id} variable={v} />
                ))}
              </div>
            )}
          </div>

          {/* Cycle CTA (primary when completed runs exist) */}
          {cycleData?.hasCompletedRun && (
            <Link
              to={`/orgs/${orgSlug}/projects/${projectId}/cycles/new?primaryVersionId=${versionId}`}
              className={cn(buttonVariants({ size: "sm" }), "w-full gap-1.5")}
            >
              <GitPullRequestArrow className="h-3.5 w-3.5" />
              Start Review Cycle
            </Link>
          )}

          {/* Dashboard link */}
          {cycleData?.hasCycle && (
            <Link
              to={`/orgs/${orgSlug}/projects/${projectId}/versions/${versionId}/dashboard`}
              className={cn(buttonVariants({ variant: "outline", size: "sm" }), "w-full gap-1.5")}
            >
              <BarChart3 className="h-3.5 w-3.5" />
              View Dashboard
            </Link>
          )}

          {/* Run CTA */}
          <Link
            to={`/orgs/${orgSlug}/projects/${projectId}/run?versionId=${versionId}`}
            className={cn(buttonVariants({ variant: cycleData?.hasCompletedRun ? "outline" : "default", size: "sm" }), "w-full gap-1.5")}
          >
            <Play className="h-3.5 w-3.5" />
            Run this version
          </Link>

          {/* Recent runs */}
          {recentRuns && recentRuns.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-muted-foreground">
                Recent runs
              </h4>
              {recentRuns.slice(0, 3).map((run) => (
                <Link
                  key={run._id}
                  to={`/orgs/${orgSlug}/projects/${projectId}/runs/${run._id}`}
                  className="flex items-center justify-between rounded-md border px-2 py-1.5 text-xs hover:bg-muted/50 transition-colors"
                >
                  <span className="text-muted-foreground">
                    {new Date(run._creationTime).toLocaleTimeString()}
                  </span>
                  <RunStatusPill status={run.status} />
                </Link>
              ))}
            </div>
          )}

          {/* Optimization */}
          <div className="space-y-2 pt-2 border-t">
            <h4 className="text-xs font-medium text-muted-foreground">
              Optimize
            </h4>
            {feedbackCount && feedbackCount.total > 0 ? (
              <Button
                variant="outline"
                className="w-full"
                size="sm"
                onClick={() => setOptimizeDialogOpen(true)}
              >
                <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                Request optimization
              </Button>
            ) : (
              <Tooltip>
                <TooltipTrigger className="w-full">
                  <Button
                    variant="outline"
                    className="w-full"
                    size="sm"
                    disabled
                  >
                    <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                    Request optimization
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  Add feedback on this version first.
                </TooltipContent>
              </Tooltip>
            )}
            {activeOptimization && (
              <Link
                to={`/orgs/${orgSlug}/projects/${projectId}/optimizations/${activeOptimization._id}`}
                className="block text-center text-xs text-primary hover:underline"
              >
                View in-progress optimization
              </Link>
            )}
            {feedbackCount && feedbackCount.total > 0 && (
              <p className="text-[10px] text-muted-foreground text-center">
                {feedbackCount.total} feedback{" "}
                {feedbackCount.total === 1 ? "item" : "items"} available
                &middot; {"\u2318"}R
              </p>
            )}
          </div>

          {/* Meta Context */}
          <MetaContextSection
            metaContext={metaContext ?? []}
            isOwner={projectRole === "owner"}
            expanded={metaExpanded}
            onToggle={() => setMetaExpanded((p) => !p)}
            onSave={async (pairs) => {
              await setMetaContextMut({ projectId, metaContext: pairs });
            }}
          />
        </div>

        {/* Center — Prompt editors + attachments */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* System message (collapsible) */}
          <div>
            <button
              className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
              onClick={() => setSystemExpanded(!systemExpanded)}
            >
              {systemExpanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
              System message
              <span className="text-xs font-normal">(optional)</span>
            </button>
            {systemExpanded && (
              <div className="mt-2 max-h-[400px] overflow-y-auto">
                {feedbackMode ? (
                  <AnnotatedEditor
                    content={systemMessage}
                    annotations={(promptFeedback ?? [])
                      .filter((fb) => fb.targetField === "system_message")
                      .map((fb) => ({
                        _id: fb._id as string,
                        from: fb.annotationData.from,
                        to: fb.annotationData.to,
                        highlightedText: fb.annotationData.highlightedText,
                        comment: fb.annotationData.comment,
                        authorName: fb.authorName ?? undefined,
                        isOwn: fb.isOwn,
                      }))}
                    canAnnotate={true}
                    onCreateAnnotation={(from, to, highlightedText, comment) => {
                      addPromptFeedback({
                        promptVersionId: versionId as Id<"promptVersions">,
                        targetField: "system_message",
                        annotationData: { from, to, highlightedText, comment },
                      });
                    }}
                    onUpdateAnnotation={(id, comment) => {
                      updatePromptFeedback({
                        feedbackId: id as Id<"promptFeedback">,
                        comment,
                      });
                    }}
                    onDeleteAnnotation={(id) => {
                      deletePromptFeedback({
                        feedbackId: id as Id<"promptFeedback">,
                      });
                    }}
                  />
                ) : (
                  <PromptEditor
                    content={systemMessage}
                    onChange={setSystemMessage}
                    readOnly={isReadOnly}
                    placeholder="You are a helpful assistant..."
                  />
                )}
              </div>
            )}
          </div>

          {/* User message template */}
          <div>
            <Label className="text-sm font-medium">
              User message template
            </Label>
            <OnboardingCallout
              calloutKey="onboarding_write_template"
              prerequisiteDismissed="onboarding_add_variable"
              className="mt-2"
            >
              Write your prompt here. Use {"{{variableName}}"} to insert
              variables. This is the message sent to the LLM.
            </OnboardingCallout>
            <div className="mt-2">
              {feedbackMode ? (
                <AnnotatedEditor
                  content={userTemplate}
                  annotations={(promptFeedback ?? [])
                    .filter((fb) => fb.targetField === "user_message_template")
                    .map((fb) => ({
                      _id: fb._id as string,
                      from: fb.annotationData.from,
                      to: fb.annotationData.to,
                      highlightedText: fb.annotationData.highlightedText,
                      comment: fb.annotationData.comment,
                      authorName: fb.authorName ?? undefined,
                      isOwn: fb.isOwn,
                    }))}
                  canAnnotate={true}
                  onCreateAnnotation={(from, to, highlightedText, comment) => {
                    addPromptFeedback({
                      promptVersionId: versionId as Id<"promptVersions">,
                      targetField: "user_message_template",
                      annotationData: { from, to, highlightedText, comment },
                    });
                  }}
                  onUpdateAnnotation={(id, comment) => {
                    updatePromptFeedback({
                      feedbackId: id as Id<"promptFeedback">,
                      comment,
                    });
                  }}
                  onDeleteAnnotation={(id) => {
                    deletePromptFeedback({
                      feedbackId: id as Id<"promptFeedback">,
                    });
                  }}
                />
              ) : (
                <PromptEditor
                  content={userTemplate}
                  onChange={setUserTemplate}
                  readOnly={isReadOnly}
                  placeholder="Hello {{customer_name}}, ..."
                />
              )}
            </div>
          </div>

          {/* New variable detection bar */}
          {isDraft && newVarNames.length > 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
              <span className="flex-1">
                New variables detected:{" "}
                {newVarNames.map((name) => (
                  <code
                    key={name}
                    className="mx-0.5 rounded bg-muted px-1 py-0.5 text-xs font-mono"
                  >
                    {`{{${name}}}`}
                  </code>
                ))}
                <span className="text-muted-foreground">
                  {" "}
                  — will be created on save
                </span>
              </span>
            </div>
          )}

          {/* Prompt attachments */}
          {isDraft && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">Attachments</Label>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  className="text-xs"
                >
                  <Paperclip className="mr-1 h-3.5 w-3.5" />
                  Add file
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="image/*,.pdf,.txt"
                  className="hidden"
                  onChange={handleFileUpload}
                />
              </div>
              {attachments && attachments.length > 0 && (
                <div className="space-y-1">
                  {attachments.map((a) => (
                    <AttachmentCard
                      key={a._id}
                      filename={a.filename}
                      mimeType={a.mimeType}
                      sizeBytes={a.sizeBytes}
                      url={a.url}
                      onDelete={() =>
                        deleteAttachment({ attachmentId: a._id })
                      }
                    />
                  ))}
                </div>
              )}
              {(!attachments || attachments.length === 0) && (
                <p className="text-xs text-muted-foreground">
                  Attach images for vision models. EXIF metadata is stripped
                  automatically.
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      <AddVariableDialog
        open={addVarOpen}
        onOpenChange={setAddVarOpen}
        projectId={projectId}
      />

      {version && feedbackCount && feedbackCount.total > 0 && (
        <OptimizeConfirmationDialog
          open={optimizeDialogOpen}
          onOpenChange={setOptimizeDialogOpen}
          versionId={version._id}
          versionNumber={version.versionNumber}
          feedbackCount={feedbackCount}
          hasMetaContext={!!(project.metaContext?.length)}
          orgSlug={orgSlug!}
          projectId={projectId}
        />
      )}
    </div>
  );
}

function ProvenanceBadge({
  sourceVersionId,
}: {
  sourceVersionId: Id<"promptVersions">;
}) {
  const sourceVersion = useQuery(api.versions.get, {
    versionId: sourceVersionId,
  });
  if (!sourceVersion) return null;
  return (
    <span className="text-xs text-muted-foreground italic">
      rolled back from v{sourceVersion.versionNumber}
    </span>
  );
}

function VariableSidebarItem({
  variable,
}: {
  variable: Doc<"projectVariables">;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        className={cn(
          "block w-full text-left rounded-md border px-2 py-1.5 text-xs cursor-default",
          "hover:bg-muted/50 transition-colors",
        )}
      >
        <div className="flex items-center justify-between">
          <span className="font-mono font-medium">{variable.name}</span>
          {variable.required && (
            <span className="text-[10px] text-destructive">req</span>
          )}
        </div>
        {variable.defaultValue && (
          <p className="text-muted-foreground truncate mt-0.5">
            Default: {variable.defaultValue}
          </p>
        )}
      </TooltipTrigger>
      <TooltipContent side="right">
        <p className="font-mono">{"{{" + variable.name + "}}"}</p>
        {variable.description && (
          <p className="text-xs text-muted-foreground mt-1">
            {variable.description}
          </p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// MetaContextSection — collapsible section in the sidebar
// ---------------------------------------------------------------------------

const SUGGESTED_META_QUESTIONS = [
  "What domain does this prompt operate in?",
  "What tone should the model use?",
  "Who is the end user?",
  "What should the model never do?",
];

function MetaContextSection({
  metaContext,
  isOwner,
  expanded,
  onToggle,
  onSave,
}: {
  metaContext: Array<{ id: string; question: string; answer: string }>;
  isOwner: boolean;
  expanded: boolean;
  onToggle: () => void;
  onSave: (pairs: Array<{ id: string; question: string; answer: string }>) => Promise<void>;
}) {
  const [localPairs, setLocalPairs] = useState<
    Array<{ id: string; question: string; answer: string }>
  >([]);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  // Sync from query when not editing
  useEffect(() => {
    if (!editing) {
      setLocalPairs(metaContext);
    }
  }, [metaContext, editing]);

  function startEditing() {
    setLocalPairs(metaContext);
    setEditing(true);
  }

  function addQuestion(question = "") {
    setLocalPairs((prev) => [
      ...prev,
      { id: crypto.randomUUID(), question, answer: "" },
    ]);
  }

  async function handleSave() {
    setSaving(true);
    try {
      await onSave(localPairs.filter((p) => p.question || p.answer));
      setEditing(false);
    } catch {
      // Error handled by parent mutation
    } finally {
      setSaving(false);
    }
  }

  const count = metaContext.length;

  return (
    <div className="space-y-2 pt-2 border-t">
      <button
        onClick={onToggle}
        className="flex items-center justify-between w-full text-left"
      >
        <h4 className="text-xs font-medium text-muted-foreground uppercase">
          Meta Context
        </h4>
        {expanded ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted-foreground" />
        )}
      </button>

      {!expanded && (
        <p className="text-[10px] text-muted-foreground">
          {count === 0
            ? "No context set"
            : `${count} question${count === 1 ? "" : "s"} answered`}
        </p>
      )}

      {expanded && (
        <div className="space-y-2">
          {editing ? (
            <>
              {localPairs.map((pair, i) => (
                <div key={pair.id} className="space-y-1 rounded border p-2">
                  <input
                    value={pair.question}
                    onChange={(e) => {
                      const updated = [...localPairs];
                      updated[i] = { ...pair, question: e.target.value };
                      setLocalPairs(updated);
                    }}
                    placeholder="Question"
                    className="w-full text-xs font-medium bg-transparent outline-none"
                  />
                  <textarea
                    value={pair.answer}
                    onChange={(e) => {
                      const updated = [...localPairs];
                      updated[i] = { ...pair, answer: e.target.value };
                      setLocalPairs(updated);
                    }}
                    placeholder="Answer..."
                    rows={2}
                    className="w-full text-xs bg-transparent outline-none resize-none"
                  />
                  <button
                    onClick={() =>
                      setLocalPairs((p) => p.filter((_, j) => j !== i))
                    }
                    className="text-[10px] text-destructive hover:underline"
                  >
                    Remove
                  </button>
                </div>
              ))}
              {/* Suggested questions */}
              {SUGGESTED_META_QUESTIONS.filter(
                (q) => !localPairs.some((p) => p.question === q),
              ).length > 0 && (
                <div className="space-y-0.5">
                  {SUGGESTED_META_QUESTIONS.filter(
                    (q) => !localPairs.some((p) => p.question === q),
                  ).map((q) => (
                    <button
                      key={q}
                      onClick={() => addQuestion(q)}
                      className="block w-full text-left text-[10px] text-muted-foreground hover:text-foreground px-1 py-0.5 rounded hover:bg-muted/50"
                    >
                      + {q}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex gap-1">
                <Button
                  size="xs"
                  onClick={handleSave}
                  disabled={saving}
                  className="flex-1"
                >
                  {saving ? "Saving..." : "Save"}
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => setEditing(false)}
                >
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <>
              {metaContext.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Add context about your prompt to help the optimizer understand
                  your goals.
                </p>
              ) : (
                metaContext.map((pair) => (
                  <div key={pair.id} className="text-xs space-y-0.5">
                    <p className="font-medium text-muted-foreground truncate">
                      {pair.question}
                    </p>
                    <p className="truncate">{pair.answer || "—"}</p>
                  </div>
                ))
              )}
              {isOwner && (
                <Button
                  variant="outline"
                  size="xs"
                  onClick={startEditing}
                  className="w-full"
                >
                  {metaContext.length === 0 ? "Add context" : "Edit"}
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
