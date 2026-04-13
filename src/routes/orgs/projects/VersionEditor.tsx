import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery, useMutation } from "convex/react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { api } from "../../../../convex/_generated/api";
import { Id, Doc } from "../../../../convex/_generated/dataModel";
import { useProject } from "@/contexts/ProjectContext";
import { useOrg } from "@/contexts/OrgContext";
import { PromptEditor } from "@/components/tiptap/PromptEditor";
import { AnnotatedEditor } from "@/components/tiptap/AnnotatedEditor";
import { AddVariableDialog } from "@/components/AddVariableDialog";
import { VersionStatusPill } from "@/components/VersionStatusPill";
import { RunStatusPill } from "@/components/RunStatusPill";
import { ModelPicker } from "@/components/ModelPicker";
import { SlotConfigurator, type SlotConfig } from "@/components/SlotConfigurator";
import { SuggestionCards } from "@/components/SuggestionCards";
import { ConcurrentRunGauge } from "@/components/ConcurrentRunGauge";
import { OptimizeConfirmationDialog } from "@/components/OptimizeConfirmationDialog";
import { useModelCatalog } from "@/hooks/useModelCatalog";
import { AttachmentCard } from "@/components/AttachmentCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  MessageSquare,
  Paperclip,
  Play,
  Plus,
  Save,
  Shield,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { OnboardingCallout } from "@/components/OnboardingCallout";

