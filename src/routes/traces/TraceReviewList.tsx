/**
 * #271 (M31): blind reviewer's cross-project discovery list of trajectories to
 * review. Rendered under EvalLayout at /eval/traces — no org/project context.
 * Reads everything from `listReviewableTraces`; for blind reviewers the backend
 * strips product/harness/model, so those rows show only the project name and
 * step count. No real ids or provenance attributes reach the DOM.
 */
import { useQuery } from "convex/react";
import { Link } from "react-router-dom";
import { api } from "../../../convex/_generated/api";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Route, ArrowRight } from "lucide-react";

type TraceStatus = "pending" | "ready" | "failed";

function StatusBadge({ status }: { status: string }) {
  const s = status as TraceStatus;
  if (s === "failed") {
    return <Badge variant="destructive">Failed</Badge>;
  }
  if (s === "pending") {
    return <Badge variant="outline">Processing</Badge>;
  }
  return <Badge variant="secondary">Ready</Badge>;
}

export function TraceReviewList() {
  const traces = useQuery(api.agentTraces.listReviewableTraces, {});

  return (
    <div className="mx-auto max-w-3xl p-6">
      <header>
        <div className="flex items-center gap-2">
          <Route aria-hidden="true" className="h-5 w-5 text-primary" />
          <h1 className="text-2xl font-bold">Trajectories to review</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Review each imported agent run step by step — every message, tool
          call, and result in order.
        </p>
      </header>

      <div className="mt-6">
        {traces === undefined ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : traces.length === 0 ? (
          <div className="max-w-lg space-y-3 rounded-lg border border-dashed p-6">
            <p className="text-sm">
              No trajectories assigned to review yet. When a teammate shares an
              agent run with you, it will show up here.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {traces.map((t) => {
              const provenance = [t.product, t.harnessName, t.model].filter(
                Boolean,
              );
              return (
                <li key={t._id}>
                  <Link
                    to={`/eval/traces/${t._id}`}
                    className="flex items-center justify-between gap-4 rounded-lg border bg-card px-4 py-3 transition-colors hover:bg-muted/50"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {t.projectName}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {provenance.length > 0 && (
                          <>{provenance.join(" · ")} · </>
                        )}
                        {t.stepCount} {t.stepCount === 1 ? "step" : "steps"}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <StatusBadge status={t.status} />
                      <ArrowRight
                        aria-hidden="true"
                        className="h-4 w-4 text-muted-foreground"
                      />
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
