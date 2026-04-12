import { OrgSwitcher } from "@/components/OrgSwitcher";
import { UserMenu } from "@/components/UserMenu";

interface TopBarProps {
  variant?: "default" | "evaluator";
}

export function TopBar({ variant = "default" }: TopBarProps) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b px-4">
      <div className="flex items-center gap-2">
        {variant === "default" ? (
          <OrgSwitcher />
        ) : (
          <span className="text-sm font-semibold">
            Hot or Prompt &mdash; Evaluation
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <UserMenu />
      </div>
    </header>
  );
}
