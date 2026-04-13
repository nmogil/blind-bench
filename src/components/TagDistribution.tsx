import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { TAG_COLORS, TAG_LABELS } from "./FeedbackTagPicker";
import { cn } from "@/lib/utils";

interface TagDistributionProps {
  versionId: Id<"promptVersions">;
  onTagClick?: (tag: string) => void;
}

export function TagDistribution({ versionId, onTagClick }: TagDistributionProps) {
  const distribution = useQuery(api.feedback.getTagDistribution, { versionId });

  if (!distribution) return null;

  const entries = Object.entries(distribution)
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a);

  if (entries.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {entries.map(([tag, count]) => (
        <button
          key={tag}
          type="button"
          onClick={() => onTagClick?.(tag)}
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
            TAG_COLORS[tag] ?? "bg-gray-100 text-gray-700",
            onTagClick && "cursor-pointer hover:opacity-80",
            !onTagClick && "cursor-default",
          )}
        >
          {TAG_LABELS[tag] ?? tag}
          <span className="opacity-60">({count})</span>
        </button>
      ))}
    </div>
  );
}
