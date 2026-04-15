import { useState } from "react";
import { useQuery } from "convex/react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../../../convex/_generated/api";
import { useProject } from "@/contexts/ProjectContext";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  Clock,
  FileText,
  Layers,
  Lock,
  Play,
  Sparkles,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

const EVENT_LIMIT = 50;

export function HistoryPage() {
  const { projectId } = useProject();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const [limit, setLimit] = useState(EVENT_LIMIT);

  const events = useQuery(api.activity.listActivity, {
    projectId,
    limit: limit + 1, // Fetch one extra to know if there's more
  });

  const basePath = `/orgs/${orgSlug}/projects/${projectId}`;

  if (events === undefined) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-32" />
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => (
            <Skeleton key={i} className="h-14 w-full max-w-2xl" />
          ))}
        </div>
      </div>
    );
  }

  const hasMore = events.length > limit;
  const displayEvents = events.slice(0, limit);

  // Group events by date
  const grouped = new Map<string, typeof displayEvents>();
  for (const event of displayEvents) {
    const dateKey = formatDateGroup(event.timestamp);
    const group = grouped.get(dateKey) ?? [];
    group.push(event);
    grouped.set(dateKey, group);
  }

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-xl font-semibold">History</h1>

      {displayEvents.length === 0 ? (
        <EmptyState
          icon={Clock}
          heading="No activity yet"
          description="Runs, version changes, review cycles, and optimizations will appear here as they happen."
        />
      ) : (
        <div className="max-w-2xl space-y-6">
          {[...grouped.entries()].map(([dateLabel, groupEvents]) => (
            <section key={dateLabel}>
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                {dateLabel}
              </h2>
              <div className="space-y-1">
                {groupEvents.map((event, i) => (
                  <EventRow
                    key={`${event.type}-${event.timestamp}-${i}`}
                    event={event}
                    basePath={basePath}
                  />
                ))}
              </div>
            </section>
          ))}

          {hasMore && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setLimit((prev) => prev + EVENT_LIMIT)}
              className="w-full"
            >
              Load more
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

const EVENT_ICONS: Record<string, typeof Play> = {
  run_completed: Play,
  run_failed: XCircle,
  version_created: FileText,
  cycle_opened: Layers,
  cycle_closed: Lock,
  optimization_completed: Sparkles,
};

const EVENT_COLORS: Record<string, string> = {
  run_completed: "text-green-600 dark:text-green-400",
  run_failed: "text-destructive",
  version_created: "text-blue-600 dark:text-blue-400",
  cycle_opened: "text-primary",
  cycle_closed: "text-muted-foreground",
  optimization_completed: "text-purple-600 dark:text-purple-400",
};

function EventRow({
  event,
  basePath,
}: {
  event: {
    type: string;
    timestamp: number;
    description: string;
    metadata: Record<string, string | number | null>;
  };
  basePath: string;
}) {
  const Icon = EVENT_ICONS[event.type] ?? Clock;
  const colorClass = EVENT_COLORS[event.type] ?? "text-muted-foreground";

  // Build a link based on event type
  let href: string | null = null;
  if (
    (event.type === "run_completed" || event.type === "run_failed") &&
    event.metadata.runId
  ) {
    href = `${basePath}/runs/${event.metadata.runId}`;
  } else if (event.type === "version_created" && event.metadata.versionId) {
    href = `${basePath}/versions/${event.metadata.versionId}`;
  } else if (
    (event.type === "cycle_opened" || event.type === "cycle_closed") &&
    event.metadata.cycleId
  ) {
    href = `${basePath}/cycles/${event.metadata.cycleId}`;
  } else if (
    event.type === "optimization_completed" &&
    event.metadata.requestId
  ) {
    href = `${basePath}/optimizations/${event.metadata.requestId}`;
  }

  const content = (
    <div
      className={cn(
        "flex items-center gap-3 rounded-md px-3 py-2 transition-colors",
        href && "hover:bg-muted/50 cursor-pointer",
      )}
    >
      <Icon className={cn("h-4 w-4 shrink-0", colorClass)} />
      <div className="flex-1 min-w-0">
        <p className="text-sm truncate">{event.description}</p>
        <p className="text-xs text-muted-foreground">
          {formatTime(event.timestamp)}
        </p>
      </div>
    </div>
  );

  return href ? <Link to={href}>{content}</Link> : content;
}

function formatDateGroup(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  const diffDays = Math.floor(
    (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24),
  );

  if (diffDays === 0 && date.getDate() === now.getDate()) return "Today";
  if (diffDays <= 1 && date.getDate() === now.getDate() - 1)
    return "Yesterday";

  return date.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}
