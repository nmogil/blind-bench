import { useQuery } from "convex/react";
import { useParams, Link } from "react-router-dom";
import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { useProject } from "@/contexts/ProjectContext";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ArrowLeft,
  Play,
  AlertTriangle,
  Info,
  ThumbsUp,
  Check,
  ThumbsDown,
} from "lucide-react";
import { cn } from "@/lib/utils";

export function SoloEvalResults() {
  const { orgSlug, sessionId: sessionIdParam } = useParams<{
    orgSlug: string;
    sessionId: string;
  }>();
  const { projectId } = useProject();
  const sessionId = sessionIdParam as Id<"soloEvalSessions">;
  const results = useQuery(api.soloEval.getResults, { sessionId });

  if (results === undefined) {
    return (
      <div className="p-6 max-w-4xl space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  const basePath = `/orgs/${orgSlug}/projects/${projectId}`;

  return (
    <div className="p-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">Evaluation Results</h2>
        <Link to={`${basePath}/solo-eval`}>
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back
          </Button>
        </Link>
      </div>

      {/* Summary stats */}
      <div className="mt-6 grid grid-cols-3 gap-4">
        <StatCard
          label="Rated"
          value={results.totalRated}
          detail={`of ${results.totalCount}`}
        />
        <StatCard label="Skipped" value={results.totalSkipped} />
        <StatCard
          label="Best"
          value={results.items.filter((i) => i.rating === "best").length}
          detail={`of ${results.totalRated} rated`}
        />
      </div>

      {/* Bias insights */}
      {results.insights.length > 0 && (
        <div className="mt-6 space-y-2">
          {results.insights.map((insight, i) => (
            <div
              key={i}
              className={cn(
                "flex items-start gap-2 rounded-lg border p-3 text-sm",
                insight.severity === "warning"
                  ? "border-amber-200 bg-amber-50/50 dark:border-amber-900/40 dark:bg-amber-950/10"
                  : "border-blue-200 bg-blue-50/50 dark:border-blue-900/40 dark:bg-blue-950/10",
              )}
            >
              {insight.severity === "warning" ? (
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
              ) : (
                <Info className="h-4 w-4 mt-0.5 shrink-0 text-blue-600 dark:text-blue-400" />
              )}
              <p>{insight.message}</p>
            </div>
          ))}
        </div>
      )}

      {/* Per-version summary */}
      {results.versionSummary.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-semibold">Score by version</h3>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {results.versionSummary
              .sort((a, b) => a.versionNumber - b.versionNumber)
              .map((vs) => {
                const total = vs.bestCount + vs.acceptableCount + vs.weakCount;
                const avgScore =
                  total > 0
                    ? (vs.bestCount * 1 + vs.acceptableCount * 0.5) / total
                    : 0;
                return (
                  <div
                    key={vs.versionNumber}
                    className="rounded-lg border p-3"
                  >
                    <p className="text-sm font-medium">
                      v{vs.versionNumber}
                    </p>
                    <p className="text-2xl font-bold mt-1">
                      {avgScore.toFixed(2)}
                    </p>
                    <p className="text-xs text-muted-foreground">avg score</p>
                    <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="flex items-center gap-0.5">
                        <ThumbsUp className="h-3 w-3 text-green-600" />
                        {vs.bestCount}
                      </span>
                      <span className="flex items-center gap-0.5">
                        <Check className="h-3 w-3 text-gray-500" />
                        {vs.acceptableCount}
                      </span>
                      <span className="flex items-center gap-0.5">
                        <ThumbsDown className="h-3 w-3 text-amber-600" />
                        {vs.weakCount}
                      </span>
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
      )}

      {/* Detailed results table */}
      <div className="mt-6">
        <h3 className="text-sm font-semibold">All outputs</h3>
        <div className="mt-3 rounded-lg border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">#</TableHead>
                <TableHead>Rating</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Test Case</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Label</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.items
                .sort((a, b) => a.soloLabel - b.soloLabel)
                .map((item) => (
                  <TableRow key={item.soloLabel}>
                    <TableCell className="font-mono text-xs">
                      {item.soloLabel}
                    </TableCell>
                    <TableCell>
                      {item.rating ? (
                        <RatingBadge rating={item.rating} />
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          skipped
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      v{item.versionNumber}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {item.testCaseName}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground font-mono">
                      {item.model}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[10px]">
                        {item.blindLabel}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Actions */}
      <div className="mt-6 flex items-center gap-3">
        <Link to={`${basePath}/solo-eval`}>
          <Button>
            <Play className="h-4 w-4 mr-2" />
            Start New Evaluation
          </Button>
        </Link>
        <Link to={basePath}>
          <Button variant="outline">Back to Prompt</Button>
        </Link>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: number;
  detail?: string;
}) {
  return (
    <div className="rounded-lg border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-bold mt-0.5">
        {value}
        {detail && (
          <span className="text-sm font-normal text-muted-foreground ml-1">
            {detail}
          </span>
        )}
      </p>
    </div>
  );
}

function RatingBadge({ rating }: { rating: string }) {
  const config = {
    best: {
      label: "Best",
      className:
        "bg-green-100 text-green-700 border-green-300 dark:bg-green-900/30 dark:text-green-300 dark:border-green-700",
    },
    acceptable: {
      label: "OK",
      className:
        "bg-gray-100 text-gray-700 border-gray-300 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600",
    },
    weak: {
      label: "Weak",
      className:
        "bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700",
    },
  }[rating] ?? { label: rating, className: "" };

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
        config.className,
      )}
    >
      {config.label}
    </span>
  );
}
