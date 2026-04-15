import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { RatingButtons, type Rating } from "@/components/RatingButtons";

interface PreferenceRatingProps {
  outputId: Id<"runOutputs">;
  runId: Id<"promptRuns">;
}

export function PreferenceRating({ outputId, runId }: PreferenceRatingProps) {
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
