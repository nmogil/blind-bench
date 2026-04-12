import { useQuery } from "convex/react";
import { Navigate } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import { Skeleton } from "@/components/ui/skeleton";

export function RootRedirect() {
  const orgs = useQuery(api.organizations.listMyOrgs);

  if (orgs === undefined) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Skeleton className="h-8 w-48" />
      </div>
    );
  }

  if (orgs.length === 0) {
    return <Navigate to="/onboarding" replace />;
  }

  const first = orgs[0];
  if (!first) {
    return <Navigate to="/onboarding" replace />;
  }
  return <Navigate to={`/orgs/${first.org.slug}`} replace />;
}
