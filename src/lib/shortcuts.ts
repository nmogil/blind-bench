export interface ShortcutDef {
  key: string;
  label: string;
  description: string;
  contexts: string[];
}

export const SHORTCUTS: ShortcutDef[] = [
  // Global
  { key: "⌘K", label: "⌘K", description: "Open command palette", contexts: ["global"] },
  { key: "?", label: "?", description: "Show shortcut cheat sheet", contexts: ["global"] },
  { key: "Esc", label: "Esc", description: "Close modal or popover", contexts: ["global"] },

  // Version editor
  { key: "⌘Enter", label: "⌘Enter", description: "Run prompt", contexts: ["version-editor"] },
  { key: "⌘S", label: "⌘S", description: "Save draft", contexts: ["version-editor"] },
  { key: "⌘R", label: "⌘R", description: "Request optimization", contexts: ["version-editor"] },

  // Annotatable views
  { key: "C", label: "C", description: "Comment on selection", contexts: ["run-view", "eval", "compare"] },
  { key: "J / K", label: "J / K", description: "Next / previous output", contexts: ["run-view", "eval", "compare"] },

  // List views
  { key: "N", label: "N", description: "New item", contexts: ["org-home", "versions", "test-cases", "variables"] },
  { key: "↑ / ↓", label: "↑ / ↓", description: "Navigate items", contexts: ["org-home", "versions", "test-cases"] },
  { key: "Enter", label: "Enter", description: "Open focused item", contexts: ["org-home", "versions", "test-cases"] },

  // Go-to sequences
  { key: "G then P", label: "G P", description: "Go to projects", contexts: ["project"] },
  { key: "G then R", label: "G R", description: "Go to runs", contexts: ["project"] },
  { key: "G then T", label: "G T", description: "Go to test cases", contexts: ["project"] },
  { key: "G then V", label: "G V", description: "Go to versions", contexts: ["project"] },
];

export function getShortcutsForContext(context: string): ShortcutDef[] {
  return SHORTCUTS.filter(
    (s) => s.contexts.includes(context) || s.contexts.includes("global"),
  );
}

export function getGroupedShortcuts(context: string) {
  const shortcuts = getShortcutsForContext(context);
  const groups: Record<string, ShortcutDef[]> = {};

  for (const s of shortcuts) {
    const group = s.contexts.includes("global")
      ? "Global"
      : s.contexts.includes("version-editor")
        ? "Version Editor"
        : s.contexts.some((c) => ["run-view", "eval", "compare"].includes(c))
          ? "Output View"
          : s.contexts.some((c) => c.startsWith("org-") || ["versions", "test-cases", "variables"].includes(c))
            ? "Lists"
            : "Navigation";
    if (!groups[group]) groups[group] = [];
    groups[group].push(s);
  }

  return groups;
}
