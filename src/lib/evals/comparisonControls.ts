export type VisibleComparisonChoice =
  | "first"
  | "second"
  | "same"
  | "neither"
  | "cannot_judge";

export function comparisonChoiceForKey(key: string): VisibleComparisonChoice | null {
  if (key === "ArrowLeft") return "first";
  if (key === "ArrowRight") return "second";
  if (key === "=") return "same";
  if (key.toLowerCase() === "n") return "neither";
  if (key.toLowerCase() === "s") return "cannot_judge";
  return null;
}

export function comparisonChoiceForSwipe(
  horizontalOffset: number,
  threshold = 90,
): "first" | "second" | null {
  if (horizontalOffset < -threshold) return "first";
  if (horizontalOffset > threshold) return "second";
  return null;
}
