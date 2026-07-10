import { useQuery } from "convex/react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../../../../convex/_generated/api";
import { useProject } from "@/contexts/ProjectContext";
import { EmptyState } from "@/components/EmptyState";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowRight, ClipboardCheck, EyeOff, ListChecks, Plus } from "lucide-react";

/** Unified owner list for independent run reviews and paired comparisons. */
export function EvaluatePage() {
  const { projectId, role } = useProject();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const navigate = useNavigate();
  const verdictReviews = useQuery(
    api.verdictReviewCampaigns.listCampaigns,
    role !== "evaluator" ? { projectId } : "skip",
  );
  const comparisons = useQuery(
    api.comparisonCampaigns.listCampaigns,
    role !== "evaluator" ? { projectId } : "skip",
  );
  const basePath = `/orgs/${orgSlug}/projects/${projectId}`;

  if (verdictReviews === undefined || comparisons === undefined) {
    return (
      <div className="space-y-4 p-6">
        <div className="flex items-center justify-between"><Skeleton className="h-8 w-32" /><Skeleton className="h-9 w-32" /></div>
        {[1, 2, 3].map((key) => <Skeleton key={key} className="h-20 w-full max-w-2xl" />)}
      </div>
    );
  }

  const hasReviews = verdictReviews.length > 0 || comparisons.length > 0;
  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Reviews</h1>
          <p className="mt-1 text-sm text-muted-foreground">Send completed runs to domain experts without exposing model or harness provenance.</p>
        </div>
        <Link to={`${basePath}/reviews/new`} className={buttonVariants({ size: "sm" })}>
          <Plus className="mr-1.5 h-4 w-4" /> New review
        </Link>
      </div>

      {!hasReviews ? (
        <EmptyState
          icon={ClipboardCheck}
          heading="Create a blind review from completed runs"
          description="Score runs independently or compare two attempts with the same context."
          action={{ label: "Create blind review", onClick: () => navigate(`${basePath}/reviews/new`) }}
        />
      ) : (
        <div className="max-w-2xl space-y-6">
          {verdictReviews.length > 0 && (
            <ReviewSection title="Score runs">
              {verdictReviews.map((review) => (
                <ReviewRow
                  key={review.id}
                  href={`${basePath}/reviews/verdict/${review.id}`}
                  icon={ListChecks}
                  name={review.name}
                  detail={`${review.itemCount} runs · ${review.judgments} judgments · ${review.status}`}
                />
              ))}
            </ReviewSection>
          )}
          {comparisons.length > 0 && (
            <ReviewSection title="Compare attempts">
              {comparisons.map((review) => (
                <ReviewRow
                  key={review.id}
                  href={`${basePath}/comparisons/${review.id}`}
                  icon={EyeOff}
                  name={review.name}
                  detail={`${review.caseCount} pairs · ${review.judgments} judgments · ${review.status}`}
                />
              ))}
            </ReviewSection>
          )}
        </div>
      )}
    </div>
  );
}

function ReviewSection({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return <section className="space-y-3"><h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>{children}</section>;
}

function ReviewRow({ href, icon: Icon, name, detail }: { readonly href: string; readonly icon: typeof EyeOff; readonly name: string; readonly detail: string }) {
  return <Link to={href} className="flex items-center justify-between rounded-lg border px-4 py-3 transition-colors hover:bg-muted/50"><div className="flex min-w-0 flex-1 items-center gap-3"><Icon className="h-4 w-4 shrink-0 text-primary" /><div className="min-w-0"><p className="truncate text-sm font-medium">{name}</p><p className="text-xs text-muted-foreground">{detail}</p></div></div><ArrowRight className="h-4 w-4 text-muted-foreground" /></Link>;
}
