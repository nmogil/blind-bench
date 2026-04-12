import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery, useMutation } from "convex/react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { api } from "../../../../convex/_generated/api";
import { Id, Doc } from "../../../../convex/_generated/dataModel";
import { useProject } from "@/contexts/ProjectContext";
import { useOrg } from "@/contexts/OrgContext";
import { PromptEditor } from "@/components/tiptap/PromptEditor";
import { AddVariableDialog } from "@/components/AddVariableDialog";
import { VersionStatusPill } from "@/components/VersionStatusPill";
import { RunStatusPill } from "@/components/RunStatusPill";
import { ModelPicker } from "@/components/ModelPicker";
import { ConcurrentRunGauge } from "@/components/ConcurrentRunGauge";
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
  Paperclip,
  Play,
  Plus,
  Save,
  Shield,
} from "lucide-react";
import { cn } from "@/lib/utils";

export function VersionEditor() {
  const { projectId } = useProject();
  const { orgId } = useOrg();
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
    if (!versionId || !selectedTestCaseId || !selectedModel || running) return;
    setRunning(true);
    setError("");
    try {
      const runId = await executeRun({
        versionId: versionId as Id<"promptVersions">,
        testCaseId: selectedTestCaseId as Id<"testCases">,
        model: selectedModel,
        temperature,
        maxTokens,
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
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleSave, handleRun]);

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
    if (!selectedModel) return "Select a model to run this prompt.";
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
              <Button size="sm" onClick={handlePromote} disabled={saving}>
                <Shield className="mr-1.5 h-3.5 w-3.5" />
                Promote to active
              </Button>
            </>
          )}
          {isReadOnly && (
            <span className="text-xs text-muted-foreground">
              This version is read-only
            </span>
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
            <p className="text-xs text-muted-foreground">
              Variables appear here. Add one and reference it with{" "}
              {"{{name}}"} in your template.
            </p>
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
                <PromptEditor
                  content={systemMessage}
                  onChange={setSystemMessage}
                  readOnly={isReadOnly}
                  placeholder="You are a helpful assistant..."
                />
              </div>
            )}
          </div>

          {/* User message template */}
          <div>
            <Label className="text-sm font-medium">
              User message template
            </Label>
            <div className="mt-2">
              <PromptEditor
                content={userTemplate}
                onChange={setUserTemplate}
                readOnly={isReadOnly}
                placeholder="Hello {{customer_name}}, ..."
              />
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
          </div>

          {/* Model selector */}
          <div className="space-y-1.5">
            <Label className="text-xs">Model</Label>
            <ModelPicker
              value={selectedModel}
              onChange={setSelectedModel}
              hasAttachments={!!hasAttachments}
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
        </div>
      </div>

      <AddVariableDialog
        open={addVarOpen}
        onOpenChange={setAddVarOpen}
        projectId={projectId}
      />
    </div>
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
