import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Navigate } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import { Skeleton } from "@/components/ui/skeleton";

export function RootRedirect() {
  const orgs = useQuery(api.organizations.listMyOrgs);
  const sampleInfo = useQuery(api.sampleSeed.getMySampleProject);
  const ensureFirstRunSeed = useMutation(api.sampleSeed.ensureFirstRunSeed);
  const seededRef = useRef(false);
  const [seedError, setSeedError] = useState(false);
  const [seededSlug, setSeededSlug] = useState<string | null>(null);

  useEffect(() => {
    if (orgs === undefined) return;
    if (orgs.length > 0) return;
    if (seededRef.current) return;
    seededRef.current = true;
    ensureFirstRunSeed({})
      .then((res) => {
        if (res.orgSlug) setSeededSlug(res.orgSlug);
        else setSeedError(true);
      })
      .catch(() => setSeedError(true));
  }, [orgs, ensureFirstRunSeed]);

  if (orgs === undefined || sampleInfo === undefined) {
    return <Loading />;
  }

  if (orgs.length === 0) {
    if (seedError) return <Navigate to="/onboarding" replace />;
    if (!seededSlug) return <Loading />;
    // Wait for the reactive sampleInfo query to catch up with the seeded data
    // so we can route into the seeded version editor.
    const target = firstRunTarget(sampleInfo.sample, seededSlug);
    if (!target) return <Loading />;
    return <Navigate to={target} replace />;
  }

  const first = orgs[0];
  if (!first) return <Navigate to="/onboarding" replace />;

  // M28.6: tour-modal removal — first-run routing now relies solely on
  // "user has not yet created a real project," not the legacy tourStatus flag.
  const isFirstRun = !sampleInfo.hasNonSampleProject;

  if (isFirstRun && sampleInfo.sample?.orgSlug) {
    const target = firstRunTarget(sampleInfo.sample, sampleInfo.sample.orgSlug);
    if (target) return <Navigate to={target} replace />;
  }

  return <Navigate to={`/orgs/${first.org.slug}`} replace />;
}

function firstRunTarget(
  sample: { projectId: string; versionId: string | null } | null,
  orgSlug: string | null,
): string | null {
  if (!sample || !sample.versionId || !orgSlug) return null;
  return `/orgs/${orgSlug}/projects/${sample.projectId}/versions/${sample.versionId}`;
}

function Loading() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Skeleton className="h-8 w-48" />
    </div>
  );
}
