import { useState, useMemo } from "react";
import { useQuery, useMutation } from "convex/react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { useProject } from "@/contexts/ProjectContext";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  Shuffle,
  Users,
  Play,
  AlertCircle,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { friendlyError } from "@/lib/errors";

type Step = "versions" | "outputs" | "evaluators" | "review";
const STEPS: Step[] = ["versions", "outputs", "evaluators", "review"];
const STEP_LABELS: Record<Step, string> = {
  versions: "Versions",
  outputs: "Output Pool",
  evaluators: "Evaluators",
  review: "Review & Start",
};

export function CycleCreator() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const { projectId } = useProject();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const prefilledVersionId = searchParams.get("primaryVersionId") as
    | Id<"promptVersions">
    | null;
  const prefilledControlId = searchParams.get("controlVersionId") as
    | Id<"promptVersions">
    | null;

  // Queries
  const versions = useQuery(api.versions.list, { projectId });
  const collaborators = useQuery(api.projects.listCollaborators, {
    projectId,
  });
  const suggestedControl = useQuery(
    api.reviewCycles.suggestControlVersion,
    prefilledVersionId
      ? { projectId, excludeVersionId: prefilledVersionId }
      : "skip",
  );

  // Mutations
  const createCycle = useMutation(api.reviewCycles.create);
  const addOutputs = useMutation(api.reviewCycles.addOutputs);
  const autoPoolOutputs = useMutation(api.reviewCycles.autoPoolOutputs);
  const assignEvaluators = useMutation(api.reviewCycles.assignEvaluators);
  const startCycle = useMutation(api.reviewCycles.start);
  const updateName = useMutation(api.reviewCycles.updateName);

  // State
  const [step, setStep] = useState<Step>("versions");
  const [primaryVersionId, setPrimaryVersionId] = useState<string>(
    prefilledVersionId ?? "",
  );
  const [controlVersionId, setControlVersionId] = useState<string>(
    prefilledControlId ?? "",
  );
  const [useAutoPool, setUseAutoPool] = useState(true);
  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(
    new Set(),
  );
  const [selectedEvaluatorIds, setSelectedEvaluatorIds] = useState<
    Set<string>
  >(new Set());
  const [cycleName, setCycleName] = useState("");
  const [, setCreatedCycleId] = useState<
    Id<"reviewCycles"> | null
  >(null);
  const [, setOutputCount] = useState<number>(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pre-validation: check available runs for pooling
  const availableRuns = useQuery(
    api.reviewCycles.getAvailableRunsForPooling,
    primaryVersionId
      ? {
          projectId,
          primaryVersionId: primaryVersionId as Id<"promptVersions">,
          controlVersionId: controlVersionId
            ? (controlVersionId as Id<"promptVersions">)
            : undefined,
        }
      : "skip",
  );

  // Derived
  const nonDraftVersions = useMemo(
    () => versions?.filter((v) => v.status !== "draft") ?? [],
    [versions],
  );
  const evaluators = useMemo(
    () => collaborators?.filter((c) => c.role === "evaluator") ?? [],
    [collaborators],
  );

  // Runs for the selected versions (for manual output selection)
  const primaryRuns = useQuery(
    api.runs.list,
    primaryVersionId
      ? { versionId: primaryVersionId as Id<"promptVersions"> }
      : "skip",
  );
  const controlRuns = useQuery(
    api.runs.list,
    controlVersionId
      ? { versionId: controlVersionId as Id<"promptVersions"> }
      : "skip",
  );

  // Auto-suggest control version when primary changes
  const dynamicSuggestion = useQuery(
    api.reviewCycles.suggestControlVersion,
    primaryVersionId
      ? {
          projectId,
          excludeVersionId: primaryVersionId as Id<"promptVersions">,
        }
      : "skip",
  );

  const suggestion = dynamicSuggestion ?? suggestedControl;

  // Apply suggestion when available and no control selected yet
  const suggestedId = suggestion?.suggestedVersionId;

  const stepIndex = STEPS.indexOf(step);

  function goNext() {
    if (stepIndex < STEPS.length - 1) {
      setStep(STEPS[stepIndex + 1]!);
    }
  }

  function goBack() {
    if (stepIndex > 0) {
      setStep(STEPS[stepIndex - 1]!);
    } else {
      navigate(`/orgs/${orgSlug}/projects/${projectId}/cycles`);
    }
  }

  async function handleCreateAndStart() {
    if (!primaryVersionId) return;
    setSaving(true);
    setError(null);

    try {
      // Step 1: Create the cycle
      const cycleId = await createCycle({
        projectId,
        primaryVersionId: primaryVersionId as Id<"promptVersions">,
        controlVersionId: controlVersionId
          ? (controlVersionId as Id<"promptVersions">)
          : undefined,
      });
      setCreatedCycleId(cycleId);

      // Step 2: Update name if customized
      if (cycleName.trim()) {
        await updateName({ cycleId, name: cycleName.trim() });
      }

      // Step 3: Pool outputs
      if (useAutoPool) {
        const result = await autoPoolOutputs({ cycleId });
        setOutputCount(result.outputCount);
      } else {
        const runIds = [...selectedRunIds].map(
          (id) => id as Id<"promptRuns">,
        );
        if (runIds.length > 0) {
          const result = await addOutputs({ cycleId, runIds });
          setOutputCount(result.outputCount);
        }
      }

      // Step 4: Assign evaluators
      const evalIds = [...selectedEvaluatorIds].map(
        (id) => id as Id<"users">,
      );
      if (evalIds.length > 0) {
        await assignEvaluators({ cycleId, evaluatorIds: evalIds });
      }

      // Step 5: Start the cycle
      await startCycle({ cycleId });

      // Navigate to cycle detail
      navigate(
        `/orgs/${orgSlug}/projects/${projectId}/cycles/${cycleId}`,
      );
    } catch (e) {
      setError(friendlyError(e, "Failed to start review cycle."));
    } finally {
      setSaving(false);
    }
  }

  // Loading state
  if (versions === undefined || collaborators === undefined) {
    return (
      <div className="p-6 max-w-2xl space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const primaryVersion = nonDraftVersions.find(
    (v) => v._id === primaryVersionId,
  );
  const controlVersion = nonDraftVersions.find(
    (v) => v._id === controlVersionId,
  );

  return (
    <div className="p-6 max-w-2xl">
      {/* Header */}
      <button
        type="button"
        onClick={goBack}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
      >
        <ArrowLeft className="h-4 w-4" />
        Back
      </button>

      <h2 className="text-xl font-bold">Create Review Cycle</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Pool outputs from multiple versions, assign evaluators, and collect
        structured blind feedback.
      </p>

      {/* Step indicator */}
      <div className="flex items-center gap-1 mt-6 mb-8">
        {STEPS.map((s, i) => (
          <div key={s} className="flex items-center">
            <div
              className={cn(
                "flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded",
                i === stepIndex
                  ? "text-foreground bg-muted"
                  : i < stepIndex
                    ? "text-primary"
                    : "text-muted-foreground/50",
              )}
            >
              <span className="w-4 h-4 rounded-full text-[10px] flex items-center justify-center border border-current">
                {i + 1}
              </span>
              {STEP_LABELS[s]}
            </div>
            {i < STEPS.length - 1 && (
              <ChevronRight className="h-3 w-3 text-muted-foreground/30 mx-0.5" />
            )}
          </div>
        ))}
      </div>

      {/* Step 1: Version Selection */}
      {step === "versions" && (
        <div className="space-y-6">
          <div>
            <Label className="text-sm font-medium">Primary Version</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              The version you want feedback on
            </p>
            <Select
              value={primaryVersionId}
              onValueChange={(val) => setPrimaryVersionId(val ?? "")}
            >
              <SelectTrigger className="mt-2">
                <SelectValue placeholder="Select a version" />
              </SelectTrigger>
              <SelectContent>
                {nonDraftVersions.map((v) => (
                  <SelectItem key={v._id} value={v._id}>
                    v{v.versionNumber}{" "}
                    <span className="text-muted-foreground">
                      ({v.status})
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label className="text-sm font-medium">
              Control Version{" "}
              <span className="text-muted-foreground font-normal">
                (optional)
              </span>
            </Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              A baseline version for A/B comparison
            </p>
            <Select
              value={controlVersionId}
              onValueChange={(val) => setControlVersionId(val ?? "")}
            >
              <SelectTrigger className="mt-2">
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">None</SelectItem>
                {nonDraftVersions
                  .filter((v) => v._id !== primaryVersionId)
                  .map((v) => (
                    <SelectItem key={v._id} value={v._id}>
                      v{v.versionNumber}
                      {suggestedId === v._id && (
                        <span className="ml-1 text-primary">
                          (suggested)
                        </span>
                      )}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            {suggestedId && !controlVersionId && (
              <button
                type="button"
                onClick={() => setControlVersionId(suggestedId)}
                className="mt-2 flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <Sparkles className="h-3 w-3" />
                Use suggested: v{suggestion?.versionNumber} (score:{" "}
                {suggestion?.score.toFixed(1)}, {suggestion?.ratingCount}{" "}
                ratings)
              </button>
            )}
          </div>

          <Button
            onClick={goNext}
            disabled={!primaryVersionId}
            className="w-full"
          >
            Next: Configure Output Pool
            <ArrowRight className="h-4 w-4 ml-2" />
          </Button>
        </div>
      )}

      {/* Step 2: Output Pool */}
      {step === "outputs" && (
        <div className="space-y-6">
          <div className="rounded-lg border p-4">
            <div className="flex items-center gap-2">
              <Shuffle className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">
                Output Pool Configuration
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Outputs from all selected versions will be shuffled and assigned
              new blind labels (A-Z). Evaluators won't know which version
              produced which output.
            </p>
          </div>

          {/* Run availability summary */}
          {availableRuns && (
            <div className="rounded-lg border p-3 space-y-1.5">
              {availableRuns.versionRuns.map((vr) => (
                <div
                  key={vr.versionId}
                  className="flex items-center justify-between text-sm"
                >
                  <span>
                    v{vr.versionNumber}
                  </span>
                  <span
                    className={cn(
                      "text-xs",
                      vr.completedRunCount > 0
                        ? "text-muted-foreground"
                        : "text-destructive",
                    )}
                  >
                    {vr.completedRunCount} completed run
                    {vr.completedRunCount !== 1 ? "s" : ""} ·{" "}
                    {vr.totalOutputCount} output
                    {vr.totalOutputCount !== 1 ? "s" : ""}
                  </span>
                </div>
              ))}
              {availableRuns.totalCompletedRuns === 0 && (
                <div className="flex items-start gap-2 text-xs text-destructive mt-2">
                  <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span>
                    No completed runs found. Run your prompt versions against
                    test cases first, then come back to create a cycle.
                  </span>
                </div>
              )}
            </div>
          )}

          <div>
            <label className="flex items-center gap-2">
              <Checkbox
                checked={useAutoPool}
                onCheckedChange={(checked) =>
                  setUseAutoPool(checked === true)
                }
              />
              <span className="text-sm">
                Auto-select latest completed run per test case
              </span>
              <Badge variant="secondary" className="text-[10px]">
                Recommended
              </Badge>
            </label>
          </div>

          {!useAutoPool && (
            <div className="space-y-3">
              <h4 className="text-sm font-medium">
                Select runs to pool
              </h4>
              {primaryRuns === undefined ? (
                <Skeleton className="h-20 w-full" />
              ) : (
                <RunSelector
                  label={`v${primaryVersion?.versionNumber ?? "?"} runs`}
                  runs={primaryRuns}
                  selectedRunIds={selectedRunIds}
                  onToggle={(id) => {
                    setSelectedRunIds((prev) => {
                      const next = new Set(prev);
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                      return next;
                    });
                  }}
                />
              )}
              {controlVersionId && controlRuns !== undefined && (
                <RunSelector
                  label={`v${controlVersion?.versionNumber ?? "?"} runs (control)`}
                  runs={controlRuns}
                  selectedRunIds={selectedRunIds}
                  onToggle={(id) => {
                    setSelectedRunIds((prev) => {
                      const next = new Set(prev);
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                      return next;
                    });
                  }}
                />
              )}
            </div>
          )}

          <div className="flex gap-2">
            <Button variant="outline" onClick={goBack} className="flex-1">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
            <Button
              onClick={goNext}
              disabled={
                availableRuns !== undefined &&
                availableRuns.totalCompletedRuns === 0
              }
              className="flex-1"
            >
              Next: Assign Evaluators
              <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
          </div>
        </div>
      )}

      {/* Step 3: Evaluator Assignment */}
      {step === "evaluators" && (
        <div className="space-y-6">
          <div>
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">
                Assign Evaluators
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Select team members to evaluate this cycle. They'll receive a
              notification and evaluation link.
            </p>
          </div>

          {evaluators.length === 0 ? (
            <div className="rounded-lg border border-dashed p-6 text-center">
              <Users className="mx-auto h-8 w-8 text-muted-foreground/40" />
              <p className="mt-2 text-sm font-medium text-muted-foreground">
                No evaluators on this project
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Invite collaborators with the "evaluator" role in project
                settings, then come back to assign them.
              </p>
            </div>
          ) : (
            <div className="space-y-1.5">
              {evaluators.map((evaluator) => (
                <label
                  key={evaluator.userId}
                  className={cn(
                    "flex items-center gap-3 rounded-lg border px-4 py-3 cursor-pointer transition-colors",
                    selectedEvaluatorIds.has(evaluator.userId as string)
                      ? "border-primary/30 bg-primary/5"
                      : "hover:bg-muted/50",
                  )}
                >
                  <Checkbox
                    checked={selectedEvaluatorIds.has(
                      evaluator.userId as string,
                    )}
                    onCheckedChange={() => {
                      setSelectedEvaluatorIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(evaluator.userId as string)) {
                          next.delete(evaluator.userId as string);
                        } else {
                          next.add(evaluator.userId as string);
                        }
                        return next;
                      });
                    }}
                  />
                  <div>
                    <span className="text-sm font-medium">
                      {evaluator.name ?? "Unknown"}
                    </span>
                    {evaluator.email && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {evaluator.email}
                      </span>
                    )}
                  </div>
                </label>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <Button variant="outline" onClick={goBack} className="flex-1">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
            <Button
              onClick={goNext}
              disabled={selectedEvaluatorIds.size === 0}
              className="flex-1"
            >
              Next: Review
              <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
          </div>
        </div>
      )}

      {/* Step 4: Review & Start */}
      {step === "review" && (
        <div className="space-y-6">
          <div>
            <Label className="text-sm font-medium">Cycle Name</Label>
            <Input
              className="mt-2"
              placeholder={`Cycle — v${primaryVersion?.versionNumber ?? "?"}${controlVersion ? ` vs v${controlVersion.versionNumber}` : ""}`}
              value={cycleName}
              onChange={(e) => setCycleName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Leave blank for auto-generated name
            </p>
          </div>

          <div className="rounded-lg border p-4 space-y-3">
            <h4 className="text-sm font-medium">Summary</h4>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <span className="text-muted-foreground">Primary:</span>{" "}
                <span className="font-medium">
                  v{primaryVersion?.versionNumber}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">Control:</span>{" "}
                <span className="font-medium">
                  {controlVersion
                    ? `v${controlVersion.versionNumber}`
                    : "None"}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">Pool mode:</span>{" "}
                <span className="font-medium">
                  {useAutoPool
                    ? "Auto (latest per test case)"
                    : `Manual (${selectedRunIds.size} runs)`}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">Evaluators:</span>{" "}
                <span className="font-medium">
                  {selectedEvaluatorIds.size}
                </span>
              </div>
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex gap-2">
            <Button variant="outline" onClick={goBack} className="flex-1">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
            <Button
              onClick={handleCreateAndStart}
              disabled={saving}
              className="flex-1"
            >
              <Play className="h-4 w-4 mr-2" />
              {saving ? "Creating..." : "Start Review Cycle"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: RunSelector
// ---------------------------------------------------------------------------

interface RunSelectorProps {
  label: string;
  runs: Array<{
    _id: string;
    model: string;
    status: string;
    testCaseId?: string | null;
    triggeredByName?: string | null;
    _creationTime: number;
  }>;
  selectedRunIds: Set<string>;
  onToggle: (id: string) => void;
}

function RunSelector({
  label,
  runs,
  selectedRunIds,
  onToggle,
}: RunSelectorProps) {
  const completedRuns = runs.filter((r) => r.status === "completed");

  return (
    <div>
      <h5 className="text-xs font-medium text-muted-foreground mb-1.5">
        {label}
      </h5>
      {completedRuns.length === 0 ? (
        <p className="text-xs text-muted-foreground/60 ml-2">
          No completed runs
        </p>
      ) : (
        <div className="space-y-1">
          {completedRuns.map((run) => (
            <label
              key={run._id}
              className={cn(
                "flex items-center gap-3 rounded border px-3 py-2 cursor-pointer transition-colors text-sm",
                selectedRunIds.has(run._id)
                  ? "border-primary/30 bg-primary/5"
                  : "hover:bg-muted/50",
              )}
            >
              <Checkbox
                checked={selectedRunIds.has(run._id)}
                onCheckedChange={() => onToggle(run._id)}
              />
              <span>
                {run.testCaseId ? "Test case run" : "Quick run"}{" "}
                <span className="text-xs text-muted-foreground">
                  {run.model}
                </span>
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
