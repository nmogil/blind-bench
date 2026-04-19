import { useQuery } from "convex/react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../../../convex/_generated/api";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ClipboardCheck, FolderOpen, Inbox, Users } from "lucide-react";

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function iconForScope(scope: "org" | "project" | "cycle") {
  if (scope === "org") return Users;
  if (scope === "project") return FolderOpen;
  return ClipboardCheck;
}

function labelForScope(scope: "org" | "project" | "cycle"): string {
  if (scope === "org") return "organization";
  if (scope === "project") return "prompt";
  return "review";
}

export function InvitesInbox() {
  const invites = useQuery(api.invitations.listMine);
  const navigate = useNavigate();

  if (invites === undefined) {
    return (
      <div className="p-6 space-y-3">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (invites.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <EmptyState
          icon={Inbox}
          heading="You're all caught up"
          description="Nothing waiting for you right now. Invitations from teammates will show up here."
          action={{
            label: "Back to dashboard",
            onClick: () => navigate("/"),
          }}
        />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <section className="space-y-3">
        <h1 className="text-lg font-medium">Invitations waiting for you</h1>
        <div className="space-y-2">
          {invites.map((inv) => {
            const Icon = iconForScope(inv.scope);
            return (
              <Link
                key={inv._id}
                to={`/invite/${inv.token}`}
                className="block rounded-lg border p-4 hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">
                        {inv.scopeName}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Invited {formatRelativeTime(inv.invitedAt)} ·{" "}
                        {labelForScope(inv.scope)}
                      </p>
                    </div>
                  </div>
                  <Badge variant="outline" className="text-[10px]">
                    Pending
                  </Badge>
                </div>
              </Link>
            );
          })}
        </div>
      </section>
    </div>
  );
}
