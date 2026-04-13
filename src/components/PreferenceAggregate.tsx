import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { ThumbsUp, Check, ThumbsDown } from "lucide-react";

interface PreferenceAggregateProps {
  runId: Id<"promptRuns">;
  outputId: string;
}

export function PreferenceAggregate({ runId, outputId }: PreferenceAggregateProps) {
  const aggregate = useQuery(api.outputPreferences.aggregateForRun, { runId });

  const data = aggregate?.find((a) => a.outputId === outputId);
  if (!data) return null;

  const total = data.bestCount + data.acceptableCount + data.weakCount;
  if (total === 0) return null;

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      {data.bestCount > 0 && (
        <span className="inline-flex items-center gap-0.5 text-green-600 dark:text-green-400">
          <ThumbsUp className="h-3 w-3" />
          {data.bestCount}
        </span>
      )}
      {data.acceptableCount > 0 && (
        <span className="inline-flex items-center gap-0.5 text-gray-500 dark:text-gray-400">
          <Check className="h-3 w-3" />
          {data.acceptableCount}
        </span>
      )}
      {data.weakCount > 0 && (
        <span className="inline-flex items-center gap-0.5 text-amber-600 dark:text-amber-400">
          <ThumbsDown className="h-3 w-3" />
          {data.weakCount}
        </span>
      )}
      <span className="text-muted-foreground/60">
        ({total} rating{total !== 1 ? "s" : ""})
      </span>
    </div>
  );
}