export function VersionEditor() {
  const { projectId, project } = useProject();
  const { orgId, role: orgRole } = useOrg();
  const { orgSlug, versionId } = useParams<{
    orgSlug: string;
    versionId: string;
  }>();
  const navigate = useNavigate();

  const version = useQuery(
    api.versions.get,
    versionId
      ? { versionId: versionId as Id<"promptVersions"> }
      : "skip",
  );
  const variables = useQuery(api.variables.list, { projectId });
  const testCases = useQuery(api.testCases.list, { projectId });
  const keyStatus = useQuery(api.openRouterKeys.hasKey, { orgId });
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

  const updateVersion = useMutation(api.versions.update);
  const promoteToActive = useMutation(api.versions.promoteToActive);
  const executeRun = useMutation(api.runs.execute);
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

  // Run config state
  const [selectedTestCaseId, setSelectedTestCaseId] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(1024);
  const [running, setRunning] = useState(false);

  // M8: Mix & Match state
  const [runMode, setRunMode] = useState<"uniform" | "mix">("uniform");
  const [slotConfigs, setSlotConfigs] = useState<SlotConfig[]>([
    { label: "A", model: "", temperature: 0.7 },
    { label: "B", model: "", temperature: 0.7 },
    { label: "C", model: "", temperature: 0.7 },
  ]);
  const { models: catalogModels } = useModelCatalog();

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

  // M8: AI suggestions
  const suggestions = useQuery(
    api.runAssistant.getSuggestions,
    versionId && runMode === "mix"
      ? { versionId: versionId as Id<"promptVersions"> }
      : "skip",
  );
  const requestSuggestions = useMutation(api.runAssistant.requestSuggestions);

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
  const hasAttachments =
    (attachments && attachments.length > 0) ||
    (selectedTestCaseId &&
      testCases?.find((tc) => tc._id === selectedTestCaseId)?.attachmentIds
        ?.length);

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

  const handleRun = useCallback(async () => {
    const isMix = runMode === "mix";
    const effectiveModel = isMix ? slotConfigs[0]?.model ?? "" : selectedModel;
    if (!versionId || !selectedTestCaseId || !effectiveModel || running) return;
    setRunning(true);
    setError("");
    try {
      const runId = await executeRun({
        versionId: versionId as Id<"promptVersions">,
        testCaseId: selectedTestCaseId as Id<"testCases">,
        model: effectiveModel,
        temperature: isMix ? slotConfigs[0]?.temperature ?? 0.7 : temperature,
        maxTokens,
        mode: isMix ? "mix" : undefined,
        slotConfigs: isMix ? slotConfigs : undefined,
      });
      navigate(
        `/orgs/${orgSlug}/projects/${projectId}/runs/${runId}`,
      );
    } catch (err) {
      setError(friendlyError(err, "Failed to start run."));
    } finally {
      setRunning(false);
    }
  }, [
    versionId,
    selectedTestCaseId,
    selectedModel,
    temperature,
    maxTokens,
    running,
    executeRun,
    navigate,
    orgSlug,
    projectId,
    runMode,
    slotConfigs,
  ]);

  // Cmd+S to save, Cmd+Enter to run
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleRun();
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
  }, [handleSave, handleRun, feedbackCount]);

  async function handlePromote() {
    if (!versionId) return;
    setSaving(true);
    setError("");
    try {
      await promoteToActive({
        versionId: versionId as Id<"promptVersions">,
      });
    } catch (err) {
      setError(friendlyError(err, "Failed to promote version."));
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

  // Determine run button disabled reason
  const runDisabledReason = (() => {
    if (!keyStatus?.hasKey) return "Set your OpenRouter key to run prompts.";
    if (!selectedTestCaseId) return "Select a test case to run this prompt.";
    if (runMode === "mix") {
      const missingModel = slotConfigs.find((s) => !s.model);
      if (missingModel) return `Select a model for slot ${missingModel.label}.`;
    } else {
      if (!selectedModel) return "Select a model to run this prompt.";
    }
    return null;
  })();

  if (version === undefined || variables === undefined) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-6 w-32" />
        <div className="flex gap-4">
          <Skeleton className="w-[20%] h-96" />
          <Skeleton className="flex-1 h-96" />
          <Skeleton className="w-[25%] h-96" />
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
              </Button>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button size="sm" onClick={handlePromote} disabled={saving} />
                  }
                >
                  <Shield className="mr-1.5 h-3.5 w-3.5" />
                  Promote to active
                </TooltipTrigger>
                <TooltipContent>
                  Mark this as the current production prompt. The previous
                  active version will be archived.
                </TooltipContent>
              </Tooltip>
            </>
          )}
          {isReadOnly && (
            <>
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

      {/* Three-column layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left — Variable sidebar */}
        <div className="w-[20%] min-w-[200px] border-r overflow-y-auto p-3 space-y-2">
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
              <div className="mt-2">
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

        {/* Right — Run config panel */}
        <div className="w-[25%] min-w-[220px] border-l overflow-y-auto p-3 space-y-4">
          <h3 className="text-xs font-medium uppercase text-muted-foreground">
            Run config
          </h3>

          {/* Test case selector */}
          <div className="space-y-1.5">
            <Label className="text-xs">Test case</Label>
            <Select
              value={selectedTestCaseId}
              onValueChange={(v) => { if (v) setSelectedTestCaseId(v); }}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue
                  placeholder={
                    testCases && testCases.length > 0
                      ? "Select test case"
                      : "No test cases"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {testCases?.map((tc) => (
                  <SelectItem key={tc._id} value={tc._id}>
                    {tc.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {testCases && testCases.length === 0 && (
              <Link
                to={`/orgs/${orgSlug}/projects/${projectId}/test-cases`}
                className="text-xs text-primary hover:underline"
              >
                Create a test case
              </Link>
            )}
          </div>

          {/* Mode toggle */}
          <div className="flex rounded-md border overflow-hidden">
            <button
              className={cn(
                "flex-1 px-2 py-1 text-xs font-medium transition-colors",
                runMode === "uniform"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => {
                if (runMode === "mix") {
                  // Use first slot's config as the uniform config
                  const first = slotConfigs[0];
                  if (first?.model) setSelectedModel(first.model);
                  if (first?.temperature !== undefined) setTemperature(first.temperature);
                }
                setRunMode("uniform");
              }}
            >
              Uniform
            </button>
            <button
              className={cn(
                "flex-1 px-2 py-1 text-xs font-medium transition-colors",
                runMode === "mix"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => {
                if (runMode === "uniform") {
                  // Init all slots with current uniform model/temp
                  setSlotConfigs((prev) =>
                    prev.map((s) => ({
                      ...s,
                      model: selectedModel,
                      temperature,
                    })),
                  );
                }
                setRunMode("mix");
              }}
            >
              Mix & Match
            </button>
          </div>

          {runMode === "uniform" ? (
            <>
              {/* Model selector */}
              <div className="space-y-1.5">
                <Label className="text-xs">Model</Label>
                <ModelPicker
                  value={selectedModel}
                  onChange={setSelectedModel}
                  hasAttachments={!!hasAttachments}
                  catalogModels={catalogModels}
                />
              </div>

              {/* Temperature */}
              <div className="space-y-1.5">
                <Label className="text-xs">Temperature</Label>
                <Input
                  type="number"
                  value={temperature}
                  onChange={(e) =>
                    setTemperature(
                      Math.min(2, Math.max(0, parseFloat(e.target.value) || 0)),
                    )
                  }
                  step={0.1}
                  min={0}
                  max={2}
                  className="h-8 text-xs"
                />
              </div>

              {/* Max tokens */}
              <div className="space-y-1.5">
                <Label className="text-xs">Max tokens</Label>
                <Input
                  type="number"
                  value={maxTokens}
                  onChange={(e) =>
                    setMaxTokens(Math.max(1, parseInt(e.target.value) || 1))
                  }
                  min={1}
                  className="h-8 text-xs"
                />
              </div>
            </>
          ) : (
            <>
              <SlotConfigurator
                slotConfigs={slotConfigs}
                onChange={setSlotConfigs}
                hasAttachments={!!hasAttachments}
                catalogModels={catalogModels}
              />

              {/* Suggest button */}
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                disabled={
                  suggestions?.status === "pending" ||
                  suggestions?.status === "processing"
                }
                onClick={async () => {
                  if (!versionId) return;
                  try {
                    await requestSuggestions({
                      versionId: versionId as Id<"promptVersions">,
                      slotCount: slotConfigs.length,
                    });
                  } catch (err) {
                    setError(friendlyError(err, "Failed to request suggestions."));
                  }
                }}
              >
                <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                {suggestions?.status === "pending" || suggestions?.status === "processing"
                  ? "Suggesting..."
                  : "Suggest configs"}
              </Button>

              {/* Loading state */}
              {(suggestions?.status === "pending" || suggestions?.status === "processing") && (
                <div className="space-y-2">
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="h-16 w-full" />
                </div>
              )}

              {/* Suggestion cards */}
              {suggestions?.status === "completed" && suggestions.suggestions && (
                <SuggestionCards
                  suggestions={suggestions.suggestions}
                  onApply={(configs) => {
                    setSlotConfigs(configs);
                  }}
                />
              )}

              {/* Suggestion error */}
              {suggestions?.status === "failed" && suggestions.errorMessage && (
                <p className="text-[10px] text-destructive">
                  {suggestions.errorMessage}
                </p>
              )}

              {/* Max tokens (shared across slots) */}
              <div className="space-y-1.5">
                <Label className="text-xs">Max tokens</Label>
                <Input
                  type="number"
                  value={maxTokens}
                  onChange={(e) =>
                    setMaxTokens(Math.max(1, parseInt(e.target.value) || 1))
                  }
                  min={1}
                  className="h-8 text-xs"
                />
              </div>
            </>
          )}

          {/* API key missing callout */}
          {keyStatus && !keyStatus.hasKey && (
            <div className="rounded-lg border border-amber-200 bg-amber-50/50 dark:border-amber-900/40 dark:bg-amber-950/10 px-3 py-2 text-xs">
              {orgRole === "owner" ? (
                <p>
                  <Link
                    to={`/orgs/${orgSlug}/settings/openrouter-key`}
                    className="text-primary hover:underline font-medium"
                  >
                    Add your OpenRouter API key
                  </Link>{" "}
                  to run prompts.
                </p>
              ) : (
                <p className="text-muted-foreground">
                  Ask your workspace admin to add an OpenRouter API key before
                  running prompts.
                </p>
              )}
            </div>
          )}

          {/* Onboarding callout: Run */}
          <OnboardingCallout calloutKey="onboarding_run">
            Click Run to execute your prompt against the selected test case.
          </OnboardingCallout>

          {/* Run button */}
          {runDisabledReason ? (
            <Tooltip>
              <TooltipTrigger className="w-full">
                <Button className="w-full" disabled>
                  <Play className="mr-1.5 h-4 w-4" />
                  Run prompt
                </Button>
              </TooltipTrigger>
              <TooltipContent>{runDisabledReason}</TooltipContent>
            </Tooltip>
          ) : (
            <Button
              className="w-full"
              onClick={handleRun}
              disabled={running}
            >
              <Play className="mr-1.5 h-4 w-4" />
              {running ? "Starting..." : "Run prompt"}
            </Button>
          )}

          {/* Concurrent run gauge */}
          <ConcurrentRunGauge projectId={projectId} />

          {/* Recent runs */}
          {recentRuns && recentRuns.length > 0 && (
            <div className="space-y-2 pt-2 border-t">
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

          {/* Onboarding callout: Optimize */}
          <OnboardingCallout calloutKey="onboarding_optimize_flow">
            After running, open the run to read outputs. Select text and press C
            to comment. Once you have feedback, come back here and click Request
            optimization.
          </OnboardingCallout>

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
