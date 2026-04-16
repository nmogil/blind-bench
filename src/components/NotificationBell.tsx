import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Bell } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";

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

export function NotificationBell() {
  const unreadCount = useQuery(api.evaluatorNotifications.countUnread);
  const notifications = useQuery(api.evaluatorNotifications.listMyNotifications);
  const markRead = useMutation(api.evaluatorNotifications.markRead);
  const markAllRead = useMutation(api.evaluatorNotifications.markAllRead);

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const count = unreadCount ?? 0;

  return (
    <div className="relative" ref={ref}>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen(!open)}
        aria-label={`Notifications${count > 0 ? ` (${count} unread)` : ""}`}
        className="h-11 w-11 sm:h-9 sm:w-9"
      >
        <Bell className="h-5 w-5 sm:h-4 sm:w-4" />
        {count > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium text-destructive-foreground">
            {count > 9 ? "9+" : count}
          </span>
        )}
      </Button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-72 rounded-lg border bg-popover shadow-lg">
          <div className="flex items-center justify-between px-3 py-2 border-b">
            <span className="text-sm font-medium">Notifications</span>
            {count > 0 && (
              <button
                className="text-xs text-primary hover:underline"
                onClick={() => markAllRead({})}
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-64 overflow-y-auto">
            {!notifications || notifications.length === 0 ? (
              <div className="px-3 py-4 text-center">
                <p className="text-xs text-muted-foreground">
                  No notifications yet
                </p>
              </div>
            ) : (
              notifications.map((n) => (
                <button
                  key={n._id}
                  className={cn(
                    "w-full text-left px-3 py-2 hover:bg-muted/50 border-b last:border-b-0",
                    !n.read && "bg-primary/5",
                  )}
                  onClick={() => {
                    if (!n.read) {
                      markRead({ notificationId: n._id as Id<"evaluatorNotifications"> });
                    }
                  }}
                >
                  <div className="flex items-start gap-2">
                    {!n.read && (
                      <span className="mt-1.5 h-2 w-2 rounded-full bg-primary shrink-0" />
                    )}
                    <div className={cn("min-w-0 flex-1", n.read && "ml-4")}>
                      <p className="text-xs text-foreground">{n.message}</p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        {n.projectName && (
                          <span className="text-[10px] text-muted-foreground truncate">
                            {n.projectName}
                          </span>
                        )}
                        <span className="text-[10px] text-muted-foreground">
                          {formatRelativeTime(n.createdAt)}
                        </span>
                      </div>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
