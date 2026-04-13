import { OrgSwitcher } from "@/components/OrgSwitcher";
import { UserMenu } from "@/components/UserMenu";
import { HelpMenu } from "@/components/HelpMenu";
import { toggleCommandPalette } from "@/lib/commandPaletteState";
import { toggleCheatSheet } from "@/lib/shortcutCheatSheetState";

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
        {variant === "default" && (
          <>
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
            <HelpMenu />
          </>
        )}
        <UserMenu />
      </div>
    </header>
  );
}
