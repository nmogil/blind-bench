import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const statusStyles: Record<string, string> = {
  draft: "bg-yellow-100 text-yellow-800 border-yellow-300 dark:bg-yellow-900/30 dark:text-yellow-400 dark:border-yellow-700",
  active: "bg-green-100 text-green-800 border-green-300 dark:bg-green-900/30 dark:text-green-400 dark:border-green-700",
  archived: "bg-slate-100 text-slate-600 border-slate-300 dark:bg-slate-800/30 dark:text-slate-400 dark:border-slate-600",
};

export function VersionStatusPill({ status }: { status: string }) {
  return (
    <Badge
      variant="outline"
      className={cn("text-xs font-medium capitalize", statusStyles[status])}
    >
      {status}
    </Badge>
  );
}
