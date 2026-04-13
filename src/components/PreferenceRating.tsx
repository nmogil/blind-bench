import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { ThumbsUp, Check, ThumbsDown } from "lucide-react";

type Rating = "best" | "acceptable" | "weak";

interface PreferenceRatingAuthProps {
  mode: "auth";
  outputId: Id<"runOutputs">;
  runId: Id<"promptRuns">;
}

interface PreferenceRatingEvalProps {
  mode: "eval";
  opaqueToken: string;
  blindLabel: string;
}

type PreferenceRatingProps = PreferenceRatingAuthProps | PreferenceRatingEvalProps;

const RATINGS: { value: Rating; label: string; icon: typeof ThumbsUp; activeClass: string }[] = [
  {
    value: "best",
    label: "Best",
    icon: ThumbsUp,
    activeClass: "bg-green-100 text-green-700 border-green-300 dark:bg-green-900/30 dark:text-green-300 dark:border-green-700",
  },
  {
    value: "acceptable",
    label: "Acceptable",
    icon: Check,
    activeClass: "bg-gray-100 text-gray-700 border-gray-300 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600",
  },
  {
    value: "weak",
    label: "Weak",
    icon: ThumbsDown,
    activeClass: "bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700",
  },
];

export function PreferenceRating(props: PreferenceRatingProps) {
  if (props.mode === "auth") {
    return <AuthPreferenceRating {...props} />;
  }
  return <EvalPreferenceRating {...props} />;
}

function AuthPreferenceRating({ outputId, runId }: PreferenceRatingAuthProps) {
  const myRatings = useQuery(api.outputPreferences.getMyRatingsForRun, { runId });
  const rateOutput = useMutation(api.outputPreferences.rateOutput);
  const clearRating = useMutation(api.outputPreferences.clearRating);

  const currentRating = myRatings?.find((r) => r.outputId === outputId)?.rating ?? null;

  const handleClick = async (rating: Rating) => {
    if (currentRating === rating) {
      await clearRating({ outputId });
    } else {
      await rateOutput({ outputId, rating });
    }
  };

  return <RatingButtons currentRating={currentRating} onRate={handleClick} />;
}

function EvalPreferenceRating({ opaqueToken, blindLabel }: PreferenceRatingEvalProps) {
  const myRatings = useQuery(api.outputPreferences.getMyRatingsByToken, { opaqueToken });
  const rateOutput = useMutation(api.outputPreferences.rateOutputByToken);
  const clearRating = useMutation(api.outputPreferences.clearRatingByToken);

  const currentRating = myRatings?.find((r) => r.blindLabel === blindLabel)?.rating ?? null;

  const handleClick = async (rating: Rating) => {
    if (currentRating === rating) {
      await clearRating({ opaqueToken, blindLabel });
    } else {
      await rateOutput({ opaqueToken, blindLabel, rating });
    }
  };

  return <RatingButtons currentRating={currentRating} onRate={handleClick} />;
}

function RatingButtons({
  currentRating,
  onRate,
}: {
  currentRating: Rating | null;
  onRate: (rating: Rating) => void;
}) {
  return (
    <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Rate this output">
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
