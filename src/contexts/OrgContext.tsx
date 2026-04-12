import { createContext, useContext } from "react";
import { Doc, Id } from "../../convex/_generated/dataModel";

interface OrgContextValue {
  org: Doc<"organizations">;
  orgId: Id<"organizations">;
  role: Doc<"organizationMembers">["role"];
}

const OrgContext = createContext<OrgContextValue | null>(null);

export function OrgProvider({
  children,
  value,
}: {
  children: React.ReactNode;
  value: OrgContextValue;
}) {
  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}

export function useOrg(): OrgContextValue {
  const ctx = useContext(OrgContext);
  if (!ctx) {
    throw new Error("useOrg must be used within an OrgProvider");
  }
  return ctx;
}
