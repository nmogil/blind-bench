import { useQuery } from "convex/react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../../../../convex/_generated/api";
import { useProject } from "@/contexts/ProjectContext";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowRight, BarChart3, GitCompareArrows, ListChecks } from "lucide-react";

/** Aggregated owner entry point for collecting and completed human-review evidence. */
export function ReviewResults() {
  const { projectId } = useProject();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const navigate = useNavigate();
  const verdictReviews = useQuery(api.verdictReviewCampaigns.listCampaigns, { projectId });
  const comparisons = useQuery(api.comparisonCampaigns.listCampaigns, { projectId });
  const base = `/orgs/${orgSlug}/projects/${projectId}`;

  if (verdictReviews === undefined || comparisons === undefined) {
    return <div className="space-y-3 p-6">{[1, 2, 3].map((key) => <Skeleton key={key} className="h-20 w-full max-w-3xl" />)}</div>;
  }

  const rows: ReadonlyArray<ResultRow> = [
    ...verdictReviews.map((review) => ({
      id: String(review.id),
      mode: "verdict" as const,
      name: review.name,
      status: review.status,
      href: `${base}/reviews/verdict/${review.id}`,
      coverage: `${review.reviewedRuns}/${review.itemCount} runs reviewed`,
      judgments: review.judgments,
      reviewers: review.reviewers,
      createdAt: review.createdAt,
    })),
    ...comparisons.map((review) => ({
      id: String(review.id),
      mode: "comparison" as const,
      name: review.name,
      status: review.status === "importing" ? "draft" as const : review.status,
      href: `${base}/comparisons/${review.id}`,
      coverage: `${review.judgments} judgments across ${review.caseCount} pairs`,
      judgments: review.judgments,
      reviewers: 0,
      createdAt: review.createdAt,
    })),
  ].sort((left, right) => right.createdAt - left.createdAt);
  const collecting = rows.filter((row) => row.status !== "closed");
  const completed = rows.filter((row) => row.status === "closed");

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-xl font-semibold">Results</h1>
        <p className="mt-1 text-sm text-muted-foreground">Coverage, verdicts, disagreement, comments, and reuse actions from blind human review.</p>
      </header>

      {rows.length === 0 ? (
        <EmptyState
          icon={BarChart3}
          heading="Results appear after people review your runs"
          description="Create a blind review, share the link, and return here to reuse the evidence."
          action={{ label: "Create review", onClick: () => navigate(`${base}/reviews/new`) }}
        />
      ) : (
        <div className="max-w-3xl space-y-7">
          {collecting.length > 0 && <ResultSection title="Collecting" rows={collecting} />}
          {completed.length > 0 && <ResultSection title="Closed and reusable" rows={completed} />}
        </div>
      )}
    </div>
  );
}

type ResultRow = {
  readonly id: string;
  readonly mode: "verdict" | "comparison";
  readonly name: string;
  readonly status: "draft" | "open" | "closed";
  readonly href: string;
  readonly coverage: string;
  readonly judgments: number;
  readonly reviewers: number;
  readonly createdAt: number;
};

function ResultSection({ title, rows }: { readonly title: string; readonly rows: ReadonlyArray<ResultRow> }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      {rows.map((row) => {
        const Icon = row.mode === "verdict" ? ListChecks : GitCompareArrows;
        return (
          <Link key={`${row.mode}-${row.id}`} to={row.href} className="flex items-center justify-between gap-4 rounded-lg border px-4 py-3 transition-colors hover:bg-muted/50">
            <div className="flex min-w-0 items-center gap-3">
              <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
              <div className="min-w-0">
                <div className="flex items-center gap-2"><p className="truncate text-sm font-medium">{row.name}</p><Badge variant="outline" className="text-[10px] capitalize">{row.status}</Badge></div>
                <p className="mt-0.5 text-xs text-muted-foreground">{row.coverage}{row.reviewers > 0 ? ` · ${row.reviewers} reviewers` : ""}</p>
              </div>
            </div>
            <ArrowRight aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
          </Link>
        );
      })}
    </section>
  );
}
