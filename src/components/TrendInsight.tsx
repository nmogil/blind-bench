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
    <p className="text-xs text-muted-foreground italic">
      <span>{insight.fact}</span>{" "}
      <span className="not-italic">{insight.suggestion}</span>
    </p>
  );
}

interface Insight {
  fact: string;
  suggestion: string;
}

function computeInsight(data: TrendDataPoint[]): Insight | null {
  // Preference score trend
  const withScores = data.filter((d) => d.preferenceScore !== null);
  if (withScores.length >= 2) {
    const first = withScores[0]!;
    const last = withScores[withScores.length - 1]!;
    const diff = last.preferenceScore! - first.preferenceScore!;
    if (Math.abs(diff) >= 0.1) {
      const improved = diff > 0;
      return {
        fact: `Quality ${improved ? "improved" : "declined"} from v${first.versionNumber} to v${last.versionNumber} (${first.preferenceScore!.toFixed(2)} → ${last.preferenceScore!.toFixed(2)}).`,
        suggestion: improved
          ? `Consider promoting v${last.versionNumber} and running a fresh review cycle.`
          : `Review what changed between v${first.versionNumber} and v${last.versionNumber}.`,
      };
    }
  }

  // Feedback volume trend
  if (data.length >= 2) {
    const first = data[0]!;
    const last = data[data.length - 1]!;
    if (first.feedbackCount > 0 && last.feedbackCount > first.feedbackCount * 2) {
      const ratio = Math.round(last.feedbackCount / first.feedbackCount);
      return {
        fact: `Feedback volume increased ${ratio}× from v${first.versionNumber} to v${last.versionNumber}.`,
        suggestion: `Open v${last.versionNumber}'s dashboard to triage the new comments.`,
      };
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
    return {
      fact: `"${topTag[0]}" is the most flagged issue across versions (${topTag[1]} mentions).`,
      suggestion: `Target this in the next revision.`,
    };
  }

  // Total feedback summary
  const totalFeedback = data.reduce((sum, d) => sum + d.feedbackCount, 0);
  if (totalFeedback > 0) {
    return {
      fact: `${totalFeedback} total feedback items across ${data.length} version${data.length !== 1 ? "s" : ""}.`,
      suggestion: `Open a version's dashboard to dig in.`,
    };
  }

  return null;
}
