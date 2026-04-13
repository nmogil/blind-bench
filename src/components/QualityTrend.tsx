import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { useNavigate, useParams } from "react-router-dom";
import { TrendInsight } from "./TrendInsight";
import { useState } from "react";

interface QualityTrendProps {
  projectId: Id<"projects">;
}

export function QualityTrend({ projectId }: QualityTrendProps) {
  const data = useQuery(api.analytics.getQualityTrend, { projectId });
  const navigate = useNavigate();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  if (!data || data.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-3">
        <p className="text-xs text-muted-foreground">
          Run prompts and collect feedback to see quality trends.
        </p>
      </div>
    );
  }

  const hasPreferences = data.some((d) => d.preferenceScore !== null);
  const withFeedback = data.filter((d) => d.feedbackCount > 0 || d.totalRatings > 0);

  if (withFeedback.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-3">
        <p className="text-xs text-muted-foreground">
          No feedback yet. Leave comments and ratings on run outputs to see trends.
        </p>
      </div>
    );
  }

  // Chart dimensions
  const width = 400;
  const height = 140;
  const padding = { top: 16, right: 16, bottom: 24, left: 32 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const maxFeedback = Math.max(...withFeedback.map((d) => d.feedbackCount), 1);
  const xScale = (i: number) =>
    padding.left + (withFeedback.length === 1 ? chartW / 2 : (i / (withFeedback.length - 1)) * chartW);
  const yScoreScale = (score: number) =>
    padding.top + chartH - score * chartH;
  const yBarScale = (count: number) =>
    (count / maxFeedback) * chartH;

  // Build score line path
  const scorePoints = withFeedback
    .map((d, i) =>
      d.preferenceScore !== null
        ? `${xScale(i)},${yScoreScale(d.preferenceScore)}`
        : null,
    )
    .filter(Boolean);
  const linePath =
    scorePoints.length >= 2
      ? `M${scorePoints.join("L")}`
      : null;

  function handleClick(d: typeof withFeedback[0]) {
    if (orgSlug) {
      navigate(`/orgs/${orgSlug}/projects/${projectId}/versions/${d.versionId}`);
    }
  }

  return (
    <div className="rounded-lg border p-3 space-y-2">
      <h4 className="text-xs font-medium uppercase text-muted-foreground">
        Quality Trend
      </h4>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        role="img"
        aria-label="Quality trend chart"
      >
        {/* Y-axis labels */}
        {hasPreferences && (
          <>
            <text x={padding.left - 4} y={padding.top + 4} textAnchor="end" className="fill-muted-foreground text-[9px]">1.0</text>
            <text x={padding.left - 4} y={padding.top + chartH / 2 + 3} textAnchor="end" className="fill-muted-foreground text-[9px]">0.5</text>
            <text x={padding.left - 4} y={padding.top + chartH + 3} textAnchor="end" className="fill-muted-foreground text-[9px]">0.0</text>
          </>
        )}

        {/* Feedback volume bars */}
        {withFeedback.map((d, i) => (
          <rect
            key={`bar-${i}`}
            x={xScale(i) - 8}
            y={padding.top + chartH - yBarScale(d.feedbackCount)}
            width={16}
            height={yBarScale(d.feedbackCount)}
            className="fill-muted/40"
            rx={2}
          />
        ))}

        {/* Score line */}
        {linePath && (
          <path
            d={linePath}
            fill="none"
            strokeWidth={2}
            className="stroke-primary"
          />
        )}

        {/* Data points */}
        {withFeedback.map((d, i) => (
          <g key={`point-${i}`}>
            {d.preferenceScore !== null && (
              <circle
                cx={xScale(i)}
                cy={yScoreScale(d.preferenceScore)}
                r={hoveredIndex === i ? 5 : 3.5}
                className="fill-primary cursor-pointer"
                onMouseEnter={() => setHoveredIndex(i)}
                onMouseLeave={() => setHoveredIndex(null)}
                onClick={() => handleClick(d)}
                role="button"
                tabIndex={0}
                aria-label={`Version ${d.versionNumber}: score ${d.preferenceScore.toFixed(2)}`}
                onKeyDown={(e) => { if (e.key === "Enter") handleClick(d); }}
              />
            )}
            {/* X-axis label */}
            <text
              x={xScale(i)}
              y={height - 4}
              textAnchor="middle"
              className="fill-muted-foreground text-[9px]"
            >
              v{d.versionNumber}
            </text>
          </g>
        ))}

        {/* Tooltip */}
        {hoveredIndex !== null && (() => {
          const d = withFeedback[hoveredIndex]!;
          const tx = xScale(hoveredIndex);
          const ty = d.preferenceScore !== null
            ? yScoreScale(d.preferenceScore) - 12
            : padding.top;
          return (
            <text
              x={Math.min(Math.max(tx, 40), width - 40)}
              y={ty}
              textAnchor="middle"
              className="fill-foreground text-[10px] font-medium"
            >
              {d.preferenceScore !== null
                ? `Score: ${d.preferenceScore.toFixed(2)} · ${d.feedbackCount} feedback`
                : `${d.feedbackCount} feedback`}
            </text>
          );
        })()}
      </svg>

      {!hasPreferences && (
        <p className="text-[10px] text-muted-foreground">
          Add preference ratings to see quality scores on this chart.
        </p>
      )}

      <TrendInsight data={withFeedback} />
    </div>
  );
}
