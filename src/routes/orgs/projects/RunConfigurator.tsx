import { useState, useEffect, useCallback, useMemo } from "react";
import { useQuery, useMutation } from "convex/react";
import { useParams, useNavigate, useSearchParams, Link } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { useProject } from "@/contexts/ProjectContext";
import { useOrg } from "@/contexts/OrgContext";
import { useModelCatalog, type CatalogModel } from "@/hooks/useModelCatalog";
import { usePersistedRunConfig } from "@/hooks/usePersistedRunConfig";
import { ModelPicker } from "@/components/ModelPicker";
import { SlotConfigurator, type SlotConfig } from "@/components/SlotConfigurator";
import { SuggestionCards } from "@/components/SuggestionCards";
import { ConcurrentRunGauge } from "@/components/ConcurrentRunGauge";
import { EmptyState } from "@/components/EmptyState";
import { VersionStatusPill } from "@/components/VersionStatusPill";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { friendlyError, sanitizeStoredError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FlaskConical,
  GitBranch,
  Play,
  Plus,
  Sparkles,
  X,
} from "lucide-react";

// ---------------------------------------------------------------------------
// StepSection — collapsible wrapper for each configuration step
// ---------------------------------------------------------------------------

function StepSection({
  stepNumber,
  title,
  subtitle,
  collapsed,
  onToggle,
  children,
}: {
  stepNumber: number;
  title: string;
  subtitle?: string;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border rounded-lg">
      <button
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/50 transition-colors"
        onClick={onToggle}
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">
          {stepNumber}
        </span>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          {subtitle && (
            <p className="text-xs text-muted-foreground">{subtitle}</p>
          )}
        </div>
        {collapsed ? (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
      </button>
      {!collapsed && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TruncatedText — show/hide long text blocks
// ---------------------------------------------------------------------------

function TruncatedText({
  text,
  maxLines = 3,
  label,
}: {
  text: string;
  maxLines?: number;
  label: string;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!text) {
    return (
      <p className="text-xs text-muted-foreground italic">No {label}</p>
    );
  }

  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground mb-0.5">
        {label}
      </p>
      <p
        className={cn(
          "text-xs whitespace-pre-wrap break-words",
          !expanded && `line-clamp-${maxLines}`,
        )}
        style={!expanded ? { WebkitLineClamp: maxLines, display: "-webkit-box", WebkitBoxOrient: "vertical", overflow: "hidden" } : undefined}
      >
        {text}
      </p>
      {text.length > 150 && (
        <button
          className="text-xs text-primary hover:underline mt-0.5"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RunConfigurator — main page component
// ---------------------------------------------------------------------------

export function RunConfigurator() {
  const { projectId } = useProject();
  const { orgId, role: orgRole } = useOrg();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { initial: persistedConfig, save: saveRunConfig } =
    usePersistedRunConfig(projectId);

  // --- Queries ---
  const versions = useQuery(api.versions.list, { projectId });
  const testCases = useQuery(api.testCases.list, { projectId });
  const variables = useQuery(api.variables.list, { projectId });
  const keyStatus = useQuery(api.openRouterKeys.hasKey, { orgId });
  const { models: catalogModels } = useModelCatalog();

  // --- Mutations ---
  const executeRun = useMutation(api.runs.execute);
  const createTestCase = useMutation(api.testCases.create);
  const requestSuggestions = useMutation(api.runAssistant.requestSuggestions);

  // --- Step 1: Version selection (multi-select) ---
  const [selectedVersionIds, setSelectedVersionIds] = useState<Set<string>>(
    new Set(),
  );
  // For preview + AI suggestions, use the first selected version
  const primaryVersionId = useMemo(
    () => (selectedVersionIds.size > 0 ? [...selectedVersionIds][0]! : null),
    [selectedVersionIds],
  );

  const primaryVersion = useQuery(
    api.versions.get,
    primaryVersionId
      ? { versionId: primaryVersionId as Id<"promptVersions"> }
      : "skip",
  );

  // --- Step 2: Test case selection ---
  const [selectedTestCaseIds, setSelectedTestCaseIds] = useState<Set<string>>(
    new Set(),
  );
  const [inlineFormOpen, setInlineFormOpen] = useState(false);
  const [inlineFormName, setInlineFormName] = useState("");
  const [inlineFormValues, setInlineFormValues] = useState<
    Record<string, string>
  >({});
  const [inlineFormError, setInlineFormError] = useState("");
  const [creatingTestCase, setCreatingTestCase] = useState(false);

  // --- Step 3: Model configuration (initialized from persisted config) ---
  const [runMode, setRunMode] = useState<"uniform" | "mix">(
    persistedConfig?.runMode ?? "uniform",
  );
  const [selectedModel, setSelectedModel] = useState(
    persistedConfig?.model ?? "",
  );
  const [temperature, setTemperature] = useState(
    persistedConfig?.temperature ?? 0.7,
  );
  const [maxTokens, setMaxTokens] = useState(
    persistedConfig?.maxTokens ?? 1024,
  );
  const [slotConfigs, setSlotConfigs] = useState<SlotConfig[]>(
    persistedConfig?.slotConfigs ?? [
      { label: "A", model: "", temperature: 0.7 },
      { label: "B", model: "", temperature: 0.7 },
      { label: "C", model: "", temperature: 0.7 },
    ],
  );

  // AI suggestions (mix mode only, uses first selected version)
  const suggestions = useQuery(
    api.runAssistant.getSuggestions,
    primaryVersionId && runMode === "mix"
      ? { versionId: primaryVersionId as Id<"promptVersions"> }
      : "skip",
  );

  // Clear persisted model if it no longer exists in the catalog
  useEffect(() => {
    if (catalogModels.length > 0 && selectedModel) {
      const exists = catalogModels.some((m) => m.id === selectedModel);
      if (!exists) setSelectedModel("");
    }
  }, [catalogModels, selectedModel]);

  // --- Step 4: Execution ---
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  // --- UI: section collapse ---
  const [collapsedSections, setCollapsedSections] = useState<Set<number>>(
    new Set(),
  );

  const toggleSection = useCallback((step: number) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(step)) next.delete(step);
      else next.add(step);
      return next;
    });
  }, []);

  // --- hasAttachments: check if any selected test case has attachments ---
  const hasAttachments = useMemo(() => {
    if (!testCases) return false;
    return testCases.some(
      (tc) =>
        selectedTestCaseIds.has(tc._id) &&
        tc.attachmentIds &&
        tc.attachmentIds.length > 0,
    );
  }, [testCases, selectedTestCaseIds]);

  // ---------------------------------------------------------------------------
  // Initialization effects
  // ---------------------------------------------------------------------------

  // Auto-select version(s) from query params or active version
  const prefilledVersionId = searchParams.get("versionId");
  useEffect(() => {
    if (selectedVersionIds.size > 0 || !versions || versions.length === 0) return;

    if (prefilledVersionId) {
      const exists = versions.some((v) => v._id === prefilledVersionId);
      if (exists) {
        setSelectedVersionIds(new Set([prefilledVersionId]));
        return;
      }
    }

    const current = versions.find((v) => v.status === "current");
    const defaultId = current?._id ?? versions[0]?._id;
    if (defaultId) setSelectedVersionIds(new Set([defaultId]));
  }, [versions, prefilledVersionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pre-fill inline form defaults when opened
  useEffect(() => {
    if (inlineFormOpen && variables) {
      const defaults: Record<string, string> = {};
      for (const v of variables) {
        if (v.defaultValue) defaults[v.name] = v.defaultValue;
      }
      setInlineFormValues(defaults);
      setInlineFormName("");
      setInlineFormError("");
    }
  }, [inlineFormOpen, variables]);

  // ---------------------------------------------------------------------------
  // Step 1: Version toggle helpers
  // ---------------------------------------------------------------------------

  const toggleVersion = useCallback((id: string) => {
    setSelectedVersionIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Resolve selected versions to their data for the summary table
  const selectedVersionData = useMemo(() => {
    if (!versions) return [];
    return versions.filter((v) => selectedVersionIds.has(v._id));
  }, [versions, selectedVersionIds]);

  // ---------------------------------------------------------------------------
  // Step 2: Test case helpers
  // ---------------------------------------------------------------------------

  const toggleTestCase = useCallback((id: string) => {
    setSelectedTestCaseIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (!testCases) return;
    setSelectedTestCaseIds((prev) => {
      if (prev.size === testCases.length) return new Set();
      return new Set(testCases.map((tc) => tc._id));
    });
  }, [testCases]);

  const handleCreateTestCase = useCallback(async () => {
    if (!inlineFormName.trim()) {
      setInlineFormError("Name is required.");
      return;
    }
    if (variables) {
      const missing = variables.find(
        (v) => v.required && !inlineFormValues[v.name]?.trim(),
      );
      if (missing) {
        setInlineFormError(`Required variable "${missing.name}" is empty.`);
        return;
      }
    }

    setCreatingTestCase(true);
    setInlineFormError("");
    try {
      const newId = await createTestCase({
        projectId,
        name: inlineFormName.trim(),
        variableValues: inlineFormValues,
      });
      setSelectedTestCaseIds((prev) => new Set(prev).add(newId));
      setInlineFormOpen(false);
      toast.success("Test case created");
    } catch (err) {
      setInlineFormError(friendlyError(err, "Failed to create test case."));
    } finally {
      setCreatingTestCase(false);
    }
  }, [
    inlineFormName,
    inlineFormValues,
    variables,
    createTestCase,
    projectId,
  ]);

  // ---------------------------------------------------------------------------
  // Step 3: Mode toggle sync
  // ---------------------------------------------------------------------------

  const handleSwitchToMix = useCallback(() => {
    if (runMode === "uniform") {
      setSlotConfigs((prev) =>
        prev.map((s) => ({
          ...s,
          model: selectedModel,
          temperature,
        })),
      );
    }
    setRunMode("mix");
  }, [runMode, selectedModel, temperature]);

  const handleSwitchToUniform = useCallback(() => {
    if (runMode === "mix") {
      const first = slotConfigs[0];
      if (first?.model) setSelectedModel(first.model);
      if (first?.temperature !== undefined) setTemperature(first.temperature);
    }
    setRunMode("uniform");
  }, [runMode, slotConfigs]);

  // ---------------------------------------------------------------------------
  // Step 4: Summary computation (versions × test cases)
  // ---------------------------------------------------------------------------

  const outputsPerRun = runMode === "mix" ? slotConfigs.length : 3;

  const summaryRows = useMemo(() => {
    if (!testCases) return [];
    const selectedTCs = testCases.filter((tc) =>
      selectedTestCaseIds.has(tc._id),
    );

    const modelLabel =
      runMode === "mix"
        ? `Mix (${slotConfigs.length} slots)`
        : catalogModels.find((m) => m.id === selectedModel)?.name ??
          selectedModel ??
          "—";

    const costPerOutput = estimateCostPerOutput(
      runMode === "mix" ? slotConfigs : null,
      selectedModel,
      maxTokens,
      catalogModels,
    );

    const rows: Array<{
      versionLabel: string;
      testCaseName: string;
      modelLabel: string;
      outputs: number;
      cost: number | null;
    }> = [];

    for (const ver of selectedVersionData) {
      for (const tc of selectedTCs) {
        rows.push({
          versionLabel: `v${ver.versionNumber}`,
          testCaseName: tc.name,
          modelLabel,
          outputs: outputsPerRun,
          cost:
            costPerOutput !== null ? costPerOutput * outputsPerRun : null,
        });
      }
    }

    return rows;
  }, [
    testCases,
    selectedTestCaseIds,
    selectedVersionData,
    runMode,
    slotConfigs,
    selectedModel,
    maxTokens,
    catalogModels,
    outputsPerRun,
  ]);

  const totalOutputs = summaryRows.reduce((sum, r) => sum + r.outputs, 0);
  const totalCost = summaryRows.every((r) => r.cost !== null)
    ? summaryRows.reduce((sum, r) => sum + (r.cost ?? 0), 0)
    : null;
  const totalRuns = summaryRows.length;

  // ---------------------------------------------------------------------------
  // Step 4: Validation
  // ---------------------------------------------------------------------------

  const runDisabledReason = (() => {
    if (!keyStatus?.hasKey)
      return "Set your OpenRouter key to run prompts.";
    if (selectedVersionIds.size === 0) return "Select at least one version.";
    if (selectedTestCaseIds.size === 0)
      return "Select at least one test case.";
    if (runMode === "mix") {
      const missingModel = slotConfigs.find((s) => !s.model);
      if (missingModel)
        return `Select a model for slot ${missingModel.label}.`;
    } else {
      if (!selectedModel) return "Select a model to run.";
    }
    return null;
  })();

  // ---------------------------------------------------------------------------
  // Step 4: Batch execution
  // ---------------------------------------------------------------------------

  const handleRunAll = useCallback(async () => {
    if (running || runDisabledReason || selectedVersionIds.size === 0) return;

    setRunning(true);
    setError("");
    const versionIdArray = Array.from(selectedVersionIds);
    const testCaseIdArray = Array.from(selectedTestCaseIds);
    const runIds: string[] = [];
    const isMix = runMode === "mix";

    // Execute versions × test cases
    for (const versionId of versionIdArray) {
      for (const testCaseId of testCaseIdArray) {
        try {
          const runId = await executeRun({
            versionId: versionId as Id<"promptVersions">,
            testCaseId: testCaseId as Id<"testCases">,
            model: isMix ? (slotConfigs[0]?.model ?? "") : selectedModel,
            temperature: isMix
              ? (slotConfigs[0]?.temperature ?? 0.7)
              : temperature,
            maxTokens,
            mode: isMix ? "mix" : undefined,
            slotConfigs: isMix ? slotConfigs : undefined,
          });
          runIds.push(runId);
        } catch (err) {
          toast.error(friendlyError(err, "Failed to start run."));
        }
      }
    }

    setRunning(false);

    if (runIds.length === 0) {
      setError("All runs failed to start.");
      return;
    }

    // Persist model config for next visit
    saveRunConfig({
      model: selectedModel,
      temperature,
      maxTokens,
      runMode,
      slotConfigs: runMode === "mix" ? slotConfigs : undefined,
    });

    if (runIds.length === 1) {
      navigate(`/orgs/${orgSlug}/projects/${projectId}/runs/${runIds[0]}`);
    } else {
      // Pass compared version IDs so RunsList can show a cycle CTA
      const params =
        versionIdArray.length >= 2
          ? `?compare=${versionIdArray.join(",")}`
          : "";
      navigate(`/orgs/${orgSlug}/projects/${projectId}/runs${params}`);
    }
  }, [
    running,
    runDisabledReason,
    selectedVersionIds,
    selectedTestCaseIds,
    runMode,
    slotConfigs,
    selectedModel,
    temperature,
    maxTokens,
    executeRun,
    saveRunConfig,
    navigate,
    orgSlug,
    projectId,
  ]);

  // Cmd+Enter shortcut
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleRunAll();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleRunAll]);

  // ---------------------------------------------------------------------------
  // Loading state
  // ---------------------------------------------------------------------------

  if (versions === undefined || variables === undefined) {
    return (
      <div className="p-6 max-w-3xl mx-auto space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Extracted variables from the selected version template
  // ---------------------------------------------------------------------------

  const templateVarNames = primaryVersion
    ? extractVariableNames(primaryVersion.userMessageTemplate)
    : [];

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-4">
      <h1 className="text-xl font-semibold">Configure Run</h1>

      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}

      {/* Step 1: Version Selection (multi-select) */}
      <StepSection
        stepNumber={1}
        title="Prompt Versions"
        subtitle={
          selectedVersionIds.size > 0
            ? `${selectedVersionIds.size} selected${selectedVersionIds.size >= 2 ? " — will create review cycle" : ""}`
            : undefined
        }
        collapsed={collapsedSections.has(1)}
        onToggle={() => toggleSection(1)}
      >
        {versions.length === 0 ? (
          <EmptyState
            icon={GitBranch}
            heading="No versions"
            description="Create a prompt version before configuring a run."
            action={{
              label: "Go to Versions",
              onClick: () =>
                navigate(
                  `/orgs/${orgSlug}/projects/${projectId}/versions`,
                ),
            }}
          />
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Select one version for a simple run, or multiple to compare
              and create a review cycle.
            </p>

            {/* Version cards (always visible, multi-select) */}
            <div className="space-y-2">
              {versions.map((v) => {
                const isSelected = selectedVersionIds.has(v._id);
                return (
                  <button
                    key={v._id}
                    className={cn(
                      "flex w-full items-start gap-3 rounded-md border p-3 text-left transition-colors",
                      isSelected
                        ? "border-primary/40 bg-primary/5"
                        : "hover:bg-muted/50",
                    )}
                    onClick={() => toggleVersion(v._id)}
                  >
                    <Checkbox
                      checked={isSelected}
                      tabIndex={-1}
                      className="mt-0.5"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">
                          v{v.versionNumber}
                        </span>
                        <VersionStatusPill status={v.status} />
                        {v.creatorName && (
                          <span className="text-xs text-muted-foreground">
                            by {v.creatorName}
                          </span>
                        )}
                      </div>
                    </div>
                    {isSelected && (
                      <Link
                        to={`/orgs/${orgSlug}/projects/${projectId}/versions/${v._id}`}
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline shrink-0"
                        onClick={(e) => e.stopPropagation()}
                      >
                        Edit
                        <ExternalLink className="h-3 w-3" />
                      </Link>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Preview of first selected version */}
            {primaryVersion && selectedVersionIds.size > 0 && (
              <div className="border rounded-md p-3 space-y-2 bg-muted/30">
                <p className="text-xs font-medium text-muted-foreground">
                  Preview — v{primaryVersion.versionNumber}
                </p>
                <TruncatedText
                  text={primaryVersion.systemMessage ?? ""}
                  label="System message"
                />
                <TruncatedText
                  text={primaryVersion.userMessageTemplate}
                  label="User template"
                />

                {templateVarNames.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-0.5">
                      Variables
                    </p>
                    <p className="text-xs">
                      {templateVarNames.join(", ")}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </StepSection>

      {/* Step 2: Test Case Selection */}
      <StepSection
        stepNumber={2}
        title="Test Cases"
        subtitle={
          testCases !== undefined
            ? `${selectedTestCaseIds.size} selected`
            : undefined
        }
        collapsed={collapsedSections.has(2)}
        onToggle={() => toggleSection(2)}
      >
        {testCases === undefined ? (
          <div className="space-y-2">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : testCases.length === 0 ? (
          <EmptyState
            icon={FlaskConical}
            heading="No test cases"
            description="Create test cases with sample variable values to run your prompt against."
            action={{
              label: "Go to Test Cases",
              onClick: () =>
                navigate(
                  `/orgs/${orgSlug}/projects/${projectId}/test-cases`,
                ),
            }}
          />
        ) : (
          <div className="space-y-2">
            {/* Select all toggle */}
            <div className="flex items-center justify-end">
              <button
                className="text-xs text-primary hover:underline"
                onClick={toggleSelectAll}
              >
                {selectedTestCaseIds.size === testCases.length
                  ? "Deselect all"
                  : "Select all"}
              </button>
            </div>

            {/* Test case cards */}
            {testCases.map((tc) => {
              const isSelected = selectedTestCaseIds.has(tc._id);
              const missingRequired = variables?.some(
                (v) =>
                  v.required && !tc.variableValues[v.name]?.trim(),
              );

              return (
                <button
                  key={tc._id}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-md border p-3 text-left transition-colors",
                    isSelected
                      ? "border-primary/40 bg-primary/5"
                      : "hover:bg-muted/50",
                  )}
                  onClick={() => toggleTestCase(tc._id)}
                >
                  <Checkbox
                    checked={isSelected}
                    tabIndex={-1}
                    className="mt-0.5"
                  />
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">
                        {tc.name}
                      </span>
                      {missingRequired && (
                        <Tooltip>
                          <TooltipTrigger className="cursor-default">
                            <AlertCircle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                          </TooltipTrigger>
                          <TooltipContent>
                            Missing required variable values
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground space-y-0.5">
                      {Object.entries(tc.variableValues)
                        .slice(0, 3)
                        .map(([name, val]) => (
                          <p key={name} className="truncate">
                            {name}:{" "}
                            <span className="text-foreground/70">
                              &quot;{truncate(val, 80)}&quot;
                            </span>
                          </p>
                        ))}
                      {Object.keys(tc.variableValues).length > 3 && (
                        <p className="text-muted-foreground/60">
                          +{Object.keys(tc.variableValues).length - 3} more
                        </p>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}

            {/* Inline test case creation */}
            {inlineFormOpen ? (
              <div className="border rounded-md p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium">New test case</h3>
                  <button
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => setInlineFormOpen(false)}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">
                    Name <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    value={inlineFormName}
                    onChange={(e) => setInlineFormName(e.target.value)}
                    placeholder="e.g. Happy path customer inquiry"
                    className="h-8 text-xs"
                  />
                </div>

                {variables && variables.length > 0 ? (
                  variables.map((v) => (
                    <div key={v._id} className="space-y-1.5">
                      <Label className="text-xs">
                        {v.name}
                        {v.required && (
                          <span className="text-destructive ml-0.5">*</span>
                        )}
                        {v.description && (
                          <span className="text-muted-foreground ml-1 font-normal">
                            — {v.description}
                          </span>
                        )}
                      </Label>
                      <Input
                        value={inlineFormValues[v.name] ?? ""}
                        onChange={(e) =>
                          setInlineFormValues((prev) => ({
                            ...prev,
                            [v.name]: e.target.value,
                          }))
                        }
                        placeholder={v.defaultValue || undefined}
                        className="h-8 text-xs"
                      />
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No variables defined. Your prompt will run with no
                    variable substitution.
                  </p>
                )}

                {inlineFormError && (
                  <p className="text-xs text-destructive">
                    {inlineFormError}
                  </p>
                )}

                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setInlineFormOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleCreateTestCase}
                    disabled={creatingTestCase}
                  >
                    {creatingTestCase ? "Creating..." : "Create & Select"}
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setInlineFormOpen(true)}
              >
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Add test case
              </Button>
            )}
          </div>
        )}
      </StepSection>

      {/* Step 3: Model Configuration */}
      <StepSection
        stepNumber={3}
        title="Models"
        subtitle={
          runMode === "mix"
            ? `Mix & Match (${slotConfigs.length} slots)`
            : selectedModel
              ? catalogModels.find((m) => m.id === selectedModel)?.name ??
                selectedModel
              : undefined
        }
        collapsed={collapsedSections.has(3)}
        onToggle={() => toggleSection(3)}
      >
        <div className="space-y-4">
          {/* Mode toggle */}
          <div className="flex rounded-md border overflow-hidden w-fit">
            <button
              className={cn(
                "px-3 py-1.5 text-xs font-medium transition-colors",
                runMode === "uniform"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={handleSwitchToUniform}
            >
              Uniform
            </button>
            <button
              className={cn(
                "px-3 py-1.5 text-xs font-medium transition-colors",
                runMode === "mix"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={handleSwitchToMix}
            >
              Mix &amp; Match
            </button>
          </div>

          {runMode === "uniform" ? (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs">Model</Label>
                <ModelPicker
                  value={selectedModel}
                  onChange={setSelectedModel}
                  hasAttachments={!!hasAttachments}
                  catalogModels={catalogModels}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Temperature</Label>
                <Input
                  type="number"
                  value={temperature}
                  onChange={(e) =>
                    setTemperature(
                      Math.min(
                        2,
                        Math.max(0, parseFloat(e.target.value) || 0),
                      ),
                    )
                  }
                  step={0.1}
                  min={0}
                  max={2}
                  className="h-8 text-xs"
                />
              </div>
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
            </div>
          ) : (
            <div className="space-y-3">
              <SlotConfigurator
                slotConfigs={slotConfigs}
                onChange={setSlotConfigs}
                hasAttachments={!!hasAttachments}
                catalogModels={catalogModels}
              />

              {/* Suggest configs */}
              <Button
                variant="outline"
                size="sm"
                disabled={
                  !primaryVersionId ||
                  suggestions?.status === "pending" ||
                  suggestions?.status === "processing"
                }
                onClick={async () => {
                  if (!primaryVersionId) return;
                  try {
                    await requestSuggestions({
                      versionId: primaryVersionId as Id<"promptVersions">,
                      slotCount: slotConfigs.length,
                    });
                  } catch (err) {
                    toast.error(
                      friendlyError(err, "Failed to request suggestions."),
                    );
                  }
                }}
              >
                <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                {suggestions?.status === "pending" ||
                suggestions?.status === "processing"
                  ? "Suggesting..."
                  : "Suggest configs"}
              </Button>

              {/* Suggestion loading */}
              {(suggestions?.status === "pending" ||
                suggestions?.status === "processing") && (
                <div className="space-y-2">
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="h-16 w-full" />
                </div>
              )}

              {/* Suggestion cards */}
              {suggestions?.status === "completed" &&
                suggestions.suggestions && (
                  <SuggestionCards
                    suggestions={suggestions.suggestions}
                    onApply={(configs) => setSlotConfigs(configs)}
                  />
                )}

              {/* Suggestion error */}
              {suggestions?.status === "failed" &&
                suggestions.errorMessage && (
                  <p className="text-xs text-destructive">
                    {sanitizeStoredError(suggestions.errorMessage)}
                  </p>
                )}

              {/* Max tokens (shared) */}
              <div className="space-y-1.5 max-w-[200px]">
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
            </div>
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
                  Ask your workspace admin to add an OpenRouter API key
                  before running prompts.
                </p>
              )}
            </div>
          )}
        </div>
      </StepSection>

      {/* Step 4: Summary & Run */}
      <StepSection
        stepNumber={4}
        title="Summary & Run"
        subtitle={
          summaryRows.length > 0
            ? `${totalRuns} run${totalRuns === 1 ? "" : "s"}, ${totalOutputs} outputs`
            : undefined
        }
        collapsed={collapsedSections.has(4)}
        onToggle={() => toggleSection(4)}
      >
        <div className="space-y-4">
          {selectedVersionIds.size >= 2 && (
            <div className="rounded-lg border border-blue-200 bg-blue-50/50 dark:border-blue-900/40 dark:bg-blue-950/10 px-3 py-2 text-xs text-blue-800 dark:text-blue-300">
              Comparing {selectedVersionIds.size} versions — after runs
              complete you can{" "}
              <Link
                to={`/orgs/${orgSlug}/projects/${projectId}/cycles/new?primaryVersionId=${[...selectedVersionIds][0]}&controlVersionId=${[...selectedVersionIds][1] ?? ""}`}
                className="underline font-medium hover:text-blue-900 dark:hover:text-blue-200"
              >
                create a review cycle
              </Link>{" "}
              for blind evaluation.
            </div>
          )}

          {summaryRows.length > 0 ? (
            <div className="border rounded-md overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-muted/50">
                    {selectedVersionIds.size > 1 && (
                      <th className="text-left px-3 py-2 font-medium">
                        Version
                      </th>
                    )}
                    <th className="text-left px-3 py-2 font-medium">
                      Test Case
                    </th>
                    <th className="text-left px-3 py-2 font-medium">
                      Models
                    </th>
                    <th className="text-right px-3 py-2 font-medium">
                      Outputs
                    </th>
                    <th className="text-right px-3 py-2 font-medium">
                      Est. Cost
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {summaryRows.map((row, i) => (
                    <tr key={i} className="border-b last:border-b-0">
                      {selectedVersionIds.size > 1 && (
                        <td className="px-3 py-2 font-medium">
                          {row.versionLabel}
                        </td>
                      )}
                      <td className="px-3 py-2 truncate max-w-[200px]">
                        {row.testCaseName}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {row.modelLabel}
                      </td>
                      <td className="px-3 py-2 text-right">{row.outputs}</td>
                      <td className="px-3 py-2 text-right text-muted-foreground">
                        {row.cost !== null ? `$${row.cost.toFixed(4)}` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t bg-muted/30 font-medium">
                    <td
                      className="px-3 py-2"
                      colSpan={selectedVersionIds.size > 1 ? 2 : 1}
                    >
                      Total ({totalRuns} run{totalRuns === 1 ? "" : "s"})
                    </td>
                    <td />
                    <td className="px-3 py-2 text-right">{totalOutputs}</td>
                    <td className="px-3 py-2 text-right">
                      {totalCost !== null ? `$${totalCost.toFixed(4)}` : "—"}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Select versions, test cases, and configure a model to see the
              run summary.
            </p>
          )}

          {/* Run button */}
          <div className="flex items-center justify-between">
            <ConcurrentRunGauge projectId={projectId} />

            {runDisabledReason ? (
              <Tooltip>
                <TooltipTrigger className="inline-flex">
                  <Button disabled>
                    <Play className="mr-1.5 h-4 w-4" />
                    {selectedVersionIds.size >= 2
                      ? `Run & Compare (${totalRuns})`
                      : `Run All (${totalRuns})`}
                    <kbd className="ml-2 rounded border bg-background/50 px-1 py-0.5 text-[10px] font-mono opacity-60">
                      ⌘↵
                    </kbd>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{runDisabledReason}</TooltipContent>
              </Tooltip>
            ) : (
              <Button onClick={handleRunAll} disabled={running}>
                <Play className="mr-1.5 h-4 w-4" />
                {running
                  ? "Starting..."
                  : selectedVersionIds.size >= 2
                    ? `Run & Compare (${totalRuns})`
                    : `Run All (${totalRuns})`}
                {!running && (
                  <kbd className="ml-2 rounded border bg-background/50 px-1 py-0.5 text-[10px] font-mono opacity-60">
                    ⌘↵
                  </kbd>
                )}
              </Button>
            )}
          </div>
        </div>
      </StepSection>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract {{variable}} names from a template string */
function extractVariableNames(template: string): string[] {
  const matches = template.match(/\{\{(\w+)\}\}/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.slice(2, -2)))];
}

/** Truncate a string to a max length */
function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + "...";
}

/** Rough cost estimate per output using catalog pricing */
function estimateCostPerOutput(
  mixSlots: SlotConfig[] | null,
  uniformModel: string,
  maxTokens: number,
  catalog: CatalogModel[],
): number | null {
  if (mixSlots) {
    // Average cost across all slots
    let total = 0;
    for (const slot of mixSlots) {
      const model = catalog.find((m) => m.id === slot.model);
      if (!model) return null;
      // Rough: assume prompt tokens ~ maxTokens/2 for estimation
      total +=
        (model.promptPricing * (maxTokens / 2) +
          model.completionPricing * maxTokens) /
        1_000_000;
    }
    return total / mixSlots.length;
  }

  const model = catalog.find((m) => m.id === uniformModel);
  if (!model) return null;
  return (
    (model.promptPricing * (maxTokens / 2) +
      model.completionPricing * maxTokens) /
    1_000_000
  );
}
