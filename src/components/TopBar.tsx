import { Link } from "react-router-dom";
import { OrgSwitcher } from "@/components/OrgSwitcher";
import { UserMenu } from "@/components/UserMenu";
import { HelpMenu } from "@/components/HelpMenu";
import { NotificationBell } from "@/components/NotificationBell";
import { MobileNavDrawer } from "@/components/MobileNavDrawer";
import { OnboardingProgressChip } from "@/components/OnboardingProgressChip";
import { toggleCommandPalette } from "@/lib/commandPaletteState";
import { toggleCheatSheet } from "@/lib/shortcutCheatSheetState";
import { LayoutDashboard, Search } from "lucide-react";

interface TopBarProps {
  variant?: "default" | "evaluator";
}

export function TopBar({ variant = "default" }: TopBarProps) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b px-4">
      <div className="flex items-center gap-2">
        {variant === "default" ? (
          <>
            <MobileNavDrawer />
            <OrgSwitcher />
          </>
        ) : (
          <Link
            to="/eval"
            className="text-sm font-semibold hover:text-primary transition-colors"
          >
            Blind Bench &mdash; Evaluation
          </Link>
        )}
      </div>
      <div className="flex items-center gap-2">
        {variant === "default" && (
          <>
            {/* Mobile: 44×44 icon button */}
            <button
              onClick={() => toggleCommandPalette()}
              aria-label="Open command palette"
              className="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:hidden"
              title="Command palette"
            >
              <Search className="h-5 w-5" />
            </button>
            {/* Desktop: labeled button with ⌘K hint */}
            <button
              onClick={() => toggleCommandPalette()}
              className="hidden sm:flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              title="Command palette"
            >
              <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">
                ⌘K
              </kbd>
              <span>Search</span>
            </button>
            <button
              onClick={() => toggleCheatSheet()}
              className="hidden sm:flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              title="Keyboard shortcuts"
            >
              <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">
                ?
              </kbd>
              <span>Shortcuts</span>
            </button>
            <OnboardingProgressChip />
            <HelpMenu />
          </>
        )}
        {variant === "evaluator" && (
          <>
            <Link
              to="/"
              className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              <LayoutDashboard className="h-3.5 w-3.5" />
              Dashboard
            </Link>
            <NotificationBell />
          </>
        )}
        <UserMenu />
      </div>
    </header>
  );
}
