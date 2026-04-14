import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { useProject } from "@/contexts/ProjectContext";
import { useOrg } from "@/contexts/OrgContext";
import { EmptyState } from "@/components/EmptyState";
import { StreamingOutputPanel } from "@/components/StreamingOutputPanel";
import { VersionMultiPicker } from "@/components/VersionMultiPicker";
import { VersionStatusPill } from "@/components/VersionStatusPill";
import { RunStatusPill } from "@/components/RunStatusPill";
import { ModelPicker } from "@/components/ModelPicker";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { friendlyError } from "@/lib/errors";
import { GitCompareArrows, Play } from "lucide-react";
import { toast } from "sonner";

export function CompareView() {
  const { projectId } = useProject();
  const { orgId } = useOrg();
  const { orgSlug } = useParams<{ orgSlug: string }>();

  // Selections
  const [selectedTestCaseId, setSelectedTestCaseId] = useState("");
  const [selectedVersionIds, setSelectedVersionIds] = useState<Set<string>>(
    new Set(),
  );
  const [model, setModel] = useState("google/gemini-2.0-flash-001");
  const [temperature, setTemperature] = useState(0.7);
  const [running, setRunning] = useState(false);

  // Data
  const versions = useQuery(api.versions.list, { projectId });
  const testCases = useQuery(api.testCases.list, { projectId });
  const hasKey = useQuery(api.openRouterKeys.hasKey, { orgId });

  const canCompare =
    selectedTestCaseId && selectedVersionIds.size >= 2 && hasKey;

  // Comparison data — reactive, updates as runs complete
  const comparisonData = useQuery(
    api.runs.compareAcrossVersions,
    canCompare
      ? {
          projectId,
          testCaseId: selectedTestCaseId as Id<"testCases">,
          versionIds: [...selectedVersionIds] as Id<"promptVersions">[],
        }
      : "skip",
  );

  const executeRun = useMutation(api.runs.execute);

  async function handleRunComparison() {
    if (!comparisonData) return;
    setRunning(true);
    try {
      const missing = comparisonData.filter(
        (r) => !r.run || r.run.status === "failed",
      );
      for (const result of missing) {
        await executeRun({
          versionId: result.versionId as Id<"promptVersions">,
          testCaseId: selectedTestCaseId as Id<"testCases">,
          model,
          temperature,
        });
      }
      if (missing.length === 0) {
        toast.info("All versions already have completed runs for this test case.");
      }
    } catch (err) {
      toast.error(friendlyError(err));
    } finally {
      setRunning(false);
    }
  }

  if (versions === undefined || testCases === undefined) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-2 gap-4">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  const anyMissing =
    comparisonData?.some((r) => !r.run || r.run.status === "failed") ?? false;

  return (
    <div className="flex flex-col h-full">
      {/* Controls bar */}
      <div className="flex flex-wrap items-end gap-3 border-b px-4 py-3">
        <div className="space-y-1">
          <Label className="text-xs">Test case</Label>
          <Select
            value={selectedTestCaseId}
            onValueChange={(v) => {
              if (v) setSelectedTestCaseId(v);
            }}
          >
            <SelectTrigger className="h-8 text-xs w-48">
              <SelectValue placeholder="Select test case" />
            </SelectTrigger>
            <SelectContent>
              {testCases.map((tc) => (
                <SelectItem key={tc._id} value={tc._id} className="text-xs">
                  {tc.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label className="text-xs">Versions (2-5)</Label>
          <VersionMultiPicker
            versions={versions}
            selected={selectedVersionIds}
            onChange={setSelectedVersionIds}
          />
        </div>

        <div className="space-y-1">
          <Label className="text-xs">Model</Label>
          <ModelPicker value={model} onChange={setModel} />
        </div>

        <div className="space-y-1">
          <Label className="text-xs">Temp</Label>
          <Input
            type="number"
            min={0}
            max={2}
            step={0.1}
            value={temperature}
            onChange={(e) => setTemperature(parseFloat(e.target.value) || 0.7)}
            className="h-8 w-16 text-xs"
          />
        </div>

        <Button
          size="sm"
          disabled={!canCompare || running}
          onClick={handleRunComparison}
          className="gap-1"
        >
          <Play className="h-3 w-3" />
          {running ? "Running..." : anyMissing ? "Run comparison" : "Re-run all"}
        </Button>
      </div>

      {/* Cross-link to RunConfigurator */}
      <div className="px-4 py-1.5 border-b bg-muted/30">
        <p className="text-xs text-muted-foreground">
          Quick comparison for a single test case.{" "}
          <Link
            to={`/orgs/${orgSlug}/projects/${projectId}/run`}
            className="text-primary hover:underline"
          >
            Use the Run Configurator
          </Link>{" "}
          for batch runs across multiple test cases.
        </p>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-auto p-4">
        {!selectedTestCaseId || selectedVersionIds.size < 2 ? (
          <EmptyState
            icon={GitCompareArrows}
            heading="Compare versions"
            description="Pick a test case and at least two versions to compare."
          />
        ) : !comparisonData ? (
          <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${selectedVersionIds.size}, 1fr)` }}>
            {[...selectedVersionIds].map((id) => (
              <Skeleton key={id} className="h-64" />
            ))}
          </div>
        ) : (
          <div
            className="grid gap-4"
            style={{
              gridTemplateColumns: `repeat(${comparisonData.length}, 1fr)`,
            }}
          >
            {comparisonData.map((col) => (
              <ComparisonColumn key={col.versionId} data={col} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface ComparisonColumnProps {
  data: {
    versionId: string;
    versionNumber: number;
    versionStatus: string;
    sourceVersionId: string | null;
    run: {
      _id: string;
      status: string;
      model: string;
      temperature: number;
      mode?: string;
      _creationTime?: number;
    } | null;
    outputs: Array<{
      _id: string;
      runId: string;
      blindLabel: string;
      outputContent: string;
      model?: string;
      temperature?: number;
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      latencyMs?: number;
    }>;
    hasCompletedRun: boolean;
  };
}

function ComparisonColumn({ data }: ComparisonColumnProps) {
  return (
    <div className="flex flex-col gap-2 min-w-0">
      {/* Version header */}
      <div className="flex items-center gap-2 pb-2 border-b">
        <span className="font-semibold text-sm">v{data.versionNumber}</span>
        <VersionStatusPill status={data.versionStatus} />
        {data.sourceVersionId && (
          <span className="text-xs text-muted-foreground italic">
            rolled back
          </span>
        )}
        {data.run && <RunStatusPill status={data.run.status} />}
      </div>

      {/* Outputs */}
      {data.run && data.outputs.length > 0 ? (
        data.outputs.map((output) => {
          const isMix = data.run!.mode === "mix";
          return (
            <StreamingOutputPanel
              key={output._id}
              output={output as any}
              runStatus={data.run!.status}
              canAnnotate={data.run!.status === "completed"}
              resolvedModel={isMix ? (output.model ?? data.run!.model) : undefined}
              resolvedTemperature={isMix ? (output.temperature ?? data.run!.temperature) : undefined}
            />
          );
        })
      ) : (
        <div className="flex items-center justify-center h-48 rounded-lg border bg-muted/30 text-sm text-muted-foreground">
          {data.hasCompletedRun
            ? "No outputs"
            : "No run yet. Click Run comparison."}
        </div>
      )}
    </div>
  );
}
