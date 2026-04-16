import { cn } from "@/lib/utils";
import { RATING_STYLES, type Rating } from "@/lib/status-styles";

export type { Rating };

export const RATINGS: { value: Rating; label: string }[] = [
  { value: "best", label: "Best" },
  { value: "acceptable", label: "Acceptable" },
  { value: "weak", label: "Weak" },
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
      {RATINGS.map(({ value, label }) => {
        const config = RATING_STYLES[value];
        const Icon = config.icon;
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
              "inline-flex min-h-11 items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium transition-colors sm:min-h-0 sm:gap-1 sm:px-2 sm:py-1 sm:text-xs",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
              "motion-safe:transition-all motion-safe:duration-150",
              isSelected
                ? config.className
                : "border-border text-muted-foreground hover:bg-muted/50",
            )}
          >
            <Icon className="h-4 w-4 sm:h-3 sm:w-3" />
            {label}
          </button>
        );
      })}
    </div>
  );
}
