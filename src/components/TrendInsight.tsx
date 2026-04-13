interface TrendDataPoint {
  versionNumber: number;
  feedbackCount: number;
  totalRatings: number;
  preferenceScore: number | null;
  tagDistribution: Record<string, number> | null;
}

interface TrendInsightProps {
  data: TrendDataPoint[];
}

export function TrendInsight({ data }: TrendInsightProps) {
  if (data.length === 0) return null;

  const insight = computeInsight(data);
  if (!insight) return null;

  return (
    <p className="text-xs text-muted-foreground italic">{insight}</p>
  );
}

function computeInsight(data: TrendDataPoint[]): string | null {
  // Preference score trend
  const withScores = data.filter((d) => d.preferenceScore !== null);
  if (withScores.length >= 2) {
    const first = withScores[0]!;
    const last = withScores[withScores.length - 1]!;
    const diff = last.preferenceScore! - first.preferenceScore!;
    if (Math.abs(diff) >= 0.1) {
      const direction = diff > 0 ? "improved" : "declined";
      return `Quality ${direction} from v${first.versionNumber} to v${last.versionNumber} (${first.preferenceScore!.toFixed(2)} → ${last.preferenceScore!.toFixed(2)})`;
    }
  }

  // Feedback volume trend
  if (data.length >= 2) {
    const first = data[0]!;
    const last = data[data.length - 1]!;
    if (first.feedbackCount > 0 && last.feedbackCount > first.feedbackCount * 2) {
      const ratio = Math.round(last.feedbackCount / first.feedbackCount);
      return `Feedback volume increased ${ratio}x from v${first.versionNumber} to v${last.versionNumber}`;
    }
  }

  // Most common tag across all versions
  const allTags: Record<string, number> = {};
  for (const d of data) {
    if (d.tagDistribution) {
      for (const [tag, count] of Object.entries(d.tagDistribution)) {
        allTags[tag] = (allTags[tag] ?? 0) + count;
      }
    }
  }
  const topTag = Object.entries(allTags).sort(([, a], [, b]) => b - a)[0];
  if (topTag && topTag[1] >= 3) {
    return `Most flagged issue across versions: ${topTag[0]} (${topTag[1]} mentions)`;
  }

  // Total feedback summary
  const totalFeedback = data.reduce((sum, d) => sum + d.feedbackCount, 0);
  if (totalFeedback > 0) {
    return `${totalFeedback} total feedback items across ${data.length} version${data.length !== 1 ? "s" : ""}`;
  }

  return null;
}
