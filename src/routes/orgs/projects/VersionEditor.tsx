import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useQuery, useMutation } from "convex/react";
import {
  useParams,
  Link,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { api } from "../../../../convex/_generated/api";
import { Id, Doc } from "../../../../convex/_generated/dataModel";
import { toast } from "sonner";
import { useProject } from "@/contexts/ProjectContext";
import { MessageComposer } from "@/components/prompt/MessageComposer";
import { type Annotation } from "@/components/tiptap/AnnotatedEditor";
import { detectVariables } from "@/lib/detectVariables";
import {
  readVersionMessages,
  getMessageText,
  type PromptMessage,
  type PromptMessageRole,
} from "@/lib/promptMessages";
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
import { VersionFeedbackContent } from "./cycles/VersionDashboard";
import { VersionRunsTab } from "./cycles/VersionRunsTab";

export function VersionEditor() {
  const {
    projectId,
    project,
    role: projectRole,
    blindMode,
  } = useProject();
  // M26: non-blind reviewers (PM / legal / domain expert) read the prompt and
  // annotate it, but never edit, run, fork, or trigger optimization.
  const isNonBlindReviewer =
    projectRole === "evaluator" && blindMode === false;
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
  // Skip editor-only queries for non-blind reviewers — they don't see the
  // sidebar where these would render and these endpoints are gated to
  // owner/editor anyway.
  const isReviewerSkip = isNonBlindReviewer ? "skip" : undefined;
  const variables = useQuery(
    api.variables.list,
    isReviewerSkip ?? { projectId },
  );
  const recentRuns = useQuery(
    api.runs.list,
    !isNonBlindReviewer && versionId
      ? { versionId: versionId as Id<"promptVersions"> }
      : "skip",
  );
  const attachments = useQuery(
    api.attachments.list,
    !isNonBlindReviewer && versionId
      ? { versionId: versionId as Id<"promptVersions"> }
      : "skip",
  );

  const navigate = useNavigate();
  const updateVersion = useMutation(api.versions.update);
  const forkVersion = useMutation(api.versions.fork);
  const generateUploadUrl = useMutation(api.attachments.generateUploadUrl);
  const registerUploaded = useMutation(api.attachments.registerUploaded);
  const deleteAttachment = useMutation(api.attachments.deleteAttachment);

  const [messages, setMessages] = useState<PromptMessage[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [addVarOpen, setAddVarOpen] = useState(false);

  // Non-blind reviewers always have the annotation overlay on — that's their
  // primary action. Editors toggle it.
  const [feedbackMode, setFeedbackMode] = useState(false);
  const effectiveFeedbackMode = isNonBlindReviewer || feedbackMode;

  // Tab state — URL-driven so deep links and back button work
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab");

  // Optimization queries — author/editor concern, hidden from reviewers.
  const feedbackCount = useQuery(
    api.optimize.countFeedbackForVersion,
    !isNonBlindReviewer && versionId
      ? { versionId: versionId as Id<"promptVersions"> }
      : "skip",
  );
  const activeOptimization = useQuery(
    api.optimize.getActiveOptimization,
    isNonBlindReviewer ? "skip" : { projectId },
  );
  const [optimizeDialogOpen, setOptimizeDialogOpen] = useState(false);

  // Meta context — owner-only mutation; reviewers never see this section.
  const metaContext = useQuery(
    api.projects.getMetaContext,
    isNonBlindReviewer ? "skip" : { projectId },
  );
  const setMetaContextMut = useMutation(api.projects.setMetaContext);
  const [metaExpanded, setMetaExpanded] = useState(false);

  // Cycle integration — owner/editor concern.
  const cycleData = useQuery(
    api.reviewCycles.hasDataForVersion,
    !isNonBlindReviewer && versionId
      ? { versionId: versionId as Id<"promptVersions"> }
      : "skip",
  );

  // Default to Feedback when the version has cycle activity; otherwise Prompt
  const defaultTab: "prompt" | "feedback" | "runs" = cycleData?.hasCycle
    ? "feedback"
    : "prompt";
  const activeTab: "prompt" | "feedback" | "runs" =
    requestedTab === "feedback" ||
    requestedTab === "runs" ||
    requestedTab === "prompt"
      ? requestedTab
      : defaultTab;
  const switchTab = useCallback(
    (tab: "prompt" | "feedback" | "runs") => {
      const next = new URLSearchParams(searchParams);
      next.set("tab", tab);
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  // Prompt feedback queries (only when viewing feedback)
  const promptFeedback = useQuery(
    api.feedback.listPromptFeedback,
    effectiveFeedbackMode && versionId
      ? { promptVersionId: versionId as Id<"promptVersions"> }
      : "skip",
  );
  const addPromptFeedback = useMutation(api.feedback.addPromptFeedback);
  const updatePromptFeedback = useMutation(api.feedback.updatePromptFeedback);
  const deletePromptFeedback = useMutation(api.feedback.deletePromptFeedback);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const isDraft = version?.status === "draft";
  // Existing read-only path (status != "draft") + M26 non-blind reviewer path
  // collapsed into one flag so MessageComposer / save / fork / run all flow
  // through the same gate.
  const isReadOnly = !isDraft || isNonBlindReviewer;

  // Detect new variables across every authored message
  const existingVarNames = useMemo(
    () => new Set(variables?.map((v) => v.name) ?? []),
    [variables],
  );
  const newVarNames = useMemo(() => {
    const names = new Set<string>();
    for (const m of messages) {
      for (const name of detectVariables(getMessageText(m))) {
        names.add(name);
      }
    }
    return [...names].filter((name) => !existingVarNames.has(name));
  }, [messages, existingVarNames]);

  // Initialize form state when version loads — prefer authored messages[], fall
  // back to synthesizing from legacy fields for pre-M18 versions.
  useEffect(() => {
    if (!version) return;
    setMessages(readVersionMessages(version));
  }, [version?._id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = useCallback(async () => {
    if (!versionId || isReadOnly) return;
    setSaving(true);
    setError("");
    setSuccess(false);

    try {
      await updateVersion({
        versionId: versionId as Id<"promptVersions">,
        messages,
      });
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2000);
    } catch (err) {
      setError(friendlyError(err, "Failed to save version."));
    } finally {
      setSaving(false);
    }
  }, [versionId, isReadOnly, messages, updateVersion]);

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

  // Reviewers don't fetch variables (skipped); only block on it for editors.
  if (
    version === undefined ||
    (!isNonBlindReviewer && variables === undefined)
  ) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-6 w-32" />
        <div className="flex gap-4">
          <Skeleton className="hidden lg:block w-[22%] h-96" />
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
            to={
              isNonBlindReviewer
                ? `/review/${projectId}`
                : `/orgs/${orgSlug}/projects/${projectId}/versions`
            }
            className="text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          {isNonBlindReviewer ? (
            <span className="text-sm font-medium">
              {project.name} &middot; Latest draft
            </span>
          ) : (
            <>
              <span className="text-sm font-medium">
                Version {version.versionNumber}
              </span>
              <VersionStatusPill status={version.status} />
              {version.sourceVersionId && (
                <ProvenanceBadge sourceVersionId={version.sourceVersionId} />
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Author actions — hidden for reviewers */}
          {!isNonBlindReviewer && (
            <Link
              to={`/orgs/${orgSlug}/projects/${projectId}/run?versionId=${versionId}`}
              className={cn(buttonVariants({ variant: "default", size: "sm" }), "gap-1.5")}
            >
              <Play className="h-3.5 w-3.5" />
              Run
            </Link>
          )}
          {!isNonBlindReviewer && isDraft && (
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
          {!isNonBlindReviewer && isReadOnly && (
            <>
              <Button
                size="sm"
                onClick={handleFork}
                disabled={saving}
              >
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Edit (creates new version)
              </Button>
              {activeTab === "prompt" && (
                <Button
                  variant={feedbackMode ? "secondary" : "outline"}
                  size="sm"
                  onClick={() => setFeedbackMode(!feedbackMode)}
                >
                  <MessageSquare className="mr-1.5 h-3.5 w-3.5" />
                  {feedbackMode ? "Back to viewing" : "Annotate prompt"}
                </Button>
              )}
              <span className="text-xs text-muted-foreground">
                Read-only
              </span>
            </>
          )}
          {/* Reviewer pseudo-status — communicates "you're here to comment" */}
          {isNonBlindReviewer && (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <MessageSquare className="h-3.5 w-3.5" />
              Annotate to leave feedback
            </span>
          )}
        </div>
      </div>

      {/* Tab strip — Feedback / Runs are author concerns; reviewers stay on
          a single Prompt view. */}
      {!isNonBlindReviewer && (
        <div className="flex items-center gap-1 border-b px-4">
          <TabButton
            label="Prompt"
            active={activeTab === "prompt"}
            onClick={() => switchTab("prompt")}
          />
          <TabButton
            label="Feedback"
            count={feedbackCount?.total}
            active={activeTab === "feedback"}
            onClick={() => switchTab("feedback")}
          />
          <TabButton
            label="Runs"
            count={recentRuns?.length}
            active={activeTab === "runs"}
            onClick={() => switchTab("runs")}
          />
        </div>
      )}

      {/* Status messages */}
      {error && (
        <div className="px-4 py-2 bg-destructive/10 border-b">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}
      {success && (
        <div className="px-4 py-2 bg-sky-50 dark:bg-sky-950/30 border-b">
          <p className="text-sm text-sky-700 dark:text-sky-300">Saved successfully.</p>
        </div>
      )}

      {/* Blind eval explanation — only on Prompt tab to keep other tabs clean.
          Hidden for non-blind reviewers (this copy is for editors deciding
          whether to send their work out for evaluation). */}
      {activeTab === "prompt" && !isNonBlindReviewer && (
        <OnboardingCallout
          calloutKey="onboarding_blind_eval"
          className="mx-4 mt-2"
        >
          Each run generates 3 outputs labeled A, B, C from the same model. The
          variation helps you spot inconsistencies. Share runs with evaluators
          who see only the blind labels — no version info.
        </OnboardingCallout>
      )}

      {/* Feedback tab */}
      {activeTab === "feedback" && (
        <div className="flex-1 overflow-y-auto p-6">
          <VersionFeedbackContent
            versionId={versionId as Id<"promptVersions">}
            orgSlug={orgSlug}
            projectId={projectId}
          />
        </div>
      )}

      {/* Runs tab */}
      {activeTab === "runs" && (
        <div className="flex-1 overflow-y-auto p-6">
          <VersionRunsTab
            versionId={versionId as Id<"promptVersions">}
            orgSlug={orgSlug}
            projectId={projectId}
          />
        </div>
      )}

      {/* Prompt tab — original two-column layout */}
      {activeTab === "prompt" && (
      <div className="flex flex-1 overflow-hidden">
        {/* Left — Sidebar (desktop only; hidden below lg to give the editor room on mobile).
            M26: hidden entirely for non-blind reviewers — variables, runs,
            optimization, and meta context are all author-only concerns. */}
        {!isNonBlindReviewer && (
        <div className="hidden lg:flex lg:w-[22%] lg:min-w-[220px] flex-col border-r overflow-y-auto p-3 space-y-4">
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
            {(variables ?? []).length === 0 ? (
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
                {(variables ?? []).map((v) => (
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
        )}

        {/* Center — Message composer + attachments */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label className="text-sm font-medium">
                {isNonBlindReviewer ? "Instructions" : "Messages"}
              </Label>
            </div>
            {!isNonBlindReviewer && (
              <OnboardingCallout
                calloutKey="onboarding_write_template"
                prerequisiteDismissed="onboarding_add_variable"
                className="mb-2"
              >
                Author the turns you want sent to the LLM. Use {"{{variableName}}"}{" "}
                anywhere — Blind Bench substitutes values per test case.
              </OnboardingCallout>
            )}
            {isNonBlindReviewer && (
              <p className="mb-3 rounded-md border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                Highlight any text below and add a comment to leave feedback for
                the author. Your feedback shapes the next draft.
              </p>
            )}
            <MessageComposer
              messages={messages}
              onChange={setMessages}
              readOnly={isReadOnly}
              feedbackMode={effectiveFeedbackMode}
              annotationsByMessageId={groupAnnotationsByMessage(
                promptFeedback,
                messages,
              )}
              onCreateAnnotation={(messageId, from, to, highlightedText, comment) => {
                void addPromptFeedback({
                  promptVersionId: versionId as Id<"promptVersions">,
                  messageId,
                  annotationData: { from, to, highlightedText, comment },
                }).then(() => {
                  // M26: close the "did my feedback land?" loop for non-blind
                  // reviewers. Editors don't need this — they see their own
                  // feedback on their own draft and can act on it directly.
                  if (isNonBlindReviewer) {
                    toast.success(
                      "Feedback submitted. The author will be notified, and you'll get an email when an improved draft is ready.",
                    );
                  }
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
      )}

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

type PromptFeedbackRow = {
  _id: string;
  target?: { kind: "message"; messageId: string };
  targetField?: "system_message" | "user_message_template";
  annotationData: {
    from: number;
    to: number;
    highlightedText: string;
    comment: string;
  };
  authorName?: string | null;
  isOwn?: boolean;
};

// Partition prompt feedback rows across the current message list by their
// messageId anchor, falling back to the legacy targetField slot so pre-M18
// feedback still lights up even before the backfill runs.
function groupAnnotationsByMessage(
  feedback: PromptFeedbackRow[] | undefined,
  messages: PromptMessage[],
): Record<string, Annotation[]> {
  const out: Record<string, Annotation[]> = {};
  if (!feedback) return out;

  const firstByRole = (roles: PromptMessageRole[]): string | undefined =>
    messages.find((m) => roles.includes(m.role))?.id;

  for (const fb of feedback) {
    let messageId = fb.target?.messageId;
    if (!messageId) {
      if (fb.targetField === "system_message") {
        messageId = firstByRole(["system", "developer"]);
      } else if (fb.targetField === "user_message_template") {
        messageId = firstByRole(["user"]);
      }
    }
    if (!messageId) continue;
    if (!messages.some((m) => m.id === messageId)) continue;
    const list = out[messageId] ?? (out[messageId] = []);
    list.push({
      _id: fb._id,
      from: fb.annotationData.from,
      to: fb.annotationData.to,
      highlightedText: fb.annotationData.highlightedText,
      comment: fb.annotationData.comment,
      authorName: fb.authorName ?? undefined,
      isOwn: fb.isOwn,
    });
  }
  return out;
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

// ---------------------------------------------------------------------------
// TabButton — tab strip button with optional count badge
// ---------------------------------------------------------------------------

function TabButton({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "relative px-3 py-2 text-sm font-medium transition-colors border-b-2 -mb-px",
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
      {typeof count === "number" && count > 0 && (
        <span
          className={cn(
            "ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-mono",
            active
              ? "bg-primary/10 text-primary"
              : "bg-muted text-muted-foreground",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}
