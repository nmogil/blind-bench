import { cn } from "@/lib/utils";
import { ThumbsUp, Check, ThumbsDown } from "lucide-react";

export type Rating = "best" | "acceptable" | "weak";

export const RATINGS: {
  value: Rating;
  label: string;
  icon: typeof ThumbsUp;
  activeClass: string;
}[] = [
  {
    value: "best",
    label: "Best",
    icon: ThumbsUp,
    activeClass:
      "bg-green-100 text-green-700 border-green-300 dark:bg-green-900/30 dark:text-green-300 dark:border-green-700",
  },
  {
    value: "acceptable",
    label: "Acceptable",
    icon: Check,
    activeClass:
      "bg-gray-100 text-gray-700 border-gray-300 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600",
  },
  {
    value: "weak",
    label: "Weak",
    icon: ThumbsDown,
    activeClass:
      "bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700",
  },
];

export function RatingButtons({
  currentRating,
  onRate,
}: {
  currentRating: Rating | null;
  onRate: (rating: Rating) => void;
}) {
  return (
    <div
      className="flex items-center gap-1.5 shrink-0"
      role="radiogroup"
      aria-label="Rate this output"
    >
      {RATINGS.map(({ value, label, icon: Icon, activeClass }) => {
        const isSelected = currentRating === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={isSelected}
            aria-label={label}
            onClick={() => onRate(value)}
            className={cn(
              "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
              "motion-safe:transition-all motion-safe:duration-150",
              isSelected
                ? activeClass
                : "border-border text-muted-foreground hover:bg-muted/50",
            )}
          >
            <Icon className="h-3 w-3" />
            {label}
          </button>
        );
      })}
    </div>
  );
}
