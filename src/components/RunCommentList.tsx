import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { MessageSquare } from "lucide-react";

interface RunCommentListProps {
  runId: Id<"promptRuns">;
}

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

export function RunCommentList({ runId }: RunCommentListProps) {
  const comments = useQuery(api.runComments.listForRun, { runId });

  if (!comments || comments.length === 0) return null;

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center gap-1.5 px-3 py-2 border-b">
        <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-sm font-medium text-muted-foreground">
          General comments ({comments.length})
        </span>
      </div>
      <div className="divide-y">
        {comments.map((c) => (
          <div key={c._id} className="flex gap-2 px-3 py-2.5">
            <Avatar className="h-6 w-6 shrink-0">
              <AvatarFallback className="text-[10px]">
                {c.authorName?.[0]?.toUpperCase() ?? "?"}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium truncate">
                  {c.authorName ?? "Anonymous"}
                </span>
                <span className="text-xs text-muted-foreground">
                  {formatRelativeTime(c.createdAt)}
                </span>
              </div>
              <p className="text-sm text-foreground mt-0.5 whitespace-pre-wrap">
                {c.comment}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
