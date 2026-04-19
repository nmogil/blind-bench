import { useEffect, useRef } from "react";
import { useMutation } from "convex/react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Skeleton } from "@/components/ui/skeleton";
import { friendlyError } from "@/lib/errors";

type Scope = "run" | "cycle";

function useStartSession(scope: Scope) {
  const params = useParams<{ runId?: string; cycleId?: string }>();
  const navigate = useNavigate();
  const start = useMutation(api.reviewSessions.start);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    const runId = scope === "run" ? params.runId : undefined;
    const cycleId = scope === "cycle" ? params.cycleId : undefined;
    if (!runId && !cycleId) return;
    started.current = true;
    void start({
      runId: runId as Id<"promptRuns"> | undefined,
      cycleId: cycleId as Id<"reviewCycles"> | undefined,
    })
      .then((sessionId) => {
        navigate(`/review/session/${sessionId}`, { replace: true });
      })
      .catch((err) => {
        started.current = false;
        toast.error(friendlyError(err, "Failed to start review."));
        navigate(-1);
      });
  }, [scope, params.runId, params.cycleId, navigate, start]);
}

export function ReviewRunStarter() {
  useStartSession("run");
  return <StarterFallback />;
}

export function ReviewCycleStarter() {
  useStartSession("cycle");
  return <StarterFallback />;
}

function StarterFallback() {
  return (
    <div className="flex h-dvh items-center justify-center">
      <Skeleton className="h-8 w-48" />
    </div>
  );
}
