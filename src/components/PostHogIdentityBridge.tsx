import { useEffect, useRef } from "react";
import { useQuery, useConvexAuth } from "convex/react";
import { api } from "../../convex/_generated/api";
import { posthog } from "@/lib/posthog";

export function PostHogIdentityBridge() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const viewer = useQuery(api.users.viewer, isAuthenticated ? {} : "skip");
  const identifiedId = useRef<string | null>(null);

  useEffect(() => {
    if (isLoading) return;

    if (!isAuthenticated) {
      if (identifiedId.current !== null) {
        posthog.reset();
        identifiedId.current = null;
      }
      return;
    }

    if (viewer && identifiedId.current !== viewer._id) {
      posthog.identify(viewer._id as string, {
        email: viewer.email,
        name: viewer.name,
      });
      identifiedId.current = viewer._id as string;
    }
  }, [isAuthenticated, isLoading, viewer]);

  return null;
}
