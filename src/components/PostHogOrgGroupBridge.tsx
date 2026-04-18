import { useEffect } from "react";
import { useOrg } from "@/contexts/OrgContext";
import { posthog } from "@/lib/posthog";

export function PostHogOrgGroupBridge() {
  const { org } = useOrg();

  useEffect(() => {
    posthog.group("organization", org._id as string, {
      slug: org.slug,
      name: org.name,
    });
  }, [org._id, org.slug, org.name]);

  return null;
}
