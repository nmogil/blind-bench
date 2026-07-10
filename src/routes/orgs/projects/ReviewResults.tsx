import { Link, useNavigate, useParams } from "react-router-dom";
import { useProject } from "@/contexts/ProjectContext";
import { EmptyState } from "@/components/EmptyState";
import { BarChart3 } from "lucide-react";

/** Owner-facing entry point for completed and collecting human-review results. */
export function ReviewResults() {
  const { projectId } = useProject();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const navigate = useNavigate();
  const reviewsHref = `/orgs/${orgSlug}/projects/${projectId}/evaluate`;

  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold">Results</h1>
      <div className="mt-6">
        <EmptyState
          icon={BarChart3}
          heading="Results appear after people review your runs"
          description="Create a blind review, share the link, and come back here to see verdicts, agreement, and comments."
          action={{ label: "Open reviews", onClick: () => navigate(reviewsHref) }}
        />
        <p className="mt-4 text-center text-xs text-muted-foreground">
          Or <Link className="text-primary hover:underline" to={reviewsHref}>view reviews in progress</Link>.
        </p>
      </div>
    </div>
  );
}
