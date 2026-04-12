import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const roleStyles: Record<string, string> = {
  owner: "bg-purple-100 text-purple-800 border-purple-200",
  admin: "bg-blue-100 text-blue-800 border-blue-200",
  member: "bg-slate-100 text-slate-700 border-slate-200",
  editor: "bg-blue-100 text-blue-800 border-blue-200",
  evaluator: "bg-amber-100 text-amber-800 border-amber-200",
};

export function RoleBadge({ role }: { role: string }) {
  return (
    <Badge
      variant="outline"
      className={cn("text-xs capitalize", roleStyles[role])}
    >
      {role}
    </Badge>
  );
}
